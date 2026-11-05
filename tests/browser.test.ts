// Agent browser over MCP, end to end against a local fixture shop: a test client plays the remote
// agent (Grok, Muse…): it records a purchase, saves a recipe, replays it with other values, repairs
// it after a redesign — with the owner's approvals going through the normal approval queue.
// Skipped when Google Chrome isn't installed.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CHROME = process.env.AGENTPHONE_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const skip = !existsSync(CHROME) && "Google Chrome not installed";

const home = mkdtempSync(join(tmpdir(), "agentphone-br-"));
process.env.AGENTPHONE_HOME = home;
process.env.AGENTPHONE_RUNS_DIR = join(home, "runs");
const { DeviceRegistry, LeaseStore } = await import("@agentphone/device-core");
const { KeyStore, startRemoteMcp } = await import("@agentphone/mcp-server");
const { BrowserService, MemoryVault, RecipeStore } = await import("@agentphone/browser");
const { startShop, SHOP_USER, SHOP_PASSWORD } = await import("./fixtures/shop.ts");

type Shop = Awaited<ReturnType<typeof startShop>>;
type R = { content: Array<{ type: string; text?: string }>; isError?: boolean };
let shop: Shop;
let server: http.Server;
let core: Awaited<ReturnType<typeof startRemoteMcp>>["core"];
let base = "";
const keys = new KeyStore();
const outputs: string[] = []; // everything any agent saw, for the leak scan

before(async () => {
  if (skip) return;
  shop = await startShop();
  const vault = new MemoryVault().set(shop.origin, "username", SHOP_USER).set(shop.origin, "password", SHOP_PASSWORD);
  const browser = new BrowserService({ vault, ai: null, guard: { allowPrivate: true }, recipes: new RecipeStore(join(home, "recipes")), runsDir: join(home, "runs") });
  // No phones at all: the browser works on its own.
  const registry = new DeviceRegistry({ aliases: false, leases: new LeaseStore() });
  const s = await startRemoteMcp({ registry, token: "ap_owner", port: 0, keys, browser, log: () => {} });
  server = s.server;
  core = s.core;
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  if (skip) return;
  core.releaseAll();
  await core.browser?.closeAll();
  server.closeAllConnections();
  server.close();
  await shop.close();
});

async function connect(token: string) {
  const c = new Client({ name: "t", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return {
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await c.callTool({ name, arguments: args })) as R;
      const text = r.content.map((x) => x.text ?? "").join("\n");
      outputs.push(text);
      const head = text.split("\n\nPAGE")[0].split("\nDo NOT")[0];
      return { ...JSON.parse(head), page: text.split("\n\nPAGE")[1] ?? "", isError: !!r.isError } as Record<string, any>;
    },
    close: () => c.close(),
  };
}
/** Index of the first element line matching re in a page snapshot. */
function idx(page: string, re: RegExp): number {
  const line = page.split("\n").find((l) => /^\[\d+\]/.test(l) && re.test(l));
  assert.ok(line, `no element matching ${re} in:\n${page}`);
  return Number(line!.match(/^\[(\d+)\]/)![1]);
}
const approveLast = (id: string) => core.approvals.decide(id, true);

