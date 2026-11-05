// Approval channel for remote agents (e.g. Grok Bot). A consequential request is written to
// ~/.agentphone/approvals/<id>.json; the agent gets a link to show its user and retries once the
// owner decides: in the Fonino account (app.fonino.app/approve/…), the Mac dashboard or the CLI
// (`fonino approve|deny <id>`). No MCP tool can approve anything, so a model never approves itself.

import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApprovalSpec } from "@agentphone/agent-runtime";
import { RULE_PER_DAY, appKey, ruleable, type Risk } from "@agentphone/shared";

export type ApprovalRecord = {
  id: string;
  deviceId: string;
  leaseId: string;
  holder: string;
  /** The assistant's key: its retry may come under a new lease (agents release while the owner decides). */
  principal?: string;
  risk: Risk;
  spec: ApprovalSpec;
  screenshotPath?: string;
  createdAt: string;
  status: "pending" | "approved" | "denied" | "expired";
  decidedAt?: string;
  /** The agent's retry has used this decision (an approval covers one action). */
  used?: boolean;
  /**
   * One-time code shown ONLY to the owner (Mac notification, `fonino approvals`, dashboard).
   * The owner can approve by telling it to their agent in chat; the agent never sees it otherwise.
   */
  code?: string;
  codeTries?: number;
  /** How the owner decided: link/dashboard/CLI, or the one-time code given in chat. */
  via?: "owner" | "code";
  /** "task": the owner allowed the rest of this task (same app/site, up to a cap, 30 min).
   * "always": also from now on, the same kind of action in the same app for this assistant (a standing rule). */
  scope?: "once" | "task" | "always";
};

export type Scope = NonNullable<ApprovalRecord["scope"]>;

/**
 * Standing rule: the owner chose "Always allow" for one kind of action (e.g. LinkedIn connection
 * requests) by one assistant, in one app, on any phone. Only for sending/posting, never for spending
 * money, deleting or signing in, and capped per day so a runaway agent can't spam from the account.
 */
export type ApprovalRule = {
  id: string;
  principal?: string;
  holder: string;
  app: string;
  risk: Risk;
  kind: string;
  perDay: number;
  createdAt: string;
  used?: { day: string; n: number };
};

export { RULE_PER_DAY, ruleable };

export const MAX_CODE_TRIES = 5;

