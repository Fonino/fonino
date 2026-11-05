// Hosted-service behaviour on mock phones: customer keys, per-key phone scoping, lease
// isolation between customers, send-message with and without owner approval, usage
// metering, and the local-only dashboard.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const home = mkdtempSync(join(tmpdir(), "agentphone-svc-"));
process.env.AGENTPHONE_HOME = home;
process.env.AGENTPHONE_RUNS_DIR = join(home, "runs");

const { DeviceRegistry, MockAdapter, LeaseStore } = await import("@agentphone/device-core");
const { ApprovalQueue, KeyStore, UsageLog, startRemoteMcp } = await import("@agentphone/mcp-server");

const OWNER_TOKEN = "ap_owner-test-token";
const keys = new KeyStore();
const approvals = new ApprovalQueue();
const usage = new UsageLog();
let server: http.Server;
let stop = () => {};
const mocks = new MockAdapter(2);
let port = 0;

type R = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const meta = (r: R) => JSON.parse(r.content.find((x) => x.type === "text" && x.text!.trim().startsWith("{"))!.text!.split("\nDo NOT")[0]);

async function connect(token: string) {
  const c = new Client({ name: "test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return { call: async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as R, close: () => c.close() };
}

function getRaw(path: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

before(async () => {
  const registry = new DeviceRegistry({ aliases: false, leases: new LeaseStore() }).register(mocks);
  const started = await startRemoteMcp({ registry, token: OWNER_TOKEN, port: 0, keys, approvals, usage, approvalTimeoutMs: 10_000, log: () => {} });
  server = started.server;
  stop = () => started.core.releaseAll();
  port = (server.address() as { port: number }).port;
});
after(() => {
  stop();
  server.closeAllConnections();
  server.close();
});

test("unknown and malformed keys are rejected", async () => {
  await assert.rejects(connect("apk_deadbeef_nope"));
  await assert.rejects(connect("not-a-key"));
});

test("a customer key only sees and uses its own phones", async () => {
  const { key } = keys.create("acme", { devices: ["mock-1"], requireApproval: false });
  const c = await connect(key);
  const list = JSON.parse((await c.call("phone_list_devices")).content[0].text!);
  assert.deepEqual(list.map((d: { id: string }) => d.id), ["mock-1"]);
  const denied = await c.call("phone_acquire", { device_id: "mock-2", task: "x" });
  assert.equal(denied.isError, true);
  assert.equal(meta(denied).code, "forbidden_device");
  await c.close();
});

test("customers can't use each other's leases; holder names are prefixed", async () => {
  const a = await connect(keys.create("alpha", { requireApproval: false }).key);
  const b = await connect(keys.create("beta", { requireApproval: false }).key);
  const acq = await a.call("phone_acquire", { device_id: "mock-2", task: "alpha task", holder: "owner (live view)" });
  const lease = meta(acq).lease_id;
  const stolen = await b.call("phone_home", { device_id: "mock-2", lease_id: lease });
  assert.equal(meta(stolen).code, "lease_invalid");
  const list = JSON.parse((await b.call("phone_list_devices")).content[0].text!);
  assert.deepEqual(Object.keys(list.find((d: { id: string }) => d.id === "mock-2").leased_by), ["busy", "until"]); // no other tenant's name/task
  const owner = await connect(OWNER_TOKEN);
  const ownerList = JSON.parse((await owner.call("phone_list_devices")).content[0].text!);
  assert.equal(ownerList.find((d: { id: string }) => d.id === "mock-2").leased_by.holder, "alpha: owner (live view)");
  await owner.close();
  assert.equal((await a.call("phone_release", { device_id: "mock-2", lease_id: lease })).isError, undefined);
  await a.close();
  await b.close();
});

test("send_message: no-approval key sends straight away and is metered", async () => {
  const { key, record } = keys.create("gamma", { requireApproval: false });
  const c = await connect(key);
  const lease = meta(await c.call("phone_acquire", { device_id: "mock-1", task: "text" })).lease_id;
  const r = await c.call("phone_send_message", { device_id: "mock-1", lease_id: lease, to: "+16285550100", body: "hello" });
  assert.ok(!r.isError);
  assert.equal(meta(r).status, "delivered");
  const read = meta(await c.call("phone_read_messages", { device_id: "mock-1", lease_id: lease, with: "+16285550100" }));
  assert.deepEqual(read.messages, [{ from: "me", text: "hello" }]);
  await c.call("phone_release", { device_id: "mock-1", lease_id: lease });
  const u = usage.summary().find((t) => t.tenant === record.id)!;
  assert.equal(u.messagesSent, 1);
  assert.equal(u.leases, 1);
  assert.ok(u.calls >= 4);
  await c.close();
});

test("send_message: approval → link for the user, retry after the owner decides; denial sends nothing", async () => {
  const c = await connect(keys.create("delta").key);
  const lease = meta(await c.call("phone_acquire", { device_id: "mock-1", task: "text" })).lease_id;
  const send = (body: string) => c.call("phone_send_message", { device_id: "mock-1", lease_id: lease, to: "+16285550101", body });

  // asks right away (no blocking), with a link and an id; asking again doesn't create a second request
  const p1 = meta(await send("no"));
  assert.equal(p1.code, "approval_pending");
  assert.match(p1.approve_url, /\/admin\/$/); // local Mac: the dashboard (relayed: app.fonino.app/approve/<host>/<id>)
  assert.equal(meta(await send("no")).approval_id, p1.approval_id);
  assert.equal(approvals.list("pending").length, 1);
  approvals.decide(p1.approval_id, false);
  assert.equal(meta(await c.call("phone_await_approval", { device_id: "mock-1", lease_id: lease, approval_id: p1.approval_id })).status, "denied");
  assert.equal(meta(await send("no")).code, "approval_denied");

  // a different text is a different request; approval covers exactly that text, once
  const p2 = meta(await send("yes"));
  assert.equal(p2.code, "approval_pending");
  const waiting = c.call("phone_await_approval", { device_id: "mock-1", lease_id: lease, approval_id: p2.approval_id });
  setTimeout(() => approvals.decide(p2.approval_id, true), 300);
  assert.equal(meta(await waiting).status, "approved");
  assert.equal(meta(await send("yes")).status, "delivered");
  assert.equal(approvals.get(p2.approval_id)!.spec.payload, "yes");
  assert.equal(meta(await send("yes")).code, "approval_pending"); // one approval = one send
  const read = meta(await c.call("phone_read_messages", { device_id: "mock-1", lease_id: lease, with: "+16285550101" }));
  assert.deepEqual(read.messages.map((m: { text: string }) => m.text), ["yes"]);

  // agents often release the phone while the owner decides: the decision still applies to their next lease
  const p3 = meta(await send("after a new lease"));
  approvals.decide(p3.approval_id, true);
  await c.call("phone_release", { device_id: "mock-1", lease_id: lease });
  const lease2 = meta(await c.call("phone_acquire", { device_id: "mock-1", task: "text again" })).lease_id;
  assert.equal(meta(await c.call("phone_send_message", { device_id: "mock-1", lease_id: lease2, to: "+16285550101", body: "after a new lease" })).status, "delivered");
  await c.call("phone_release", { device_id: "mock-1", lease_id: lease2 });
  // ...but never for a different assistant
  const other = await connect(keys.create("delta-2").key);
  const lease3 = meta(await other.call("phone_acquire", { device_id: "mock-1", task: "text" })).lease_id;
  const p4 = meta(await c.call("phone_acquire", { device_id: "mock-2", task: "x" }));
  assert.equal(meta(await other.call("phone_await_approval", { device_id: "mock-1", lease_id: lease3, approval_id: p3.approval_id })).code, "approval_unknown");
  await other.call("phone_release", { device_id: "mock-1", lease_id: lease3 });
  await other.close();
  await c.call("phone_release", { device_id: "mock-2", lease_id: p4.lease_id });
  await c.close();
});

test("a recipient allowlist limits who a key can text", async () => {
  const c = await connect(keys.create("zeta", { requireApproval: false, allowRecipients: ["+1 (628) 555-0100"] }).key);
  const lease = meta(await c.call("phone_acquire", { device_id: "mock-2", task: "text" })).lease_id;
  const ok = await c.call("phone_send_message", { device_id: "mock-2", lease_id: lease, to: "628-555-0100", body: "allowed" });
  assert.equal(meta(ok).status, "delivered");
  const no = await c.call("phone_send_message", { device_id: "mock-2", lease_id: lease, to: "+16285550199", body: "not allowed" });
  assert.equal(meta(no).code, "recipient_not_allowed");
  keys.setAllowlist("zeta", undefined);
  const now = await c.call("phone_send_message", { device_id: "mock-2", lease_id: lease, to: "+16285550199", body: "now allowed" });
  assert.equal(meta(now).status, "delivered");
  await c.call("phone_release", { device_id: "mock-2", lease_id: lease });
  await c.close();
});

test("wait_for_reply returns the other person's reply after our latest message", async () => {
  const c = await connect(keys.create("eta", { requireApproval: false }).key);
  const lease = meta(await c.call("phone_acquire", { device_id: "mock-1", task: "chat" })).lease_id;
  await c.call("phone_send_message", { device_id: "mock-1", lease_id: lease, to: "+16285550300", body: "Dinner at 8?" });
  const none = await c.call("phone_wait_for_reply", { device_id: "mock-1", lease_id: lease, with: "+16285550300", max_wait_s: 5 });
  assert.equal(meta(none).still_waiting, true);
  const phone = (await mocks.getDevice("mock-1")) as unknown as { receive(from: string, body: string): void };
  setTimeout(() => phone.receive("+16285550300", "Yes, see you then"), 1500);
  const got = await c.call("phone_wait_for_reply", { device_id: "mock-1", lease_id: lease, with: "+16285550300", max_wait_s: 20 });
  assert.deepEqual(meta(got).untrusted_replies, ["Yes, see you then"]);
  await c.call("phone_release", { device_id: "mock-1", lease_id: lease });
  await c.close();
});

test("an opt-out learned from a read blocks later sends, even when STOP is no longer visible", async () => {
  const c = await connect(keys.create("theta", { requireApproval: false }).key);
  const lease = meta(await c.call("phone_acquire", { device_id: "mock-2", task: "t" })).lease_id;
  const phone = (await mocks.getDevice("mock-2")) as unknown as { receive(from: string, body: string): void };
  phone.receive("+16285550400", "STOP");
  await c.call("phone_read_messages", { device_id: "mock-2", lease_id: lease, with: "+16285550400" });
  const r = await c.call("phone_send_message", { device_id: "mock-2", lease_id: lease, to: "+1 (628) 555-0400", body: "hi" });
  assert.equal(meta(r).code, "recipient_opted_out");
  phone.receive("+16285550400", "START");
  await c.call("phone_read_messages", { device_id: "mock-2", lease_id: lease, with: "+16285550400" });
  assert.equal(meta(await c.call("phone_send_message", { device_id: "mock-2", lease_id: lease, to: "+16285550400", body: "hi again" })).status, "delivered");
  await c.call("phone_release", { device_id: "mock-2", lease_id: lease });
  await c.close();
});

test("US-only: international and short-code recipients are refused before anything is sent", async () => {
  const c = await connect(keys.create("iota", { requireApproval: false }).key);
  const lease = meta(await c.call("phone_acquire", { device_id: "mock-1", task: "t" })).lease_id;
  for (const to of ["+44 20 7946 0958", "+39 06 1234 5678", "+1 (028) 555-0100"]) {
    assert.equal(meta(await c.call("phone_send_message", { device_id: "mock-1", lease_id: lease, to, body: "x" })).code, "recipient_not_supported", to);
  }
  assert.equal(meta(await c.call("phone_send_message", { device_id: "mock-1", lease_id: lease, to: "friend@example.com", body: "x" })).status, "delivered");
  await c.call("phone_release", { device_id: "mock-1", lease_id: lease });
  await c.close();
});

test("revoked keys stop working immediately", async () => {
  const { key } = keys.create("epsilon");
  const c = await connect(key);
  await c.close();
  keys.revoke("epsilon");
  await assert.rejects(connect(key));
});

test("dashboard needs a login, is local-only and needs the CSRF header for POST", async () => {
  assert.equal((await getRaw("/admin/api/state")).status, 401);
  const { adminLoginToken } = await import("@agentphone/mcp-server");
  assert.equal((await getRaw(`/admin/login?t=${adminLoginToken("wrong-token")}`)).status, 403);
  const login = await new Promise<http.IncomingMessage>((resolve) => http.get({ host: "127.0.0.1", port, path: `/admin/login?t=${adminLoginToken(OWNER_TOKEN)}` }, resolve));
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  const get = (path: string, headers: Record<string, string> = {}, method = "GET") => getRaw(path, { cookie, ...headers }, method);
  const ok = await get("/admin/api/state");
  assert.equal(ok.status, 200);
  const s = JSON.parse(ok.body);
  assert.ok(s.devices.length === 2 && Array.isArray(s.usage) && s.keys.every((k: Record<string, unknown>) => !("hash" in k)));
  assert.equal((await get("/admin/api/state", { "cf-connecting-ip": "1.2.3.4" })).status, 404);
  assert.equal((await get("/admin/api/state", { "x-forwarded-for": "1.2.3.4" })).status, 404);
  assert.equal((await get("/admin/api/state", { host: "evil.example" })).status, 404);
  assert.equal((await getRaw("/admin/api/state")).status, 401); // no cookie
  assert.equal((await get("/admin/api/live/mock-1", {}, "POST")).status, 403);
  assert.equal((await get("/admin/api/live/mock-1", { "x-agentphone": "1" }, "POST")).status, 200);
});