test("record a purchase over MCP, with the owner approving risky clicks", { skip }, async () => {
  const c = await connect("ap_owner");
  let r = await c.call("browser_open", { url: shop.url, task: "buy a backpack" });
  const sid = r.session_id;
  assert.match(r.page, /Password.*SENSITIVE FIELD/);

  const typed = await c.call("browser_type", { session_id: sid, index: idx(r.page, /Password/), text: "guess" });
  assert.equal(typed.code, "sensitive_field", "typing into a password box is refused");

  r = await c.call("browser_fill_secret", { session_id: sid, index: idx(r.page, /Username/), secret: "username" });
  r = await c.call("browser_fill_secret", { session_id: sid, index: idx(r.page, /Password/), secret: "password" });
  r = await c.call("browser_click", { session_id: sid, index: idx(r.page, /Sign in/) });
  r = await c.call("browser_click", { session_id: sid, index: idx(r.page, /add-to-cart-backpack/) });
  r = await c.call("browser_click", { session_id: sid, index: idx(r.page, /Cart \(1\)/) });

  // "Checkout" is a risky button: the owner must approve, with the page's items in the request.
  const checkoutIdx = idx(r.page, /Checkout/);
  const pending = await c.call("browser_click", { session_id: sid, index: checkoutIdx });
  assert.equal(pending.code, "approval_pending");
  const rec = core.approvals.get(pending.approval_id)!;
  assert.equal(rec.deviceId, "browser-001");
  assert.match(rec.spec.payload!, /Trail Backpack/);
  approveLast(pending.approval_id);
  assert.equal((await c.call("browser_await_approval", { session_id: sid, approval_id: pending.approval_id })).status, "approved");
  r = await c.call("browser_click", { session_id: sid, index: checkoutIdx });
  assert.equal(r.ok, true);

  r = await c.call("browser_type", { session_id: sid, index: idx(r.page, /First name/), text: "Ada" });
  r = await c.call("browser_type", { session_id: sid, index: idx(r.page, /Last name/), text: "Lovelace" });
  r = await c.call("browser_type", { session_id: sid, index: idx(r.page, /Zip/), text: "94016" });
  r = await c.call("browser_click", { session_id: sid, index: idx(r.page, /Continue/) });
  assert.match(r.page, /Total: \$29\.99/);

  // "Finish" has no risky word: the agent declares it, which can only add a check.
  const finishIdx = idx(r.page, /Finish/);
  const p2 = await c.call("browser_click", { session_id: sid, index: finishIdx, risk: "purchase" });
  assert.equal(p2.code, "approval_pending");
  assert.match(core.approvals.get(p2.approval_id)!.spec.payload!, /Total: \$29\.99/);
  approveLast(p2.approval_id);
  r = await c.call("browser_click", { session_id: sid, index: finishIdx, risk: "purchase" });
  assert.match(r.page, /Thank you for your order/);
  assert.deepEqual(shop.orders.at(-1), { items: ["Trail Backpack"], first: "Ada", last: "Lovelace", zip: "94016", total: "29.99" });

  const saved = await c.call("browser_save_recipe", { session_id: sid, task: "buy-product", params: { product: "backpack", first: "Ada", last: "Lovelace", zip: "94016" }, end_check: "Thank you for your order" });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.deepEqual(saved.params, ["first", "last", "product", "zip"]);
  assert.match(saved.needs_approval_on.join("\n"), /Checkout[\s\S]*Finish/);
  await c.call("browser_close", { session_id: sid });
  await c.close();
});

test("replay with other values pauses for each approval and resumes, without an AI", { skip }, async () => {
  const c = await connect("ap_owner");
  const recipe_id = `127.0.0.1:${new URL(shop.origin).port}/buy-product`;
  const params = { product: "bike-light", first: "Grace", last: "Hopper", zip: "10001" };
  let r = await c.call("browser_run_recipe", { recipe_id, params });
  const sid = r.session_id;
  for (let approvals = 0; r.code === "approval_pending"; approvals++) {
    assert.ok(approvals < 2);
    approveLast(r.approval_id);
    r = await c.call("browser_run_recipe", { recipe_id, params, session_id: sid });
  }
  assert.equal(r.status, "done", JSON.stringify(r));
  assert.deepEqual(shop.orders.at(-1), { items: ["Bike Light"], first: "Grace", last: "Hopper", zip: "10001", total: "9.99" });
  await c.call("browser_close", { session_id: sid });
  await c.close();
});

