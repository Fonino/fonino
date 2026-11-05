import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ApprovalUnavailableError,
  GRANT_RETRIES,
  ScriptedModel,
  canonicalRecipient,
  intentKey,
  runAgent,
  type AgentAction,
  type ApprovalRequest,
  type ApprovalSpec,
} from "@agentphone/agent-runtime";
import { MockAdapter, type PhoneDevice } from "@agentphone/device-core";

const spec = (over: Partial<ApprovalSpec> = {}): ApprovalSpec => ({
  app: "Messages", operation: "send_message", recipient: "+1 (628) 200-8584", payload: "test",
  summary: 'Send "test" to +1 (628) 200-8584', ...over,
});
const send = (over: Partial<ApprovalSpec> = {}): AgentAction => ({
  type: "tap", x: 385, y: 907, rationale: "send", risk: "external_communication", approval: spec(over),
});
const finish: AgentAction = { type: "finish", status: "success", summary: "done", rationale: "done", risk: "normal" };

async function run(actions: AgentAction[], approve: (r: ApprovalRequest) => Promise<boolean>, device?: PhoneDevice) {
  const dev = device ?? (await new MockAdapter(1).getDevice("mock-1"));
  return runAgent({
    device: dev, model: new ScriptedModel(actions), goal: "t", approve, settleMs: 0,
    runsDir: mkdtempSync(join(tmpdir(), "agentphone-test-")),
  });
}

test("recipients are canonicalized by kind", () => {
  assert.equal(canonicalRecipient("+1 (628) 200-8584"), canonicalRecipient("6282008584"));
  assert.equal(canonicalRecipient("Me@Example.com"), "mailto:me@example.com");
  assert.notEqual(canonicalRecipient("Marco"), canonicalRecipient("Maria"));
  assert.notEqual(canonicalRecipient("Marco"), canonicalRecipient("Marco R."));
});

test("intent keys are structured: device, recipient and exact payload all matter", () => {
  const k = (d: string, s: ApprovalSpec) => intentKey(d, "external_communication", s);
  assert.equal(k("p1", spec()), k("p1", spec({ recipient: "6282008584", summary: "different wording" })));
  // Same quoted text, different named recipients — collided under the old prose matcher.
  assert.notEqual(k("p1", spec({ recipient: "Marco", payload: "hi" })), k("p1", spec({ recipient: "Maria", payload: "hi" })));
  assert.notEqual(k("p1", spec()), k("p2", spec()));
  assert.notEqual(k("p1", spec()), k("p1", spec({ payload: "test " })));
  assert.notEqual(k("p1", spec()), k("p1", spec({ app: "WhatsApp" })));
});

test("a retry of the same structured intent is covered without prompting, up to the retry limit", async () => {
  const prompts: string[] = [];
  const r = await run([send(), send({ summary: "retry wording" }), send(), send(), finish], async (req) => (prompts.push(req.description), true));
  assert.equal(GRANT_RETRIES, 2);
  assert.equal(prompts.length, 2); // first send + after 2 covered retries the limit forces a new prompt
  assert.equal(r.metrics.actions, 4);
});

test("a different recipient is never covered by an earlier approval", async () => {
  let asked = 0;
  await run([send({ recipient: "Marco", payload: "hi" }), send({ recipient: "Maria", payload: "hi" }), finish], async () => (asked++, true));
  assert.equal(asked, 2);
});

test("risky tool calls without a structured approval are rejected as invalid", async () => {
  const { toolCallToAction } = await import("@agentphone/agent-runtime");
  assert.throws(() => toolCallToAction("phone_tap", { x: 1, y: 1, rationale: "x", risk: "purchase" }), /requires an "approval" object/);
});

test("a declined intent grants nothing", async () => {
  let asked = 0;
  const r = await run([send(), send(), finish], async () => (asked++, false));
  assert.equal(asked, 2);
  assert.equal(r.metrics.actions, 0);
});

test("a closed approval channel stops the run and does nothing", async () => {
  const r = await run([send(), { type: "home", rationale: "x", risk: "normal" }, finish], async () => {
    throw new ApprovalUnavailableError();
  });
  assert.equal(r.status, "aborted");
  assert.equal(r.metrics.actions, 0);
});

test("after a long approval wait, a changed screen blocks the stale tap", async () => {
  const base = await new MockAdapter(1).getDevice("mock-1");
  let taps = 0;
  let calls = 0;
  // A device whose screen changes on its own while the owner is deciding.
  const drifting: PhoneDevice = {
    ...base,
    id: base.id, name: base.name, adapter: base.adapter,
    getScreen: async (o) => {
      calls++;
      const s = await base.getScreen(o);
      const sig = Buffer.alloc(48 * 104, calls >= 2 ? 200 : 20).toString("base64");
      return { ...s, signature: sig };
    },
    tap: async () => void taps++,
  };
  const { STALE_AFTER_MS } = await import("@agentphone/agent-runtime");
  const r = await run(
    [send(), finish],
    async () => (await new Promise((res) => setTimeout(res, STALE_AFTER_MS + 100)), true),
    drifting,
  );
  assert.equal(taps, 0, "must not fire old coordinates at a changed screen");
  assert.equal(r.status, "success");
});

test("always allow: a standing rule covers the same kind of action in the same app for that assistant only, capped per day", async () => {
  const { ApprovalQueue } = await import("@agentphone/mcp-server");
  const { RULE_PER_DAY, ruleable } = await import("@agentphone/shared");
  const q = new ApprovalQueue(join(mkdtempSync(join(tmpdir(), "agentphone-rules-")), "approvals"));
  const invite = (to: string) => ({ app: "LinkedIn (Emma Bennet)", operation: "Send connection request with personalized note", recipient: to, payload: "Hi", summary: "invite" });
  const who = { principal: "k1", holder: "grok-bot · Grok Bot" };
  assert.ok(ruleable("external_communication", invite("A")));
  assert.equal(ruleable("purchase", { app: "Amazon", operation: "purchase" }), undefined); // money always asks
  assert.equal(q.useRule(who, "external_communication", invite("A")), undefined);

  const r = q.create({ deviceId: "iphone-003", leaseId: "l1", holder: who.holder, principal: who.principal, risk: "external_communication", spec: invite("Andy") });
  q.decide(r.id, true, "always");
  assert.equal(q.rules().length, 1);
  const hit = q.useRule(who, "external_communication", { ...invite("Someone else"), app: "linkedin", operation: "send_connection_request" });
  assert.ok(hit && !hit.capped);
  assert.equal(q.useRule(who, "external_communication", { ...invite("B"), operation: "send_message" }), undefined); // other kind
  assert.equal(q.useRule({ principal: "k2", holder: "muse · Muse" }, "external_communication", invite("B")), undefined); // other assistant
  for (let i = 1; i < RULE_PER_DAY; i++) assert.ok(!q.useRule(who, "external_communication", invite("B"))!.capped);
  assert.ok(q.useRule(who, "external_communication", invite("B"))!.capped);

  const p = q.create({ deviceId: "iphone-003", leaseId: "l1", holder: who.holder, principal: who.principal, risk: "purchase", spec: { app: "Amazon", operation: "purchase", summary: "buy" } });
  assert.throws(() => q.decide(p.id, true, "always"));
  assert.ok(q.removeRule(q.rules()[0].id));
  assert.equal(q.useRule(who, "external_communication", invite("A")), undefined);
});
