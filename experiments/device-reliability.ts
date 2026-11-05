// Experiment: raw device-control reliability, no AI model involved.
// Repeats a harmless cycle (Home → Spotlight → type app name → Return → swipe → Home)
// and checks that every action visibly changed the screen.
//
//   node experiments/device-reliability.ts <device> [cycles=5] [app=Clock]

import { createDefaultRegistry } from "@agentphone/iphone-adapter";
import { screenChange, sleep, UNCHANGED_THRESHOLD, type ScreenState } from "@agentphone/shared";

const [deviceId = "iphone-001", cyclesArg = "5", app = "Clock", framesDir] = process.argv.slice(2);
let frame = 0;
const shot = () => dev.getScreen(framesDir ? { outPath: `${framesDir}/${String(++frame).padStart(2, "0")}.png` } : {});
const dev = await createDefaultRegistry().getDevice(deviceId);
const cycles = Number(cyclesArg);

type Row = { cycle: number; action: string; ms: number; changed: boolean; ratio: number };
const rows: Row[] = [];
let last: ScreenState = await dev.getScreen();
const { width: W, height: H } = await dev.getScreen();

async function step(cycle: number, action: string, fn: () => Promise<void>, expectChange = true) {
  const t = Date.now();
  await fn();
  const ms = Date.now() - t;
  await sleep(900);
  const now = await shot();
  const ratio = screenChange(last, now);
  const changed = ratio >= UNCHANGED_THRESHOLD;
  last = now;
  rows.push({ cycle, action, ms, ratio, changed: expectChange ? changed : true });
  console.log(`${cycle}  ${action.padEnd(28)} ${String(ms).padStart(5)}ms  ${(ratio * 100).toFixed(1).padStart(5)}% changed${changed ? "" : "  ← UNCHANGED"}`);
}

const started = Date.now();
await dev.home();
await sleep(800);
last = await dev.getScreen();
for (let c = 1; c <= cycles; c++) {
  await step(c, "swipe down → Spotlight", () => dev.swipe(W / 2, H * 0.35, W / 2, H * 0.62, 300));
  await step(c, `type "${app}"`, () => dev.type(app));
  await step(c, "key return (open top hit)", () => dev.key("return"));
  await step(c, "swipe up (scroll)", () => dev.swipe(W / 2, H * 0.7, W / 2, H * 0.35, 300), false);
  // Home from an app opened via Spotlight returns to Spotlight (observed on iOS 26); a second Home dismisses it.
  await step(c, "home ×2", async () => {
    await dev.home();
    await sleep(700);
    await dev.home();
  });
}
const failures = rows.filter((r) => !r.changed);
const avg = rows.reduce((a, r) => a + r.ms, 0) / rows.length;
console.log(
  `\n${rows.length} actions in ${((Date.now() - started) / 1000).toFixed(1)}s · ` +
    `${rows.length - failures.length}/${rows.length} produced the expected screen change · avg action latency ${avg.toFixed(0)}ms`,
);
process.exitCode = failures.length ? 1 : 0;
