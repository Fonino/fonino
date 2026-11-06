// Regression tests for the 2026-09-27 security review fixes.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const home = mkdtempSync(join(tmpdir(), "agentphone-sec-"));
process.env.AGENTPHONE_HOME = home;
process.env.AGENTPHONE_RUNS_DIR = join(home, "runs");
const { DeviceRegistry, MockAdapter, LeaseStore } = await import("@agentphone/device-core");
const { KeyStore, startRemoteMcp } = await import("@agentphone/mcp-server");

const keys = new KeyStore();
const mocks = new MockAdapter(2);
let server: http.Server;
let stop = () => {};
let core: Awaited<ReturnType<typeof startRemoteMcp>>["core"];
let base = "";

before(async () => {
  const registry = new DeviceRegistry({ aliases: false, leases: new LeaseStore() }).register(mocks);
  const s = await startRemoteMcp({ registry, token: "ap_owner", port: 0, keys, log: () => {} });
  server = s.server;
  core = s.core;
  stop = () => s.core.releaseAll();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => {
  stop();
  server.closeAllConnections();
  server.close();
});

type R = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const meta = (r: R) => JSON.parse(r.content.find((x) => x.type === "text" && x.text!.trim().startsWith("{"))!.text!.split("\nDo NOT")[0]);
async function connect(token: string) {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return { call: async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as R, close: () => c.close() };
}
const front = async (id: string, app: string) => (((await mocks.getDevice(id)) as unknown) as { front: string }).front = app;
function req(path: string, opts: { method?: string; cookie?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(`${base}${path}`, { method: opts.method ?? "GET", headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.headers ?? {}) } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    r.on("error", reject);
    r.end();
  });
}
async function openLink(url: string) {
  const u = new URL(url);
  const r = await req(u.pathname + u.search);
  return { status: r.status, cookie: String(r.headers["set-cookie"] ?? "").split(";")[0], path: u.pathname };
}

test("customers can't operate Messages/Phone/Settings by taps; texting only via phone_send_message", async () => {
  const c = await connect(keys.create("policy").key);
  const lease = meta(await c.call("phone_acquire", { device_id: "mock-1", task: "t" })).lease_id;
  for (const app of ["com.apple.MobileSMS", "com.apple.mobilephone", "com.apple.Preferences", "com.apple.Passbook"]) {
    assert.equal(meta(await c.call("phone_open_app", { device_id: "mock-1", lease_id: lease, bundle_id: app })).code, "app_blocked", app);
  }
  assert.ok(!(await c.call("phone_open_app", { device_id: "mock-1", lease_id: lease, bundle_id: "com.apple.mobilesafari", screenshot_after: false })).isError);
  await front("mock-1", "com.apple.MobileSMS"); // e.g. a notification banner opened Messages
  const scr = meta(await c.call("phone_get_screen", { device_id: "mock-1", lease_id: lease })).screen_id;
  assert.equal(meta(await c.call("phone_tap", { device_id: "mock-1", lease_id: lease, screen_id: scr, x: 300, y: 800 })).code, "app_blocked");
  assert.equal(meta(await c.call("phone_type", { device_id: "mock-1", lease_id: lease, text: "hi" })).code, "app_blocked");
  assert.ok(!(await c.call("phone_home", { device_id: "mock-1", lease_id: lease, screenshot_after: false })).isError); // leaving is fine
  await front("mock-1", "com.apple.springboard");
  await c.call("phone_release", { device_id: "mock-1", lease_id: lease });
  await c.close();
});

test("the owner is not restricted by the app policy", async () => {
  const c = await connect("ap_owner");
  const lease = meta(await c.call("phone_acquire", { device_id: "mock-2", task: "t" })).lease_id;
  assert.ok(!(await c.call("phone_open_app", { device_id: "mock-2", lease_id: lease, bundle_id: "com.apple.Preferences", screenshot_after: false })).isError);
  await front("mock-2", "com.apple.springboard");
  await c.call("phone_release", { device_id: "mock-2", lease_id: lease });
  await c.close();
});

