// Data retention, as stated in the privacy policy (apps/site/app/privacy):
//   session recordings (runs/: screenshots, actions, messages)   90 days
//   approval requests (+ their screenshots are inside runs/)     90 days
//   usage logs (billing)                                         13 months
//   send log for rate limits                                     24 hours (self-compacting)
//   service logs (logs/, wda/, ui-probe.log)                      capped at 10 MB each (tail kept)
// Runs at service start and daily after that.

import { closeSync, openSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultRunsDir } from "@agentphone/agent-runtime";

const DAY = 86_400_000;
export const RETENTION = { runsDays: 90, approvalsDays: 90, usageMonths: 13 };

function pruneOlderThan(dir: string, maxAgeMs: number, now: number): number {
  let n = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    const p = join(dir, e);
    try {
      if (now - statSync(p).mtimeMs > maxAgeMs) {
        rmSync(p, { recursive: true, force: true });
        n++;
      }
    } catch {
      /* raced with a writer; next pass */
    }
  }
  return n;
}

const LOG_CAP = 10_000_000;
const LOG_KEEP = 2_000_000;

/** Keep only the last LOG_KEEP bytes of a log that grew past LOG_CAP. */
function capLog(path: string): boolean {
  try {
    const size = statSync(path).size;
    if (size <= LOG_CAP) return false;
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(LOG_KEEP);
    readSync(fd, buf, 0, LOG_KEEP, size - LOG_KEEP);
    closeSync(fd);
    writeFileSync(path, Buffer.concat([Buffer.from(`[… ${size - LOG_KEEP} earlier bytes removed by retention]\n`), buf]));
    return true;
  } catch {
    return false;
  }
}

export function pruneData(opts: { home?: string; runsDir?: string; now?: number } = {}): { runs: number; approvals: number; usage: number } {
  const home = opts.home ?? process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone");
  const now = opts.now ?? Date.now();
  const runs = pruneOlderThan(opts.runsDir ?? defaultRunsDir(), RETENTION.runsDays * DAY, now);
  const approvals = pruneOlderThan(join(home, "approvals"), RETENTION.approvalsDays * DAY, now);
  // usage/<YYYY-MM>.jsonl: drop months older than the retention window.
  // Keep the current month and the 12 before it (13 months); first-of-month avoids day overflow.
  const d = new Date(now);
  const oldest = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (RETENTION.usageMonths - 1), 1)).toISOString().slice(0, 7);
  let usage = 0;
  try {
    for (const f of readdirSync(join(home, "usage"))) {
      const m = f.match(/^(\d{4}-\d{2})\.jsonl$/);
      if (m && m[1] < oldest) {
        rmSync(join(home, "usage", f), { force: true });
        usage++;
      }
    }
  } catch {
    /* no usage yet */
  }
  for (const dir of ["logs", "wda"]) {
    try {
      for (const f of readdirSync(join(home, dir))) if (f.endsWith(".log")) capLog(join(home, dir, f));
    } catch {
      /* not there */
    }
  }
  capLog(join(home, "ui-probe.log"));
  return { runs, approvals, usage };
}

export function scheduleRetention(log: (l: string) => void) {
  const run = () => {
    const r = pruneData();
    if (r.runs || r.approvals || r.usage) log(`retention: deleted ${r.runs} recordings, ${r.approvals} approvals, ${r.usage} usage months`);
  };
  run();
  setInterval(run, DAY).unref();
}
