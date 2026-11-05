// The browser service: sessions per agent, the recipe store, the vault and the optional AI.
// One instance per process, shared by the MCP server and the CLI.
import { homedir } from "node:os";
import { join } from "node:path";
import { DeviceError } from "@agentphone/shared";
import { makeAi, type BrowserAi } from "./ai.ts";
import { Engine, type EngineOptions } from "./engine.ts";
import type { GuardOptions } from "./net-guard.ts";
import { RecipeStore } from "./recipes.ts";
import { BrowserSession } from "./session.ts";
import { KeychainVault, type Vault } from "./vault.ts";

export interface BrowserServiceOptions {
  engine?: Engine | EngineOptions;
  vault?: Vault;
  recipes?: RecipeStore;
  ai?: BrowserAi | null;
  guard?: GuardOptions;
  /** Close sessions idle for this long. */
  sessionIdleMs?: number;
  runsDir?: string;
}

export class BrowserService {
  readonly engine: Engine;
  readonly vault: Vault;
  readonly recipes: RecipeStore;
  readonly ai: BrowserAi | null;
  readonly guard: GuardOptions;
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly idleMs: number;
  private readonly shotsDir: string;
  private readonly runsDir?: string;
  private sweeper?: NodeJS.Timeout;

  constructor(opts: BrowserServiceOptions = {}) {
    this.engine = opts.engine instanceof Engine ? opts.engine : new Engine(opts.engine);
    this.vault = opts.vault ?? new KeychainVault();
    this.recipes = opts.recipes ?? new RecipeStore();
    // Our own AI is off by default: the calling agent (Grok, Muse, ChatGPT…) is the AI, so the
    // service costs nothing per run. AGENTPHONE_BROWSER_AI=1 enables it (CLI testing).
    this.ai = opts.ai === undefined ? (process.env.AGENTPHONE_BROWSER_AI === "1" ? makeAi() : null) : opts.ai;
    this.guard = opts.guard ?? {};
    this.idleMs = opts.sessionIdleMs ?? 15 * 60_000;
    this.shotsDir = join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "browser", "shots");
    this.runsDir = opts.runsDir;
  }

  async open(who: { principalId: string; holder: string; task?: string }): Promise<BrowserSession> {
    this.closeIdle();
    const s = await BrowserSession.create({ engine: this.engine, vault: this.vault, guard: this.guard, shotsDir: this.shotsDir, runsDir: this.runsDir }, who);
    this.sessions.set(s.id, s);
    if (!this.sweeper) {
      this.sweeper = setInterval(() => this.closeIdle(), 60_000);
      this.sweeper.unref();
    }
    return s;
  }

  /** A session of this principal. Someone else's session looks exactly like an unknown one. */
  get(id: string, principalId: string): BrowserSession {
    const s = this.sessions.get(id);
    if (!s || s.principalId !== principalId) {
      throw new DeviceError("session_invalid", "Unknown or closed session_id.", "Call browser_open to start a session.");
    }
    s.lastUsed = Date.now();
    return s;
  }

  list(principalId?: string): BrowserSession[] {
    return [...this.sessions.values()].filter((s) => !principalId || s.principalId === principalId);
  }

  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    await s.close();
  }

  closeIdle(): void {
    for (const s of this.sessions.values()) {
      // A run waiting for the owner's approval stays open a bit longer.
      const limit = s.run ? this.idleMs * 2 : this.idleMs;
      if (Date.now() - s.lastUsed > limit) void this.close(s.id);
    }
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweeper);
    this.sweeper = undefined;
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
    await this.engine.stop();
  }
}
