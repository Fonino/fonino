// Usage metering: one JSON line per tool call in ~/.agentphone/usage/<YYYY-MM>.jsonl.
// This is the billing and support record: who used which phone, for what, and whether it worked.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type UsageEvent = {
  ts: string;
  /** Principal id: "owner" or a customer key id. */
  tenant: string;
  tenantName: string;
  tool: string;
  device?: string;
  ok: boolean;
  code?: string;
  ms: number;
  /** Set on phone_release: how long the phone was held. */
  heldMs?: number;
};

export type TenantUsage = {
  tenant: string;
  tenantName: string;
  calls: number;
  errors: number;
  messagesSent: number;
  leases: number;
  heldMinutes: number;
  devices: string[];
  lastSeen: string;
};

export class UsageLog {
  readonly dir: string;
  constructor(dir = join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "usage")) {
    this.dir = dir;
  }

  private file(month: string) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`month must look like 2026-09, got "${month}"`);
    return join(this.dir, `${month}.jsonl`);
  }

  record(e: Omit<UsageEvent, "ts">) {
    const ts = new Date().toISOString();
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.file(ts.slice(0, 7)), JSON.stringify({ ts, ...e }) + "\n");
    } catch {
      /* metering must never break a tool call */
    }
  }

  events(month = new Date().toISOString().slice(0, 7)): UsageEvent[] {
    const f = this.file(month);
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as UsageEvent];
        } catch {
          return [];
        }
      });
  }

  summary(month?: string): TenantUsage[] {
    const by = new Map<string, TenantUsage>();
    for (const e of this.events(month)) {
      let t = by.get(e.tenant);
      if (!t) {
        t = { tenant: e.tenant, tenantName: e.tenantName, calls: 0, errors: 0, messagesSent: 0, leases: 0, heldMinutes: 0, devices: [], lastSeen: e.ts };
        by.set(e.tenant, t);
      }
      t.calls++;
      if (!e.ok) t.errors++;
      if (e.ok && e.tool === "phone_send_message") t.messagesSent++;
      if (e.ok && e.tool === "phone_acquire") t.leases++;
      if (e.heldMs) t.heldMinutes += e.heldMs / 60_000;
      if (e.device && !t.devices.includes(e.device)) t.devices.push(e.device);
      if (e.ts > t.lastSeen) t.lastSeen = e.ts;
    }
    return [...by.values()].map((t) => ({ ...t, heldMinutes: Math.round(t.heldMinutes * 10) / 10 }));
  }
}