test("customer live-view links: single use, view only, dead after release", async () => {
  const c = await connect(keys.create("viewer").key);
  const lease = meta(await c.call("phone_acquire", { device_id: "mock-1", task: "t" })).lease_id;
  const url = meta(await c.call("phone_live_view", { device_id: "mock-1", lease_id: lease })).live_view_url;
  const s = await openLink(url);
  assert.equal(s.status, 302);
  assert.equal((await openLink(url)).status, 403); // single use
  const st = JSON.parse((await req(`${s.path}/state`, { cookie: s.cookie })).body);
  assert.equal(st.canAct, false);
  const take = await req(`${s.path}/takeover`, { method: "POST", cookie: s.cookie, headers: { "x-agentphone": "1" } });
  assert.equal(take.status, 403);
  await c.call("phone_release", { device_id: "mock-1", lease_id: lease });
  assert.equal((await req(`${s.path}/state`, { cookie: s.cookie })).status, 401); // next tenant can't be watched
  await c.close();
});

test("help links act only during the help request; agent can't screenshot or end it early", async () => {
  const c = await connect(keys.create("helper").key);
  const lease = meta(await c.call("phone_acquire", { device_id: "mock-2", task: "t" })).lease_id;
  const help = meta(await c.call("phone_request_help", { device_id: "mock-2", lease_id: lease, reason: "enter passcode" }));
  const s = await openLink(help.live_view_url);
  assert.equal(JSON.parse((await req(`${s.path}/state`, { cookie: s.cookie })).body).canAct, true);
  assert.equal(meta(await c.call("phone_get_screen", { device_id: "mock-2", lease_id: lease })).code, "human_control");
  const done = await c.call("phone_owner_done", { device_id: "mock-2", lease_id: lease });
  assert.ok(!done.isError); // agent-requested help: the user approves this in chat
  assert.equal(JSON.parse((await req(`${s.path}/state`, { cookie: s.cookie })).body).canAct, false);
  await c.call("phone_release", { device_id: "mock-2", lease_id: lease });
  await c.close();
});

