import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pruneData } from "@agentphone/mcp-server";

test("retention deletes old recordings/approvals/usage and keeps recent ones", () => {
  const home = mkdtempSync(join(tmpdir(), "ap-ret-"));
  const runs = join(home, "runs");
  const now = Date.parse("2026-09-27T00:00:00Z");
  const old = (p: string, days: number) => utimesSync(p, (now - days * 86_400_000) / 1000, (now - days * 86_400_000) / 1000);
  for (const [d, age] of [["old-run", 91], ["new-run", 10]] as const) {
    mkdirSync(join(runs, d), { recursive: true });
    old(join(runs, d), age);
  }
  mkdirSync(join(home, "approvals"), { recursive: true });
  writeFileSync(join(home, "approvals", "a.json"), "{}");
  old(join(home, "approvals", "a.json"), 100);
  mkdirSync(join(home, "usage"), { recursive: true });
  for (const m of ["2025-08", "2025-09", "2026-09"]) writeFileSync(join(home, "usage", `${m}.jsonl`), "");
  const r = pruneData({ home, runsDir: runs, now });
  assert.deepEqual(r, { runs: 1, approvals: 1, usage: 1 });
  assert.ok(!existsSync(join(runs, "old-run")) && existsSync(join(runs, "new-run")));
  assert.ok(!existsSync(join(home, "usage", "2025-08.jsonl")) && existsSync(join(home, "usage", "2025-09.jsonl")));
});
