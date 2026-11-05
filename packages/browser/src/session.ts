// One agent's browser session: an isolated context with one page. Every action goes through
// perform(), which enforces the browser's own guards (the agent cannot talk its way past them).
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "puppeteer-core";
import { DeviceError, sleep } from "@agentphone/shared";
import { Mutex } from "@agentphone/device-core";
import { RunRecorder } from "@agentphone/agent-runtime";
import type { Engine } from "./engine.ts";
import { redactSecrets } from "./leak.ts";
import { assertAllowedUrl, isLocalHost, type GuardOptions } from "./net-guard.ts";
import { pageAgent } from "./page-scripts.ts";
import { SENSITIVE_ACTION } from "./risk.ts";
import { fill, type Params } from "./templating.ts";
import type { Op, SecretKind, Snapshot, Step, Target } from "./types.ts";
import type { Vault } from "./vault.ts";

export const BROWSER_DEVICE_ID = "browser-001";
const BOT_WALL = /captcha|verify you are (a )?human|prove your humanity|are you a robot|unusual traffic|request blocked|access denied|just a moment\.\.\.|enable javascript and cookies to continue/i;
const MAX_ELEMENTS = 300;

export interface SessionDeps {
  engine: Engine;
  vault: Vault;
  guard: GuardOptions;
  shotsDir: string;
  runsDir?: string;
}

/** Page path without per-session junk (e.g. ";jsessionid=…"), so recipes match across visits. */
export function pathOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/;jsessionid=[^/]*/i, "");
  } catch {
    return "";
  }
}

const PARAM = /\{[a-z][a-z0-9_]*(\|slug)?\}/i;

/**
 * How replay finds a step's element. If the user's value is in the element's label but not in its
 * id (e.g. a product link "{product}" with data-test="item-4-title-link"), the id would always pick
 * the recorded item: find it by its filled-in label text instead.
 */
export function locator(step: Step, params: Params): { tag: string; attr: string; key: string } {
  const t = step.target;
  if (t.attr !== "text" && PARAM.test(t.label) && !PARAM.test(t.key)) return { tag: t.tag, attr: "text", key: fill(t.label, params) };
  return { tag: t.tag, attr: t.attr, key: fill(t.key, params) };
}

export interface PerformOptions {
  /** Act on the element with this data-agent-id from the latest snapshot (live actions). */
  agentId?: string;
  /** Set during recipe replay: secrets and links are bound to the recipe's site. */
  recipeOrigin?: string;
}

