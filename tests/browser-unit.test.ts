// Agent browser: pure logic (no browser needed).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.AGENTPHONE_HOME = mkdtempSync(join(tmpdir(), "agentphone-bu-"));
const b = await import("@agentphone/browser");
type Recipe = import("@agentphone/browser").Recipe;

const step = (op: string, key: string, extra: Record<string, unknown> = {}) => ({
  op, path: "/p", target: { tag: op === "click" ? "button" : "input", attr: "data-test", key, label: key, secret: null, sensitiveAction: false }, ...extra,
}) as Recipe["steps"][number];
const recipe = (steps: Recipe["steps"], extra: Partial<Recipe> = {}): Recipe => ({
  id: "shop.example/buy", site: "https://shop.example", start: "https://shop.example/", task: "buy", version: 1, status: "approved",
  endCheck: "Thanks", params: [], steps, source: "recorded", riskReview: "rules", createdAt: new Date().toISOString(), ...extra,
});

test("templating: values become placeholders (longest first) and fill back", () => {
  assert.equal(b.tpl("Product 42 costs 42", { item: "Product 42", n: "42" }), "{item} costs {n}");
  assert.equal(b.fill("{item} for {who} {unknown}", { item: "Lamp", who: "Ada" }), "Lamp for Ada {unknown}");
  assert.equal(b.tpl("a b", { x: "a" }), "a b", "1-character values are never templated");
  assert.deepEqual(b.placeholders([step("type", "q", { text: "{product} x {zip}" })]), ["product", "zip"]);
  // Names also appear in ids/URLs in "slug" form.
  assert.equal(b.tpl("add-to-cart-sauce-labs-backpack", { product: "Sauce Labs Backpack" }), "add-to-cart-{product|slug}");
  assert.equal(b.fill("add-to-cart-{product|slug}", { product: "Sauce Labs Bike Light" }), "add-to-cart-sauce-labs-bike-light");
  assert.equal(b.tpl("Adam and Ada", { first: "Ada" }), "Adam and {first}", "whole words only");
  assert.deepEqual(b.placeholders([step("click", "add-{product|slug}")]), ["product"]);
});

test("replay finds a templated link by its text when its id doesn't carry the value", () => {
  const recorded = { ...step("click", "item-4-title-link"), target: { tag: "a", attr: "data-test", key: "item-4-title-link", label: "{product}", secret: null, sensitiveAction: false } } as Recipe["steps"][number];
  assert.deepEqual(b.locator(recorded, { product: "Sauce Labs Bike Light" }), { tag: "a", attr: "text", key: "Sauce Labs Bike Light" });
  const byId = { ...step("click", "add-to-cart-{product|slug}") } as Recipe["steps"][number];
  assert.equal(b.locator(byId, { product: "Bike Light" }).key, "add-to-cart-bike-light", "ids that carry the value keep using the id");
});

test("format check rejects unknown ops, outside addresses, extra fields and stray secrets", () => {
  assert.deepEqual(b.validateFormat(recipe([step("click", "go")])), []);
  const bad = recipe([
    { ...step("click", "go"), op: "goto" as never },
    { ...step("type", "q"), text: "https://evil.example/?d={zip}" },
    { ...step("click", "x"), url: "x" } as never,
    { ...step("type", "q"), secret: "password" } as never,
    { ...step("fill_secret", "pw"), secret: "pin" as never },
    { ...step("click", "y"), path: "//evil.example/" },
  ]);
  const p = b.validateFormat(bad).join("\n");
  for (const want of ['unknown step type "goto"', "outside web address", "unexpected fields url", "only fill_secret steps may use secrets", 'unknown secret "pin"', "path must be on the recipe's own site"]) {
    assert.match(p, new RegExp(want.replace(/[()"]/g, ".")), want);
  }
});

test("risk rules: keyword on buttons, never on links; final click always; flags only added", () => {
  const r = recipe([
    { ...step("click", "bill-pay"), target: { tag: "a", attr: "text", key: "Bill Pay", label: "Bill Pay", secret: null, sensitiveAction: false } },
    step("click", "Checkout"),
    step("type", "zip"),
    step("click", "Confirm"),
  ]);
  const added = b.classifyRiskRules(r);
  assert.deepEqual(added, [1, 3]);
  assert.equal(r.steps[0].target.sensitiveAction, false, "a menu link saying 'Pay' is navigation");
  assert.match(r.steps[3].target.riskReasons!.join(), /final step/);
  assert.deepEqual(b.classifyRiskRules(r), [], "re-running adds nothing new and removes nothing");
  assert.equal(b.riskOf("Delete account"), "destructive");
  assert.equal(b.riskOf("Send message"), "external_communication");
  assert.equal(b.riskOf("Send payment"), "purchase");
  assert.equal(b.riskOf("Place order"), "purchase");
});

test("import check: stored risk labels are ignored and re-derived; imports never come in approved", async () => {
  const poisoned = recipe([step("click", "Checkout"), step("click", "Finish")]); // labels stripped by an attacker
  const res = await b.importCheck(poisoned, "buy a lamp", null);
  assert.equal(res.recipe.status, "needs_review");
  assert.deepEqual(res.riskAdded, [0, 1]);
  const bad = await b.importCheck(recipe([{ ...step("click", "x"), op: "goto" as never }]), "buy", null);
  assert.equal(bad.recipe.status, "rejected");
});

test("recipe store: versions are never overwritten; only approved versions run", () => {
  const store = new b.RecipeStore(mkdtempSync(join(tmpdir(), "recipes-")));
  const v1 = store.save(recipe([step("click", "go")]));
  const v2 = store.save({ ...v1, status: "needs_review" });
  assert.deepEqual([v1.version, v2.version], [1, 2]);
  assert.equal(store.latestApproved(v1.id)!.version, 1);
  store.setStatus(v1.id, 2, "approved", "owner");
  assert.equal(store.latestApproved(v1.id)!.version, 2);
  assert.equal(store.list().length, 1);
  assert.throws(() => store.get("../../etc/passwd"), /Not a recipe id/);
});

test("vault: secrets are bound to the exact origin", () => {
  const v = new b.MemoryVault().set("https://www.shop.example", "password", "s3cret!");
  assert.equal(v.get("https://www.shop.example", "password"), "s3cret!");
  assert.throws(() => v.get("https://www.shop.example.evil.example", "password"), /No saved password/);
  assert.throws(() => v.get("http://www.shop.example", "password"), /No saved password/);
  assert.equal(b.normalizeOrigin("shop.example/login?x=1"), "https://shop.example");
});

test("network guard: local and private addresses are refused", async () => {
  for (const url of ["http://127.0.0.1:3001/admin/", "http://localhost/", "http://192.168.1.1/", "http://10.0.0.5/", "http://169.254.169.254/latest", "http://[::1]/", "http://router.local/", "file:///etc/passwd", "http://user:pw@example.com/"]) {
    await assert.rejects(b.assertAllowedUrl(url), /local or private|Only http|credentials|resolve/, url);
  }
  assert.equal(b.isPrivateIp("::ffff:10.1.2.3"), true);
  assert.equal(b.isPrivateIp("93.184.216.34"), false);
  assert.equal((await b.assertAllowedUrl("http://127.0.0.1:1/", { allowPrivate: true })).port, "1");
});

test("leak redaction", () => {
  assert.equal(b.redactSecrets("Welcome ab12cd, your pw is pw-xyz", ["ab12cd", "pw-xyz"]), "Welcome [secret], your pw is [secret]");
});