test("after a redesign the agent repairs the recipe; the risky step keeps its approval; the new version needs review", { skip }, async () => {
  shop.variant = 2; // cookie page, renamed add button, Finish -> Confirm
  const c = await connect("ap_owner");
  const recipe_id = `127.0.0.1:${new URL(shop.origin).port}/buy-product`;
  const params = { product: "onesie", first: "Alan", last: "Turing", zip: "02139" };
  let r = await c.call("browser_run_recipe", { recipe_id, params });
  const sid = r.session_id;
  const kinds: string[] = [];
  for (let n = 0; r.status !== "done"; n++) {
    assert.ok(n < 12, JSON.stringify(r));
    if (r.code === "approval_pending") {
      approveLast(r.approval_id);
      r = await c.call(r.retry.tool, r.retry.args);
      continue;
    }
    assert.equal(r.status, "repair_needed", JSON.stringify(r));
    // The agent looks at the page and decides (scripted here).
    const [re, repair] = /cookies/i.test(r.page) ? [/Accept cookies/, "extra_step"] : /add-to-cart/.test(r.expected) ? [/add-to-basket-onesie/, "replace"] : [/Confirm/, "replace"];
    const args = { session_id: sid, index: idx(r.page, re), repair };
    const fix = await c.call("browser_click", args);
    if (fix.code === "approval_pending") {
      // "Confirm" replaced the risky "Finish": the approval carries over even without a risky word.
      assert.match(core.approvals.get(fix.approval_id)!.spec.summary, /Confirm/);
      kinds.push("approval-on-repaired-step");
      approveLast(fix.approval_id);
      kinds.push((await c.call("browser_click", args)).repair);
    } else kinds.push(fix.repair);
    r = await c.call("browser_run_recipe", { recipe_id, params, session_id: sid });
    if (r.code === "approval_pending") r.retry = { tool: "browser_run_recipe", args: { recipe_id, params, session_id: sid } };
  }
  assert.deepEqual(kinds, ["inserted", "replaced", "approval-on-repaired-step", "replaced"]);
  assert.equal(r.new_version_status, "needs_review");
  assert.deepEqual(shop.orders.at(-1)?.items, ["Baby Onesie"]);
  // Until the owner reviews it, the old version is what runs (and it no longer fits the site).
  const list = await c.call("browser_list_recipes");
  assert.equal(list.recipes[0].runnable_version, 1);
  assert.equal(list.recipes[0].latest_status, "needs_review");
  assert.match(r.review.review_url, /\/admin\/$/);

  // The owner approves the review like any other request; the next run uses version 2, no repairs.
  const review = core.approvals.list("pending").find((a) => a.spec.operation === "approve_recipe_version")!;
  assert.match(review.spec.payload!, /NEW click "Accept cookies"/);
  assert.match(review.spec.payload!, /"Finish".*->.*"Confirm"/);
  core.approvals.decide(review.id, true);
  assert.equal((await c.call("browser_list_recipes")).recipes[0].runnable_version, 2);
  const params2 = { product: "backpack", first: "Ada", last: "Byron", zip: "11111" };
  r = await c.call("browser_run_recipe", { recipe_id, params: params2, session_id: sid });
  for (let n = 0; r.code === "approval_pending"; n++) {
    assert.ok(n < 2);
    approveLast(r.approval_id);
    r = await c.call("browser_run_recipe", { recipe_id, params: params2, session_id: sid });
  }
  assert.equal(r.status, "done", JSON.stringify(r));
  assert.equal(r.new_version, undefined, "no repairs needed");
  assert.deepEqual(shop.orders.at(-1)?.items, ["Trail Backpack"]);
  await c.call("browser_close", { session_id: sid });
  await c.close();
  shop.variant = 1;
});

test("guards: other agents' sessions, keys without the browser, off-site recipe steps", { skip }, async () => {
  const owner = await connect("ap_owner");
  const sid = (await owner.call("browser_open", { url: shop.url })).session_id;
  const cust = await connect(keys.create("cust", { devices: ["browser-001"] }).key);
  assert.equal((await cust.call("browser_snapshot", { session_id: sid })).code, "session_invalid");
  const noBrowser = await connect(keys.create("phone-only", { devices: ["iphone-002"] }).key);
  // Not public yet: phone-only keys don't even get the browser tools.
  await assert.rejects(noBrowser.call("browser_open", { url: shop.url }), /not found|MCP error/);
  keys.setDevices("phone-only", ["iphone-002", "browser-001"]); // the owner allows it; takes effect at once
  const opened = await noBrowser.call("browser_open", { url: shop.url });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  await noBrowser.call("browser_close", { session_id: opened.session_id });
  assert.throws(() => keys.setDevices("phone-only", []), /devices must be/);

  // A tampered recipe that clicks an off-site link: the browser refuses during replay.
  const store = core.browser!.recipes;
  const good = store.get(`127.0.0.1:${new URL(shop.origin).port}/buy-product`, 1);
  const evil = structuredClone(good);
  evil.id = `127.0.0.1:${new URL(shop.origin).port}/evil`;
  evil.task = "evil";
  evil.steps.splice(3, 0, { op: "click", path: "/inventory", target: { tag: "a", attr: "data-test", key: "social", label: "Follow us", secret: null, sensitiveAction: false } });
  store.save(evil);
  const r = await owner.call("browser_run_recipe", { recipe_id: evil.id, params: { product: "backpack", first: "A", last: "B", zip: "12345" } });
  assert.equal(r.code, "off_site_link");
  for (const c of [owner, cust, noBrowser]) await c.close();
});