export class BrowserSession {
  readonly id = `bs_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  readonly principalId: string;
  readonly holder: string;
  task?: string;
  readonly recorder: RunRecorder;
  readonly queue = new Mutex();
  /** Steps the agent performed since the last browser_open: becomes a recipe on save. */
  trace: Step[] = [];
  startUrl?: string;
  /** Set when an action happened off the start site: such a trace can't become a recipe. */
  traceLeftSite = false;
  /** Secret values filled in this session, redacted from everything that leaves it. */
  readonly secrets = new Set<string>();
  lastUsed = Date.now();
  /** A recipe replay paused for an approval or a repair (owned by the replay module). */
  run?: unknown;
  // Approval-gate bookkeeping (shared with the phone tools' gate()).
  step = 0;
  grants: import("@agentphone/agent-runtime").ApprovalGrant[] = [];
  screenshotPath?: string;
  private gen = 0;
  private shots = 0;
  private readonly deps: SessionDeps;
  private readonly ctx: BrowserContext;
  readonly page: Page;

  private constructor(deps: SessionDeps, ctx: BrowserContext, page: Page, principalId: string, holder: string, task?: string) {
    this.deps = deps;
    this.ctx = ctx;
    this.page = page;
    this.principalId = principalId;
    this.holder = holder;
    this.task = task;
    this.recorder = new RunRecorder(BROWSER_DEVICE_ID, deps.runsDir);
  }

  static async create(deps: SessionDeps, who: { principalId: string; holder: string; task?: string }): Promise<BrowserSession> {
    const ctx = await deps.engine.newContext();
    try {
      const page = await ctx.newPage();
      page.setDefaultNavigationTimeout(30_000);
      // Subresources and redirects must not reach this Mac or the home network either.
      if (!deps.guard.allowPrivate && deps.engine.kind === "chrome") {
        await page.setRequestInterception(true);
        page.on("request", (r) => {
          try {
            const u = new URL(r.url());
            if ((u.protocol === "http:" || u.protocol === "https:") && isLocalHost(u.hostname)) return void r.abort("blockedbyclient");
            if (!["http:", "https:", "data:", "blob:", "about:"].includes(u.protocol)) return void r.abort("blockedbyclient");
          } catch {
            return void r.abort("blockedbyclient");
          }
          void r.continue();
        });
      }
      const s = new BrowserSession(deps, ctx, page, who.principalId, who.holder, who.task);
      s.recorder.writeGoal({ device: BROWSER_DEVICE_ID, session: s.id, holder: who.holder, task: who.task });
      s.recorder.event({ kind: "browser_session", session: s.id, holder: who.holder, task: who.task, engine: deps.engine.kind });
      return s;
    } catch (e) {
      await deps.engine.closeContext(ctx);
      throw e;
    }
  }

  url(): string {
    return this.page.url();
  }
  path(): string {
    return pathOf(this.page.url());
  }
  origin(): string {
    try {
      return new URL(this.page.url()).origin;
    } catch {
      return "";
    }
  }

  private async eval<T>(cmd: string, arg?: unknown): Promise<T> {
    const run = () => this.page.evaluate(pageAgent as (c: string, a: unknown) => T, cmd, arg) as Promise<T>;
    try {
      return await run();
    } catch (e) {
      // The page navigated while we were reading it (redirects, bot-check pages swapping in):
      // wait for the new page to load and read once more.
      if (!/context was destroyed|navigat|detached/i.test((e as Error).message)) throw e;
      await this.waitLoaded(10_000);
      return run();
    }
  }

  private async waitLoaded(timeoutMs: number) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if ((await this.page.evaluate(() => document.readyState).catch(() => "loading")) === "complete") return;
      await sleep(50);
    }
  }

  /** Anything leaving the session goes through this. */
  redact(text: string): string {
    return redactSecrets(text, this.secrets);
  }

  /** Navigate. Starts a new recording (trace) from this page. */
  async goto(url: string): Promise<void> {
    const u = await assertAllowedUrl(url, this.deps.guard);
    let status: number | undefined;
    try {
      status = (await this.page.goto(u.href, { waitUntil: "load" }))?.status();
    } catch (e) {
      throw new DeviceError("navigation_failed", `Could not open ${u.href}: ${(e as Error).message.split("\n")[0]}`);
    }
    // Some sites first serve a short "checking your browser" page (often HTTP 202) and swap in the
    // real page a moment later: wait for real content instead of showing the agent an empty page.
    const t0 = Date.now();
    // Let script redirects and bot-check pages finish: wait until the network is quiet briefly.
    if (this.deps.engine.kind === "chrome") {
      await this.page.waitForNetworkIdle({ idleTime: 300, timeout: 3000 }).catch(() => undefined);
      await this.waitLoaded(10_000);
    }
    if (status === 202) {
      // A holding page: wait until it navigates away or its content is replaced.
      const first = await this.eval<string>("sig").catch(() => "");
      while (Date.now() - t0 < 10_000) {
        await sleep(200);
        const now = await this.eval<string>("sig").catch(() => "");
        if (now && now !== first) break;
        // Some sites answer 202 with the real page right away: stop once it clearly has content.
        if (Date.now() - t0 > 1000 && (await this.eval<string>("bodyText").catch(() => "")).length > 300) break;
      }
      await this.waitLoaded(10_000);
      await sleep(300); // let the real page finish rendering
    }
    while (Date.now() - t0 < 10_000 && !(await this.eval<string>("bodyText").catch(() => ""))) await sleep(150);
    this.trace = [];
    this.traceLeftSite = false;
    this.startUrl = u.href;
    this.lastUsed = Date.now();
    this.recorder.event({ kind: "browser_open", url: u.href });
  }

  async snapshot(): Promise<Snapshot> {
    this.gen++;
    const r = await this.eval<{ text: string; title: string; url: string }>("snapshot", { gen: this.gen, actionRe: SENSITIVE_ACTION.source, max: MAX_ELEMENTS });
    return { gen: this.gen, url: this.redact(r.url), path: this.path(), title: this.redact(r.title), text: this.redact(r.text) };
  }

  /** The element behind an index of the latest snapshot. */
  async target(index: number): Promise<{ agentId: string; target: Target }> {
    const agentId = `g${this.gen}-${index}`;
    const d = await this.eval<Target | null>("describe", { id: agentId, actionRe: SENSITIVE_ACTION.source });
    if (!d) {
      throw new DeviceError("stale_snapshot", `No element [${index}] in the current page snapshot.`, "Call browser_snapshot and use an index from it.");
    }
    return { agentId, target: d };
  }

  /** Build the step for a live action on an indexed element (what gets recorded). */
  async stepFor(op: Op, index: number, extra: { text?: string; secret?: SecretKind } = {}): Promise<{ step: Step; agentId: string }> {
    const { agentId, target } = await this.target(index);
    const step: Step = { op, path: this.path(), target };
    if (extra.text !== undefined) step.text = extra.text;
    if (op === "fill_secret") step.secret = extra.secret;
    return { step, agentId };
  }

  /** Add a performed step to the recording (only steps on the start site count). */
  recordStep(step: Step, pageOriginBefore: string) {
    if (!this.startUrl) return;
    if (pageOriginBefore !== new URL(this.startUrl).origin) this.traceLeftSite = true;
    else this.trace.push(step);
  }

  /** Locate the step's element and mark it as the target. */
  async locate(step: Step, params: Params, agentId?: string): Promise<boolean> {
    const loc = agentId ? { tag: step.target.tag, attr: "data-agent-id", key: agentId } : locator(step, params);
    return this.eval<boolean>("find", loc).catch(() => false);
  }

  /** Run one step with the browser's guards. Throws DeviceError when a guard refuses. */
  async perform(step: Step, params: Params, opts: PerformOptions = {}): Promise<void> {
    this.lastUsed = Date.now();
    if (!(await this.locate(step, params, opts.agentId))) {
      throw new DeviceError("element_not_found", `Element not found: ${step.target.tag} [${step.target.attr}=${fill(step.target.key, params)}]`, "Call browser_snapshot and pick an element from it.");
    }
    const t0 = Date.now();
    const pageOrigin = this.origin();
    switch (step.op) {
      case "type":
      case "select": {
        const secret = await this.eval<string | null>("targetSecret");
        if (secret) throw new DeviceError("sensitive_field", `That is a ${secret} field. Typing into it is refused.`, `Use browser_fill_secret with secret "${secret}"; the browser fills it from the owner's vault.`);
        await this.eval("setValue", { value: fill(step.text ?? "", params) });
        break;
      }
      case "fill_secret": {
        const kind = step.secret;
        const live = await this.eval<string | null>("targetSecret");
        if (!kind || live !== kind) {
          throw new DeviceError("secret_field_mismatch", `Refused: this field is ${live ? `a "${live}" field` : "not a secret field"}, not a "${kind}" field.`, "Secrets only go into the field the browser recognises as that kind (e.g. a password box).");
        }
        if (opts.recipeOrigin && pageOrigin !== opts.recipeOrigin) {
          throw new DeviceError("secret_wrong_site", `Refused: the page is on ${pageOrigin}, but this recipe's secrets belong to ${opts.recipeOrigin}.`);
        }
        const value = this.deps.vault.get(pageOrigin, kind); // origin-bound: only this exact site's item
        this.secrets.add(value);
        await this.eval("setValue", { value });
        break;
      }
      case "click": {
        const dest = await this.eval<string | null>("linkDest");
        if (dest && dest !== pageOrigin) {
          if (opts.recipeOrigin) throw new DeviceError("off_site_link", `Refused: this link leads off the recipe's site, to ${dest}.`);
          if (!this.deps.guard.allowPrivate && isLocalHost(new URL(dest).hostname)) throw new DeviceError("blocked_url", `Refused: this link leads to a local address (${dest}).`);
        }
        const before = await this.eval<string>("sig").catch(() => "");
        await this.eval("click");
        await this.settle(before);
        break;
      }
      default:
        throw new DeviceError("unknown_step", `Refused unknown step type "${(step as Step).op}".`);
    }
    this.recorder.event({
      kind: "browser_action",
      op: step.op,
      path: step.path,
      target: `${step.target.attr}=${step.target.key}`,
      ...(step.text !== undefined ? { text: `<${fill(step.text, params).length} chars>` } : {}),
      ...(step.secret ? { secret: step.secret } : {}),
      ms: Date.now() - t0,
    });
  }

  /** After a click: wait for the page to change (SPA update or navigation), then to finish loading. */
  private async settle(before: string) {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const now = await this.eval<string>("sig").catch(() => "");
      if (now && now !== before) break;
      await sleep(10);
    }
    while (Date.now() - t0 < 15_000) {
      const state = await this.page.evaluate(() => document.readyState).catch(() => "loading");
      if (state === "complete") return;
      await sleep(20);
    }
  }

  /** A "prove you're human" wall (captcha / bot check) instead of the site. */
  async botWall(): Promise<boolean> {
    const text = `${await this.page.title().catch(() => "")} ${(await this.bodyText()).slice(0, 3000)}`;
    return BOT_WALL.test(text);
  }

  /** True once the document has finished loading. */
  async loaded(): Promise<boolean> {
    return (await this.page.evaluate(() => document.readyState).catch(() => "loading")) === "complete";
  }

  /** Visible page text (redacted), for end checks. */
  async bodyText(): Promise<string> {
    return this.redact(await this.eval<string>("bodyText").catch(() => ""));
  }

  /** What the owner sees when approving a risky click: amounts, totals, filled-in (non-secret) fields. */
  async summary(label: string): Promise<string> {
    const s = await this.eval<{ money: string[]; fields: string[]; items: string[]; heading: string }>("summary").catch(() => ({ money: [], fields: [], items: [], heading: "" }));
    const parts = [`Button: "${label}"`];
    if (s.heading) parts.push(`Page: ${s.heading}`);
    if (s.money.length) parts.push(`Amounts: ${s.money.join(" | ")}`);
    if (s.items.length) parts.push(`Items: ${s.items.join(" | ")}`);
    if (s.fields.length) parts.push(`Form: ${s.fields.join(", ")}`);
    return this.redact(parts.join("\n")).slice(0, 1500);
  }

  /** PNG of the page for the owner's approval screen (Chrome only). */
  async shot(): Promise<string | undefined> {
    if (this.deps.engine.kind !== "chrome") return undefined;
    mkdirSync(this.deps.shotsDir, { recursive: true, mode: 0o700 });
    const path = join(this.deps.shotsDir, `${this.id}-${++this.shots}.png`) as `${string}.png`;
    try {
      await this.masked(() => this.page.screenshot({ path }));
      this.screenshotPath = path;
      return path;
    } catch {
      return undefined;
    }
  }

  /** JPEG of the visible page to share with the user (Chrome only). Login fields are blanked. */
  async jpeg(): Promise<Buffer | undefined> {
    if (this.deps.engine.kind !== "chrome") return undefined;
    try {
      return Buffer.from(await this.masked(() => this.page.screenshot({ type: "jpeg", quality: 70 })));
    } catch {
      return undefined;
    }
  }

  /** Run fn with every secret field (password and username boxes) hidden, so no picture shows one. */
  private async masked<T>(fn: () => Promise<T>): Promise<T> {
    await this.eval("maskSecrets", { show: false });
    try {
      return await fn();
    } finally {
      await this.eval("maskSecrets", { show: true }).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.recorder.event({ kind: "browser_close" });
    this.recorder.writeResult({ status: "closed", session: this.id, steps: this.trace.length });
    await this.deps.engine.closeContext(this.ctx);
    this.secrets.clear();
  }
}
