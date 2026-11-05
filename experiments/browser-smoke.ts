// Dev smoke test for @agentphone/browser against the local fixture shop (no network, no AI).
// Usage: node experiments/browser-smoke.ts   (ENGINE=lightpanda to try Lightpanda)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENTPHONE_HOME = mkdtempSync(join(tmpdir(), "ap-smoke-"));
const { BrowserService, MemoryVault, ReplayRun, recipeFromTrace } = await import("@agentphone/browser");
type Op = import("@agentphone/browser").Op;
const { startShop, SHOP_USER, SHOP_PASSWORD } = await import("../tests/fixtures/shop.ts");

const shop = await startShop();
const vault = new MemoryVault().set(shop.origin, "username", SHOP_USER).set(shop.origin, "password", SHOP_PASSWORD);
const engine = (process.env.ENGINE === "lightpanda" ? "lightpanda" : "chrome") as "chrome" | "lightpanda";
const svc = new BrowserService({ vault, ai: null, guard: { allowPrivate: true }, engine: { kind: engine }, runsDir: mkdtempSync(join(tmpdir(), "ap-runs-")) });

const s = await svc.open({ principalId: "owner", holder: "smoke" });
let snap = await (async () => (await s.goto(shop.url), s.snapshot()))();
const idx = (re: RegExp) => {
  const line = snap.text.split("\n").find((x) => /^\[\d+\]/.test(x) && re.test(x));
  if (!line) throw new Error(`no element matching ${re} in:\n${snap.text}`);
  return Number(line.match(/^\[(\d+)\]/)![1]);
};
async function act(op: Op, re: RegExp, extra: { text?: string; secret?: "username" | "password" } = {}) {
  const origin = s.origin();
  const { step, agentId } = await s.stepFor(op, idx(re), extra);
  await s.perform(step, {}, { agentId });
  s.recordStep(step, origin);
  snap = await s.snapshot();
  return step;
}

// 1. Record
let t0 = Date.now();
await act("fill_secret", /Username/, { secret: "username" });
await act("fill_secret", /Password/, { secret: "password" });
await act("click", /Sign in/);
await act("click", /add-to-cart-backpack/);
await act("click", /Cart \(1\)/);
await act("click", /Checkout/);
await act("type", /First name/, { text: "Ada" });
await act("type", /Last name/, { text: "Lovelace" });
await act("type", /Zip/, { text: "94016" });
await act("click", /Continue/);
console.log("overview snapshot:\n" + snap.text);
await act("click", /Finish/);
console.log(`recorded in ${Date.now() - t0} ms; order:`, JSON.stringify(shop.orders.at(-1)));
const recipe = svc.recipes.save(await recipeFromTrace(s, { task: "buy-product", params: { product: "backpack", first: "Ada", last: "Lovelace", zip: "94016" }, endCheck: "Thank you for your order" }, null));
console.log(`saved ${recipe.id} v${recipe.version} params=${recipe.params} risky=${recipe.steps.filter((x) => x.target.sensitiveAction).map((x) => `${x.target.label} (${x.target.riskReasons})`).join("; ")}`);

// 2. Replay with other values; approvals answered automatically here.
async function replay(params: Record<string, string>, fixer?: (want: string) => [Op, RegExp, "replace" | "extra_step"]) {
  const run = new ReplayRun(s, svc.recipes.latestApproved(recipe.id)!, params);
  t0 = Date.now();
  for (;;) {
    const a = await run.advance();
    if (a.kind === "needs_approval") {
      console.log(`  approval: ${a.label} [${a.risk}] ${a.summary.replace(/\n/g, " | ")}`);
      run.approveCurrent();
    } else if (a.kind === "needs_repair") {
      console.log(`  repair needed: ${a.want}`);
      snap = await s.snapshot();
      const [op, re, kind] = fixer!(a.want);
      const { step, agentId } = await s.stepFor(op, idx(re));
      const fix = run.prepareFix(step);
      if (fix.target.sensitiveAction) console.log(`  approval (repaired step): ${fix.target.label} — ${fix.target.riskReasons}`);
      console.log(`  -> ${await run.applyFix(fix, agentId, kind)}: ${op} ${fix.target.attr}=${fix.target.key}`);
    } else if (a.kind === "failed") {
      console.log("  FAILED", a.error.code, a.error.message);
      return;
    } else {
      console.log(`  done ok=${a.ok} in ${a.ms} ms; next version: ${a.next ? `${a.next.status} (${a.next.changes!.map((c) => `${c.kind} ${c.from ? c.from.target.key + "->" : ""}${c.step.target.key}`).join(", ")})` : "none"}`);
      if (a.next) svc.recipes.save(a.next);
      return;
    }
  }
}
console.log("replay (bike-light, Grace Hopper):");
await replay({ product: "bike-light", first: "Grace", last: "Hopper", zip: "10001" });
console.log("order:", JSON.stringify(shop.orders.at(-1)));

// 3. The shop is redesigned: cookie page, renamed add button, Finish -> Confirm.
shop.variant = 2;
console.log("replay after redesign (scripted repairs):");
await replay({ product: "onesie", first: "Alan", last: "Turing", zip: "02139" }, (want) =>
  /cookie/i.test(snap.text) ? ["click", /Accept cookies/, "extra_step"]
  : /add-to-cart/.test(want) ? ["click", /add-to-basket-onesie/, "replace"]
  : ["click", /Confirm/, "replace"],
);
console.log("order:", JSON.stringify(shop.orders.at(-1)));
console.log("versions:", svc.recipes.versions(recipe.id), "latest status:", svc.recipes.get(recipe.id).status);
console.log("password in any output?", JSON.stringify(svc.recipes.list()).includes(SHOP_PASSWORD) || snap.text.includes(SHOP_PASSWORD));
await svc.closeAll();
await shop.close();