test("malformed request URLs don't crash the service", async () => {
  await new Promise<void>((resolve) => {
    const sock = net.connect(Number(new URL(base).port), "127.0.0.1", () => {
      sock.write("GET //x:99999 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    });
    sock.on("data", () => {});
    sock.on("close", () => resolve());
    sock.on("error", () => resolve());
    setTimeout(() => { sock.destroy(); resolve(); }, 1000);
  });
  assert.equal((await req("/.well-known/oauth-protected-resource")).status, 200); // still alive
});

test("publish buttons in social apps/browsers need approval; stale refusals carry a fresh screenshot", async () => {
  const c = await connect(keys.create("publisher", { requireApproval: false }).key);
  const lease = meta(await c.call("phone_acquire", { device_id: "mock-2", task: "t" })).lease_id;
  const phone = (await mocks.getDevice("mock-2")) as unknown as { front: string; buttons: Array<{ label: string; x: number; y: number; w: number; h: number }> };
  phone.front = "com.reddit.Reddit";
  phone.buttons = [{ label: "Comment", x: 300, y: 700, w: 80, h: 40 }];
  let scr = meta(await c.call("phone_get_screen", { device_id: "mock-2", lease_id: lease })).screen_id;
  const blocked = await c.call("phone_tap", { device_id: "mock-2", lease_id: lease, screen_id: scr, x: 320, y: 710 });
  assert.equal(meta(blocked).code, "approval_required");
  // elsewhere on the page: fine
  const ok = await c.call("phone_tap", { device_id: "mock-2", lease_id: lease, screen_id: scr, x: 50, y: 300 });
  assert.ok(!ok.isError);
  scr = meta(ok).screen_id;
  // with an approval spec it goes through the gate (this key needs no owner approval)
  const posted = await c.call("phone_tap", { device_id: "mock-2", lease_id: lease, screen_id: scr, x: 320, y: 710, risk: "external_communication",
    approval: { app: "Reddit (Safari)", operation: "post_comment", recipient: "r/test", payload: "hi", summary: "Comment hi" } });
  assert.ok(!posted.isError, JSON.stringify(posted.content.find((x) => x.type === "text")));
  // stale: an old screen_id is refused, but the reply includes a new screenshot to act on
  const stale = await c.call("phone_tap", { device_id: "mock-2", lease_id: lease, screen_id: scr, x: 50, y: 300 });
  assert.equal(stale.isError, true);
  assert.ok(stale.content.some((x) => x.type === "image"));
  assert.match(meta(stale).screen_id, /^scr_/);
  phone.front = "com.apple.springboard";
  phone.buttons = [];
  await c.call("phone_release", { device_id: "mock-2", lease_id: lease });
  await c.close();
});

test("publish detection from OCR text", async () => {
  const { looksLikePublish } = await import("../packages/mcp-server/src/policy.ts");
  assert.equal(looksLikePublish(["b • Reply ..."]), "b • Reply ...");
  assert.equal(looksLikePublish(["Post"]), "Post");
  assert.equal(looksLikePublish(["Send"]), "Send");
  assert.equal(looksLikePublish(["23 comments"]), undefined);
  assert.equal(looksLikePublish(["Create Post"]), undefined);
  assert.equal(looksLikePublish(["PSA: how to turn on smooth and fast screen sharing"]), undefined);
});

test("buy buttons in shopping apps need purchase approval", async () => {
  const c = await connect(keys.create("shopper", { requireApproval: false }).key);
  const lease = meta(await c.call("phone_acquire", { device_id: "mock-2", task: "t" })).lease_id;
  const phone = (await mocks.getDevice("mock-2")) as unknown as { front: string; buttons: Array<{ label: string; x: number; y: number; w: number; h: number }> };
  phone.front = "com.amazon.Amazon";
  phone.buttons = [{ label: "Place your order", x: 40, y: 800, w: 350, h: 50 }];
  let scr = meta(await c.call("phone_get_screen", { device_id: "mock-2", lease_id: lease })).screen_id;
  const blocked = await c.call("phone_tap", { device_id: "mock-2", lease_id: lease, screen_id: scr, x: 215, y: 825 });
  assert.equal(meta(blocked).code, "approval_required");
  assert.match(JSON.stringify(blocked.content), /purchase/);
  const ok = await c.call("phone_tap", { device_id: "mock-2", lease_id: lease, screen_id: scr, x: 50, y: 300 });
  assert.ok(!ok.isError);
  scr = meta(ok).screen_id;
  const bought = await c.call("phone_tap", { device_id: "mock-2", lease_id: lease, screen_id: scr, x: 215, y: 825, risk: "purchase",
    approval: { app: "Amazon", operation: "purchase", recipient: "Amazon.com", payload: "1x USB-C cable, $7.99", summary: "Buy a USB-C cable" } });
  // even a key without approvals can't spend the owner's money: the owner still decides
  assert.equal(meta(bought).code, "approval_pending");
  phone.front = "com.apple.springboard";
  phone.buttons = [];
  await c.call("phone_release", { device_id: "mock-2", lease_id: lease });
  await c.close();
});

test("purchase detection from OCR text", async () => {
  const { looksLikePurchase } = await import("../packages/mcp-server/src/policy.ts");
  assert.equal(looksLikePurchase(["Place your order"]), "Place your order");
  assert.equal(looksLikePurchase(["Buy Now"]), "Buy Now");
  assert.equal(looksLikePurchase(["Pay"]), "Pay");
  assert.equal(looksLikePurchase(["Add to Cart"]), undefined);
  assert.equal(looksLikePurchase(["Proceed to checkout (1 item)"]), undefined);
  assert.equal(looksLikePurchase(["How to pay less for groceries every week"]), undefined);
});

test("an agent that leaves after a declined approval doesn't keep the phone", async () => {
  const c = await connect(keys.create("leaver").key); // texts and purchases need the owner's approval
  const lease = meta(await c.call("phone_acquire", { device_id: "mock-1", task: "t" })).lease_id;
  const scr = meta(await c.call("phone_get_screen", { device_id: "mock-1", lease_id: lease })).screen_id;
  const pending = meta(await c.call("phone_tap", { device_id: "mock-1", lease_id: lease, screen_id: scr, x: 50, y: 300, risk: "purchase",
    approval: { app: "Amazon", operation: "purchase", recipient: "Amazon.com", payload: "1x cable, $7.99", summary: "Buy a cable" } }));
  assert.equal(pending.code, "approval_pending");
  ((await mocks.getDevice("mock-1")) as unknown as { front: string }).front = "com.amazon.Amazon"; // left on the checkout page
  core.approvals.decide(pending.approval_id, false); // the owner declines; the agent is gone
  await core.releaseAbandoned(-1);
  const after = await c.call("phone_get_screen", { device_id: "mock-1", lease_id: lease });
  assert.equal(meta(after).code, "lease_invalid");
  assert.equal(((await mocks.getDevice("mock-1")) as unknown as { front: string }).front, "com.apple.springboard"); // left on the Home Screen
  await c.close();
});

test("an approval outlives the phone release: the same assistant's next run picks up the owner's OK, another's doesn't", async () => {
  const key = keys.create("rerun").key;
  const spec = { app: "Amazon", operation: "delete", recipient: "cart", payload: "1x cable", summary: "Delete cart item" };
  const tap = async (token: string) => {
    const c = await connect(token);
    const lease = meta(await c.call("phone_acquire", { device_id: "mock-1", task: "t" })).lease_id;
    const scr = meta(await c.call("phone_get_screen", { device_id: "mock-1", lease_id: lease })).screen_id;
    const r = await c.call("phone_tap", { device_id: "mock-1", lease_id: lease, screen_id: scr, x: 50, y: 300, risk: "destructive", approval: spec });
    await c.call("phone_release", { device_id: "mock-1", lease_id: lease });
    await c.close();
    return r;
  };
  const first = meta(await tap(key)); // short-turn agents (Grok Bot) ask, release and come back later
  assert.equal(first.code, "approval_pending");
  assert.equal(core.approvals.get(first.approval_id)!.status, "pending");
  const again = meta(await tap(key)); // back before the owner answered: the same request, no second notification
  assert.equal(again.approval_id, first.approval_id);
  core.approvals.decide(first.approval_id, true);
  const other = meta(await tap(keys.create("other").key));
  assert.equal(other.code, "approval_pending"); // another assistant never inherits it
  assert.notEqual(other.approval_id, first.approval_id);
  const done = await tap(key);
  assert.ok(!done.isError, JSON.stringify(done.content[0]));
  assert.equal(core.approvals.get(first.approval_id)!.used, true);
});

test("OpenAI plugin review: every customer tool has explicit annotations and declares OAuth", async () => {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${keys.create("lister").key}` } } }));
  const { tools } = await c.listTools();
  assert.ok(tools.length > 15);
  for (const t of tools) {
    for (const h of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) assert.equal(typeof t.annotations?.[h], "boolean", `${t.name}.${h}`);
    assert.deepEqual((t._meta as { securitySchemes?: unknown })?.securitySchemes, [{ type: "oauth2", scopes: ["phone"] }], t.name);
    assert.ok(t.description && t.description.length > 10, `${t.name} description`);
  }
  // a tap can do anything in any app: never advertised as safe
  assert.equal(tools.find((t) => t.name === "phone_tap")!.annotations!.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === "phone_send_message")!.annotations!.openWorldHint, true);
  await c.close();
});

test("one-time codes in messages are masked before an agent sees them", async () => {
  const { maskCodes } = await import("../packages/mcp-server/src/remote.ts");
  assert.doesNotMatch(maskCodes("Your Amazon verification code is 482913. Don't share it."), /482913/);
  assert.doesNotMatch(maskCodes("G-120394 is your Google verification code."), /120394/);
  assert.doesNotMatch(maskCodes("Sign in: https://example.com/magic?token=abc"), /token=abc/);
  assert.equal(maskCodes("See you at 8, table for 4 at 230 Dolores"), "See you at 8, table for 4 at 230 Dolores");
});