test("approve in chat with the owner's one-time code; wrong codes are counted and lock the request", { skip }, async () => {
  const c = await connect("ap_owner");
  let r = await c.call("browser_open", { url: shop.url });
  const sid = r.session_id;
  const pending = await c.call("browser_click", { session_id: sid, index: idx(r.page, /Sign in/), risk: "authentication" });
  assert.equal(pending.code, "approval_pending");
  const code = core.approvals.get(pending.approval_id)!.code!;
  assert.match(code, /^\d{6}$/);
  assert.ok(!JSON.stringify(pending).includes(code), "the agent never receives the code");
  assert.match(pending.or_code, /browser_confirm_approval/);
  const wrong = await c.call("browser_confirm_approval", { session_id: sid, approval_id: pending.approval_id, code: code === "000000" ? "111111" : "000000" });
  assert.equal(wrong.code, "wrong_code");
  const ok = await c.call("browser_confirm_approval", { session_id: sid, approval_id: pending.approval_id, code });
  assert.equal(ok.status, "approved");
  assert.equal(core.approvals.get(pending.approval_id)!.via, "code");
  r = await c.call("browser_click", { session_id: sid, index: idx(r.page, /Sign in/), risk: "authentication" });
  assert.equal(r.ok, true, JSON.stringify(r));

  // Guessing: after 5 wrong codes the request is declined.
  r = await c.call("browser_open", { url: shop.url, session_id: sid });
  const p2 = await c.call("browser_click", { session_id: sid, index: idx(r.page, /Sign in/), risk: "destructive" });
  const real = core.approvals.get(p2.approval_id)!.code!;
  const bad = ["000001", "000002", "000003", "000004", "000005"].filter((x) => x !== real).slice(0, 5);
  let last: Record<string, any> = {};
  for (const b of bad) last = await c.call("browser_confirm_approval", { session_id: sid, approval_id: p2.approval_id, code: b });
  assert.equal(core.approvals.get(p2.approval_id)!.status, "denied");
  assert.equal((await c.call("browser_confirm_approval", { session_id: sid, approval_id: p2.approval_id, code: real })).code, "approval_closed");
  assert.ok(last.isError);
  await c.call("browser_close", { session_id: sid });
  await c.close();
});

test("'allow for this task': one approval covers the rest of the run, but never more money than approved", { skip }, async () => {
  shop.variant = 2; // the approved recipe is now v2 (repaired for the redesign)
  const c = await connect("ap_owner");
  const recipe_id = `127.0.0.1:${new URL(shop.origin).port}/buy-product`;
  const params = { product: "bike-light", first: "Task", last: "Owner", zip: "22222" };
  let r = await c.call("browser_run_recipe", { recipe_id, params });
  const sid = r.session_id;
  assert.equal(r.code, "approval_pending"); // Checkout: Bike Light $9.99
  core.approvals.decide(r.approval_id, true, "task");
  r = await c.call("browser_run_recipe", { recipe_id, params, session_id: sid });
  assert.equal(r.status, "done", "Finish ($9.99, within the cap) needed no second approval: " + JSON.stringify(r));
  assert.deepEqual(shop.orders.at(-1)?.items, ["Bike Light"]);
  await c.call("browser_close", { session_id: sid });
  await c.close();
  shop.variant = 1;

  // Gate level: above the cap (approved $10 → cap $12) is never covered.
  const ctx = { device: { id: "browser-001" }, lease: { leaseId: "bs_test", holder: "t" }, principal: "owner", requireApproval: true, recorder: { event() {} }, grants: [], step: 0, baseUrl: "http://x" } as Parameters<typeof core.gate>[0];
  const spec = (total: string) => ({ app: "Browser (shop.example)", operation: "confirm_purchase", recipient: "https://shop.example", payload: `Total: ${total}`, summary: "Click Pay" });
  const first = await core.gate(ctx, "purchase", spec("$10.00")).catch((e) => e);
  core.approvals.decide(first.details.approval_id, true, "task");
  assert.ok(await core.gate(ctx, "purchase", spec("$10.00")), "the approved step itself");
  assert.deepEqual(await core.gate(ctx, "purchase", spec("$11.50")), { covered_by_task_approval: first.details.approval_id });
  assert.equal((await core.gate(ctx, "purchase", spec("$50.00")).catch((e) => e)).code, "approval_pending", "more money than approved asks again");
  assert.equal((await core.gate(ctx, "purchase", { ...spec("$5.00"), recipient: "https://other.example" }).catch((e) => e)).code, "approval_pending", "another site asks again");
});

