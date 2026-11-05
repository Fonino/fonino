import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SendLimiter, limitsFromEnv } from "@agentphone/mcp-server";

const limiter = (l = { perPhoneHour: 3, perPhoneDay: 5, perRecipientHour: 2 }) =>
  new SendLimiter({ path: join(mkdtempSync(join(tmpdir(), "ap-rl-")), "sent.jsonl"), limits: l });
const code = (fn: () => void) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

test("per-recipient limit treats number formats as the same person", () => {
  const l = limiter();
  const t = Date.now();
  l.record("iphone-002", "k1", "+1 (628) 555-0100", t);
  l.record("iphone-002", "k1", "628-555-0100", t);
  assert.equal(code(() => l.check("iphone-002", "+16285550100", t)), "rate_limited");
  assert.equal(code(() => l.check("iphone-002", "+16285550199", t)), "ok");
  assert.equal(code(() => l.check("iphone-003", "+16285550100", t)), "ok"); // other phone, own budget
  assert.equal(code(() => l.check("iphone-002", "+16285550100", t + 3_600_001)), "ok"); // window passed
});

test("per-phone hourly and daily limits, across customers", () => {
  const l = limiter();
  const t = Date.now();
  for (const [i, k] of ["a", "b", "c"].entries()) l.record("iphone-002", k, `+1628555010${i}`, t - 1000);
  assert.equal(code(() => l.check("iphone-002", "+16285550999", t)), "rate_limited");
  assert.equal(code(() => l.check("iphone-002", "+16285550999", t + 3_600_000)), "ok");
  l.record("iphone-002", "a", "+16285550201", t + 3_600_000);
  l.record("iphone-002", "a", "+16285550202", t + 3_600_000);
  const err = (() => {
    try {
      l.check("iphone-002", "+16285550999", t + 3_700_000);
    } catch (e) {
      return e as { code: string; message: string; fix: string };
    }
  })();
  assert.equal(err?.code, "rate_limited");
  assert.match(err!.message, /per phone per day/);
  assert.match(err!.fix, /retry_after_s=\d+/);
});

test("limits from env", () => {
  assert.deepEqual(limitsFromEnv("perPhoneHour=7, perRecipientHour=1,bogus=3,perPhoneDay=x"), { perPhoneHour: 7, perPhoneDay: 100, perRecipientHour: 1 });
});
