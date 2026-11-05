// Test 9: can several physical iPhones be observed and controlled independently
// and concurrently from one Mac?
//
//   node experiments/multi-device.ts <deviceA> <deviceB> [cycles=5]
//
// 1. Independence: act on A only → A's screen changes, B's doesn't (and vice versa).
// 2. Concurrency: the same harmless action cycle on both phones, first one after the
//    other, then in parallel. Speedup ≈ 2x means the phones don't contend.

import { createDefaultRegistry } from "@agentphone/iphone-adapter";
import type { PhoneDevice } from "@agentphone/device-core";
import { screenChange, sleep } from "@agentphone/shared";

const [idA, idB, cyclesArg = "5"] = process.argv.slice(2);
if (!idA || !idB) {
  console.error("usage: node experiments/multi-device.ts <deviceA> <deviceB> [cycles]");
  process.exit(2);
}
const reg = createDefaultRegistry();
const A = await reg.getDevice(idA);
const B = await reg.getDevice(idB);
const cycles = Number(cyclesArg);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

console.log(`A = ${A.id} (${A.name}, ${A.adapter})\nB = ${B.id} (${B.name}, ${B.adapter})\n`);

// ---- 1. Independence ----
async function independence(actor: PhoneDevice, bystander: PhoneDevice) {
  await Promise.all([actor.home(), bystander.home()]);
  await sleep(1200);
  const [a0, b0] = await Promise.all([actor.getScreen(), bystander.getScreen()]);
  const { width: W, height: H } = a0;
  await actor.swipe(W * 0.85, H * 0.45, W * 0.15, H * 0.45, 300); // next Home Screen page
  await sleep(1200);
  const [a1, b1] = await Promise.all([actor.getScreen(), bystander.getScreen()]);
  const ok = screenChange(a0, a1) > 0.05 && screenChange(b0, b1) < 0.01;
  console.log(`act on ${actor.id}: ${actor.id} changed ${pct(screenChange(a0, a1))}, ${bystander.id} changed ${pct(screenChange(b0, b1))}  ${ok ? "✓ independent" : "✗"}`);
  await actor.home();
  return ok;
}
const indepOk = (await independence(A, B)) && (await independence(B, A));

// ---- 2. Concurrency ----
type Stat = { ops: number; errors: number; screenMs: number[]; actMs: number[] };
async function cycle(d: PhoneDevice, stat: Stat) {
  const time = async (arr: number[], fn: () => Promise<unknown>) => {
    const t = Date.now();
    try {
      await fn();
    } catch (e) {
      stat.errors++;
      console.log(`  ${d.id} error: ${(e as Error).message}`);
    }
    arr.push(Date.now() - t);
    stat.ops++;
  };
  const s = await d.getScreen();
  await time(stat.actMs, () => d.swipe(s.width * 0.85, s.height * 0.45, s.width * 0.15, s.height * 0.45, 300));
  await sleep(600);
  await time(stat.screenMs, () => d.getScreen());
  await time(stat.actMs, () => d.home());
  await sleep(600);
  await time(stat.screenMs, () => d.getScreen());
}
const run = async (d: PhoneDevice, stat: Stat) => {
  for (let i = 0; i < cycles; i++) await cycle(d, stat);
};
const newStat = (): Stat => ({ ops: 0, errors: 0, screenMs: [], actMs: [] });
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const seq = [newStat(), newStat()];
let t = Date.now();
await run(A, seq[0]);
await run(B, seq[1]);
const seqMs = Date.now() - t;

const par = [newStat(), newStat()];
t = Date.now();
await Promise.all([run(A, par[0]), run(B, par[1])]);
const parMs = Date.now() - t;

for (const [label, stats, ms] of [["sequential", seq, seqMs], ["parallel", par, parMs]] as const) {
  console.log(
    `${label.padEnd(10)} ${(ms / 1000).toFixed(1)}s total · ` +
      stats.map((s, i) => `${i ? B.id : A.id}: screenshot ${avg(s.screenMs).toFixed(0)}ms, action ${avg(s.actMs).toFixed(0)}ms, ${s.errors} errors`).join(" · "),
  );
}
const speedup = seqMs / parMs;
console.log(`\nindependent: ${indepOk ? "yes" : "NO"} · concurrency speedup ${speedup.toFixed(2)}x (2.0 = no contention)`);
process.exitCode = indepOk && speedup > 1.5 && [...seq, ...par].every((s) => s.errors === 0) ? 0 : 1;