export class ApprovalQueue {
  readonly dir: string;
  constructor(dir = join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "approvals")) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private file(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error(`bad approval id ${id}`);
    return join(this.dir, `${id}.json`);
  }

  get(id: string): ApprovalRecord | undefined {
    try {
      return JSON.parse(readFileSync(this.file(id), "utf8"));
    } catch {
      return undefined;
    }
  }

  list(status?: ApprovalRecord["status"]): ApprovalRecord[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.get(f.slice(0, -5)))
      .filter((r): r is ApprovalRecord => !!r && (!status || r.status === status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  create(r: Omit<ApprovalRecord, "id" | "createdAt" | "status">): ApprovalRecord {
    const rec: ApprovalRecord = { ...r, id: randomUUID(), createdAt: new Date().toISOString(), status: "pending", code: String(randomInt(0, 1_000_000)).padStart(6, "0"), codeTries: 0 };
    writeFileSync(this.file(rec.id), JSON.stringify(rec, null, 2));
    return rec;
  }

  /** Owner decision (CLI only). */
  decide(id: string, approve: boolean, scope: Scope = "once"): ApprovalRecord {
    const r = this.get(id);
    if (!r) throw new Error(`No approval request ${id}`);
    if (r.status !== "pending") throw new Error(`Request ${id} is already ${r.status}`);
    if (approve && scope === "always" && !ruleable(r.risk, r.spec)) throw new Error("This kind of action can't be always allowed.");
    r.status = approve ? "approved" : "denied";
    r.decidedAt = new Date().toISOString();
    r.via = "owner";
    if (approve) r.scope = scope;
    writeFileSync(this.file(id), JSON.stringify(r, null, 2));
    if (approve && scope === "always") this.addRule(r);
    return r;
  }

  // ---- Standing rules ("Always allow"), in approval-rules.json next to the requests ----

  private get rulesFile() {
    return join(this.dir, "..", "approval-rules.json");
  }

  rules(): ApprovalRule[] {
    try {
      return JSON.parse(readFileSync(this.rulesFile, "utf8"));
    } catch {
      return [];
    }
  }

  private saveRules(rules: ApprovalRule[]) {
    writeFileSync(this.rulesFile, JSON.stringify(rules, null, 2));
  }

  private addRule(r: ApprovalRecord): ApprovalRule | undefined {
    const k = ruleable(r.risk, r.spec);
    if (!k) return undefined;
    const rules = this.rules();
    const same = (x: ApprovalRule) => x.app === appKey(r.spec.app) && x.kind === k.kind && x.risk === r.risk && (x.principal ? x.principal === r.principal : x.holder === r.holder);
    const existing = rules.find(same);
    if (existing) return existing;
    const rule: ApprovalRule = { id: randomUUID(), principal: r.principal, holder: r.holder, app: appKey(r.spec.app), risk: r.risk, kind: k.kind, perDay: RULE_PER_DAY, createdAt: new Date().toISOString() };
    this.saveRules([...rules, rule]);
    return rule;
  }

  removeRule(id: string): boolean {
    const rules = this.rules();
    const left = rules.filter((x) => x.id !== id);
    if (left.length === rules.length) return false;
    this.saveRules(left);
    return true;
  }

  /**
   * A standing rule that covers this request, counting it against the day's cap. Undefined when no
   * rule matches; { capped } when one does but today's allowance is used up (then the owner decides).
   */
  useRule(who: { principal?: string; holder: string }, risk: Risk, spec: ApprovalSpec): { rule: ApprovalRule; capped?: boolean } | undefined {
    const k = ruleable(risk, spec);
    if (!k) return undefined;
    const rules = this.rules();
    const rule = rules.find((x) => x.app === appKey(spec.app) && x.kind === k.kind && x.risk === risk && (x.principal ? x.principal === who.principal : x.holder === who.holder));
    if (!rule) return undefined;
    const day = new Date().toISOString().slice(0, 10);
    const n = rule.used?.day === day ? rule.used.n : 0;
    if (n >= rule.perDay) return { rule, capped: true };
    rule.used = { day, n: n + 1 };
    this.saveRules(rules);
    return { rule };
  }

  /**
   * Approve with the owner's one-time code (relayed by their agent from the chat). Wrong codes are
   * counted; after MAX_CODE_TRIES the request is declined, so the code can't be guessed.
   */
  confirmCode(id: string, code: string): { status: ApprovalRecord["status"]; ok: boolean; triesLeft: number } {
    const r = this.get(id);
    if (!r) throw new Error(`No approval request ${id}`);
    if (r.status !== "pending" || !r.code) return { status: r.status, ok: false, triesLeft: 0 };
    const a = Buffer.from(code.trim());
    const b = Buffer.from(r.code);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      this.save({ ...r, status: "approved", decidedAt: new Date().toISOString(), via: "code" });
      return { status: "approved", ok: true, triesLeft: 0 };
    }
    const tries = (r.codeTries ?? 0) + 1;
    const locked = tries >= MAX_CODE_TRIES;
    this.save({ ...r, codeTries: tries, ...(locked ? { status: "denied" as const, decidedAt: new Date().toISOString() } : {}) });
    return { status: locked ? "denied" : "pending", ok: false, triesLeft: Math.max(0, MAX_CODE_TRIES - tries) };
  }

  private save(r: ApprovalRecord) {
    writeFileSync(this.file(r.id), JSON.stringify(r, null, 2));
  }

  /** The lease is gone, so approving can't do anything: close its open requests. */
  expireForLease(leaseId: string) {
    for (const r of this.list("pending")) if (r.leaseId === leaseId) this.save({ ...r, status: "expired", decidedAt: new Date().toISOString() });
  }

  /** Pending requests older than ttlMs expire (nobody answered). */
  expireStale(ttlMs: number) {
    const now = Date.now();
    for (const r of this.list("pending")) {
      if (now - Date.parse(r.createdAt) > ttlMs) this.save({ ...r, status: "expired", decidedAt: new Date().toISOString() });
    }
  }

  /** Mark a decision as used by the agent's retry. */
  consume(id: string) {
    const r = this.get(id);
    if (r) this.save({ ...r, used: true });
  }

  /** Wait up to timeoutMs for a decision without expiring the request; returns the current status. */
  async poll(id: string, timeoutMs: number, pollMs = 500): Promise<ApprovalRecord["status"] | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = this.get(id);
      if (!r || r.status !== "pending" || Date.now() > deadline) return r?.status;
      await new Promise((res) => setTimeout(res, pollMs));
    }
  }

  /** Wait for the owner's decision; expires the request after timeoutMs. */
  async wait(id: string, timeoutMs: number, pollMs = 500): Promise<ApprovalRecord["status"]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = this.get(id);
      if (r && r.status !== "pending") return r.status;
      if (Date.now() > deadline) {
        if (r) {
          r.status = "expired";
          r.decidedAt = new Date().toISOString();
          writeFileSync(this.file(id), JSON.stringify(r, null, 2));
        }
        return "expired";
      }
      await new Promise((res) => setTimeout(res, pollMs));
    }
  }
}
