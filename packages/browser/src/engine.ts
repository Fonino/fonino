// The browser engine: headless Chrome by default (best site compatibility), Lightpanda as an
// optional fast/light mode. Started on first use, shut down after a while without sessions.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import puppeteer, { type Browser, type BrowserContext } from "puppeteer-core";
import { DeviceError, sleep } from "@agentphone/shared";

export type EngineKind = "chrome" | "lightpanda";

export interface EngineOptions {
  kind?: EngineKind;
  chromePath?: string;
  lightpandaPath?: string;
  /** Shut the engine down after this long with no open contexts. */
  idleMs?: number;
}

const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function engineKindFromEnv(): EngineKind {
  return process.env.AGENTPHONE_BROWSER_ENGINE === "lightpanda" ? "lightpanda" : "chrome";
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export class Engine {
  readonly kind: EngineKind;
  private readonly chromePath: string;
  private readonly lightpandaPath: string;
  private readonly idleMs: number;
  private browser?: Browser;
  private starting?: Promise<Browser>;
  private proc?: ChildProcess;
  private contexts = 0;
  private idleTimer?: NodeJS.Timeout;

  constructor(opts: EngineOptions = {}) {
    this.kind = opts.kind ?? engineKindFromEnv();
    this.chromePath = opts.chromePath ?? process.env.AGENTPHONE_CHROME ?? DEFAULT_CHROME;
    this.lightpandaPath = opts.lightpandaPath ?? process.env.AGENTPHONE_LIGHTPANDA ?? "lightpanda";
    this.idleMs = opts.idleMs ?? 10 * 60_000;
  }

  /** Lightpanda serves one browser context at a time. */
  get maxContexts(): number {
    return this.kind === "lightpanda" ? 1 : 4;
  }

  /** Problems that stop the engine from starting, for `agentphone doctor`. */
  check(): string | undefined {
    if (this.kind === "chrome" && !existsSync(this.chromePath)) return `Chrome not found at ${this.chromePath} (set AGENTPHONE_CHROME)`;
    return undefined;
  }

  private async start(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    this.starting ??= (async () => {
      try {
        if (this.kind === "chrome") {
          const problem = this.check();
          if (problem) throw new DeviceError("engine_missing", problem, "Install Google Chrome or set AGENTPHONE_CHROME to its binary.");
          this.browser = await puppeteer.launch({
            executablePath: this.chromePath,
            headless: true,
            args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--mute-audio"],
          });
        } else {
          const port = await freePort();
          this.proc = spawn(this.lightpandaPath, ["serve", "--host", "127.0.0.1", "--port", String(port)], {
            env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
            stdio: "ignore",
          });
          this.proc.once("error", () => undefined);
          for (let i = 0; i < 300 && !this.browser; i++) {
            try {
              this.browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${port}` });
            } catch {
              await sleep(20);
            }
          }
          if (!this.browser) throw new DeviceError("engine_missing", "Lightpanda did not start.", "Install Lightpanda or set AGENTPHONE_LIGHTPANDA; or use the default Chrome engine.");
        }
        this.browser.once("disconnected", () => {
          this.browser = undefined;
        });
        return this.browser;
      } finally {
        this.starting = undefined;
      }
    })();
    return this.starting;
  }

  /** A fresh, isolated context (no cookies or storage shared with other sessions). */
  async newContext(): Promise<BrowserContext> {
    if (this.contexts >= this.maxContexts) {
      throw new DeviceError("browser_busy", `The ${this.kind} engine already has ${this.contexts} open session(s).`, "Close a session with browser_close, or try again shortly.");
    }
    clearTimeout(this.idleTimer);
    const browser = await this.start();
    const ctx = await browser.createBrowserContext();
    this.contexts++;
    return ctx;
  }

  async closeContext(ctx: BrowserContext): Promise<void> {
    await ctx.close().catch(() => undefined);
    this.contexts = Math.max(0, this.contexts - 1);
    if (this.contexts === 0) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => void this.stop(), this.idleMs);
      this.idleTimer.unref();
    }
  }

  async stop(): Promise<void> {
    clearTimeout(this.idleTimer);
    const b = this.browser;
    this.browser = undefined;
    this.contexts = 0;
    if (b) {
      if (this.kind === "chrome") await b.close().catch(() => undefined);
      else await b.disconnect().catch(() => undefined);
    }
    this.proc?.kill();
    this.proc = undefined;
  }
}