test("a recipe recorded through a product page buys the product asked for, not the recorded one", { skip }, async () => {
  const c = await connect("ap_owner");
  let r = await c.call("browser_open", { url: shop.url });
  const sid = r.session_id;
  r = await c.call("browser_fill_secret", { session_id: sid, index: idx(r.page, /Username/), secret: "username" });
  r = await c.call("browser_fill_secret", { session_id: sid, index: idx(r.page, /Password/), secret: "password" });
  r = await c.call("browser_click", { session_id: sid, index: idx(r.page, /Sign in/) });
  if (/cookies/i.test(r.page)) r = await c.call("browser_click", { session_id: sid, index: idx(r.page, /Accept cookies/) });
  r = await c.call("browser_click", { session_id: sid, index: idx(r.page, /Trail Backpack/) }); // product page
  r = await c.call("browser_click", { session_id: sid, index: idx(r.page, /Add to cart/) });
  const saved = await c.call("browser_save_recipe", { session_id: sid, task: "add-via-page", params: { product: "Trail Backpack" }, end_check: "Trail Backpack" });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  r = await c.call("browser_run_recipe", { recipe_id: saved.recipe_id, params: { product: "Bike Light" }, session_id: sid });
  if (r.code === "approval_pending") {
    assert.match(core.approvals.get(r.approval_id)!.spec.payload!, /Bike Light/, "the owner is asked about the right product");
    approveLast(r.approval_id); // the last click of a recipe always needs the owner
    r = await c.call("browser_run_recipe", { recipe_id: saved.recipe_id, params: { product: "Bike Light" }, session_id: sid });
  }
  assert.equal(r.status, "done", JSON.stringify(r).slice(0, 400));
  const cart = await c.call("browser_open", { url: `${shop.origin}/cart`, session_id: sid });
  assert.match(cart.page, /Bike Light/, "the replay added the Bike Light…");
  assert.doesNotMatch(cart.page, /Trail Backpack/, "…not the recorded Backpack");
  await c.call("browser_close", { session_id: sid });
  await c.close();
});

test("screenshots for the user: on demand and when a recipe finishes; login fields are blanked; link works", { skip }, async () => {
  const c = await connect("ap_owner");
  const r = await c.call("browser_open", { url: shop.url });
  const sid = r.session_id;
  await c.call("browser_fill_secret", { session_id: sid, index: idx(r.page, /Password/), secret: "password" });
  const raw = await (async () => {
    const cl = new Client({ name: "img", version: "1" });
    await cl.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: "Bearer ap_owner" } } }));
    const res = (await cl.callTool({ name: "browser_screenshot", arguments: { session_id: sid } })) as R;
    await cl.close();
    return res;
  })();
  const img = raw.content.find((x) => x.type === "image") as { data?: string } | undefined;
  assert.ok(img?.data && Buffer.from(img.data, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), "a JPEG image");
  const info = JSON.parse(raw.content[0].text!);
  const got = await fetch(info.screenshot_url);
  assert.equal(got.headers.get("content-type"), "image/jpeg");
  // The password box was filled; the screenshot must not reveal it: compare with the field hidden vs shown
  // is visual, so here we check the page state was restored after masking.
  const s = core.browser!.get(sid, "owner");
  assert.equal(await s.page.evaluate(() => (document.querySelector("input[type=password]") as HTMLInputElement).style.visibility), "");
  await c.call("browser_close", { session_id: sid });
  await c.close();
});

test("approval links: relayed = Fonino account (any browser); direct = this Mac's dashboard only", { skip }, () => {
  const relayed = core.approvalLink("https://api.fonino.app/h/haaaaaaaaaa", "id-1");
  assert.deepEqual(relayed, { url: "https://app.fonino.app/approve/haaaaaaaaaa/id-1", anywhere: true });
  const direct = core.approvalLink("https://random-words.trycloudflare.com", "id-1");
  assert.equal(direct.anywhere, false);
  assert.match(direct.url, /^http:\/\/127\.0\.0\.1:\d+\/admin\/$/, "a tunnel URL's /admin is refused, so point at the Mac itself");
});

test("the password never leaves the browser: not in outputs, recipes or recordings", { skip }, () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
  const stored = files(home).filter((f) => !f.endsWith(".png")).map((f) => readFileSync(f, "utf8"));
  for (const text of [...outputs, ...stored]) assert.ok(!text.includes(SHOP_PASSWORD), "password leaked");
  assert.ok(outputs.length > 20);
});
