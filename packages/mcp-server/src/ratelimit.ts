// Sending limits: protect every phone number from looking like a spammer (carriers filter
// and cut lines; Apple flags accounts). Every send attempt that reaches the phone counts,
// including failed ones, and the log survives restarts (~/.agentphone/sent.jsonl).
//
// Defaults suit person-to-person use; override with
//   AGENTPHONE_LIMITS="perPhoneHour=20,perPhoneDay=100,perRecipientHour=5"

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalRecipient } from "@agentphone/agent-runtime";
import { DeviceError } from "@agentphone/shared";

export type Limits = { perPhoneHour: number; perPhoneDay: number; perRecipientHour: number };
export const DEFAULT_LIMITS: Limits = { perPhoneHour: 20, perPhoneDay: 100, perRecipientHour: 5 };

export function limitsFromEnv(spec = process.env.AGENTPHONE_LIMITS): Limits {
  const l = { ...DEFAULT_LIMITS };
  for (const part of (spec ?? "").split(",").filter(Boolean)) {
    const [k, v] = part.split("=").map((x) => x.trim());
    if (k in l && Number.isFinite(Number(v)) && Number(v) >= 0) l[k as keyof Limits] = Number(v);
  }
  return l;
}

type Sent = { ts: number; device: string; tenant: string; to: string };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export class SendLimiter {
  readonly path: string;
  readonly limits: Limits;
  constructor(opts: { path?: string; limits?: Limits } = {}) {
    this.path = opts.path ?? join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "sent.jsonl");
    this.limits = opts.limits ?? limitsFromEnv();
  }

  private recent(now: number): Sent[] {
    if (!existsSync(this.path)) return [];
    const all = readFileSync(this.path, "utf8")
      .split("\n")
      .flatMap((l) => {
        try {
          return l ? [JSON.parse(l) as Sent] : [];
        } catch {
          return [];
        }
      });
    const keep = all.filter((s) => now - s.ts < DAY);
    // Compact once the file is mostly expired entries.
    if (all.length > 500 && keep.length < all.length / 2) writeFileSync(this.path, keep.map((s) => JSON.stringify(s) + "\n").join(""));
    return keep;
  }

  /** Throws rate_limited (with when to retry) if this send would exceed a limit. */
  check(device: string, to: string, now = Date.now()) {
    const recent = this.recent(now).filter((s) => s.device === device);
    const who = canonicalRecipient(to);
    const rules: Array<[string, number, number, Sent[]]> = [
      ["per recipient per hour", this.limits.perRecipientHour, HOUR, recent.filter((s) => s.to === who && now - s.ts < HOUR)],
      ["per phone per hour", this.limits.perPhoneHour, HOUR, recent.filter((s) => now - s.ts < HOUR)],
      ["per phone per day", this.limits.perPhoneDay, DAY, recent],
    ];
    for (const [name, max, window, hits] of rules) {
      if (hits.length >= max) {
        const retryAfterS = Math.max(1, Math.ceil((Math.min(...hits.map((h) => h.ts)) + window - now) / 1000));
        throw new DeviceError(
          "rate_limited",
          `Sending limit reached for ${device}: ${max} messages ${name}. Nothing was sent.`,
          `Try again in ${retryAfterS < 120 ? `${retryAfterS} s` : `${Math.ceil(retryAfterS / 60)} min`} (retry_after_s=${retryAfterS}). Limits protect the phone number from spam filtering.`,
        );
      }
    }
  }

  record(device: string, tenant: string, to: string, now = Date.now()) {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify({ ts: now, device, tenant, to: canonicalRecipient(to) } satisfies Sent) + "\n");
  }
}
