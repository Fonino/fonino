import assert from "node:assert/strict";
import { test } from "node:test";
import { HealthAlerter } from "../apps/cli/src/alerts.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("alerts: needs_human at once, down only if it lasts, back online after an alert", async () => {
  const sent: string[] = [];
  const a = new HealthAlerter((t) => sent.push(t), 100);
  a.update("iphone-002", "healthy");
  a.update("iphone-002", "down");
  a.update("iphone-002", "starting");
  a.update("iphone-002", "healthy"); // quick restart: silent
  await wait(150);
  assert.deepEqual(sent, []);
  a.update("iphone-002", "down");
  await wait(150);
  assert.deepEqual(sent, ["AgentPhone: iphone-002 is offline"]);
  a.update("iphone-002", "needs_human", "locked");
  a.update("iphone-002", "healthy");
  assert.deepEqual(sent.slice(1), ["AgentPhone: iphone-002 needs you", "AgentPhone: iphone-002 is back"]);
});
