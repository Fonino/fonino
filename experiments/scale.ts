// Scale test: how does one Mac behave as more phones run at once?
//
//   node experiments/scale.ts [seconds-per-step=30]
//
// Uses every `connected` WebDriverAgent phone. For k = 1..N it drives the first k
// phones concurrently for a fixed window (screenshot → Home → screenshot, looped),
// recording per-op latency, errors and throughput, while sampling host CPU/RAM of
// the device stack (xcodebuild, testmanagerd, CoreDevice, usbmuxd, our node).
// Writes runs/scale-<timestamp>.json and prints a per-phone cost extrapolation.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { defaultRunsDir } from "@agentphone/agent-runtime";
import type { PhoneDevice } from "@agentphone/device-core";
import { createDefaultRegistry } from "@agentphone/iphone-adapter";
import { sleep } from "@agentphone/shared";

const windowSec = Number(process.argv[2] ?? 30);
const reg = createDefaultRegistry();
const all = (await reg.listDevices()).filter((d) => d.adapter === "iphone-wda");
for (const d of all.filter((x) => x.status !== "connected")) console.log(`skipping ${d.id}: ${d.detail}`);
const ids = all.filter((d) => d.status === "connected").map((d) => d.id);
if (!ids.length) {
  console.error("No usable WebDriverAgent phones (connected and unlocked). Run `agentphone wda up` first.");
  process.exit(1);
}
const devices: PhoneDevice[] = [];
for (const id of ids) devices.push(await reg.getDevice(id));
console.log(`${devices.length} phone(s): ${devices.map((d) => d.id).join(", ")} · ${windowSec}s per step\n`);

const STACK = /xcodebuild|testmanagerd|CoreDeviceService|remotepairingd|usbmuxd|node/;
type HostSample = { cpuPct: number; rssMB: number; xcodebuildRssMB: number; xcodebuilds: number; load1: number; freeMB: number };
function sampleHost(): HostSample {
  const out = execFileSync("ps", ["-axo", "rss=,%cpu=,comm="], { encoding: "utf8" });
  let cpuPct = 0, rssMB = 0, xcodebuildRssMB = 0, xcodebuilds = 0;
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.*)$/);
    if (!m || !STACK.test(m[3])) continue;
    const rss = Number(m[1]) / 1024;
    cpuPct += Number(m[2]);
    rssMB += rss;
    if (m[3].endsWith("xcodebuild")) {
      xcodebuildRssMB += rss;
      xcodebuilds++;
    }
  }
  return { cpuPct, rssMB, xcodebuildRssMB, xcodebuilds, load1: loadavg()[0], freeMB: freemem() / 2 ** 20 };
}

const pctl = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

type StepResult = {
  phones: number;
  ops: number;
  errors: number;
  opsPerSec: number;
  screenshotP50: number;
  screenshotP95: number;
  actionP50: number;
  actionP95: number;
  host: { cpuPctAvg: number; cpuPctMax: number; rssMBAvg: number; xcodebuildRssMB: number; load1Max: number; freeMBMin: number };
};

async function driveFor(d: PhoneDevice, untilMs: number, lat: { shot: number[]; act: number[] }, err: { n: number; first?: string }) {
  let ops = 0;
  // Stop early on a high error rate: failing ops are fast and would poison the latency numbers.
  while (Date.now() < untilMs && !(ops >= 10 && err.n / ops > 0.2)) {
    for (const [arr, fn] of [
      [lat.shot, () => d.getScreen()],
      [lat.act, () => d.home()],
    ] as const) {
      const t = Date.now();
      try {
        await fn();
      } catch (e) {
        err.n++;
        err.first ??= `${d.id}: ${(e as Error).message}`;
        continue; // don't record the latency of a failed op
      }
      arr.push(Date.now() - t);
      ops++;
    }
  }
  return ops;
}

const results: StepResult[] = [];
for (let k = 1; k <= devices.length; k++) {
  const active = devices.slice(0, k);
  const lat = { shot: [] as number[], act: [] as number[] };
  const err: { n: number; first?: string } = { n: 0 };
  const samples: HostSample[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      samples.push(sampleHost());
      await sleep(2000);
    }
  })();
  const t0 = Date.now();
  const opsPer = await Promise.all(active.map((d) => driveFor(d, t0 + windowSec * 1000, lat, err)));
  sampling = false;
  await sampler;
  const secs = (Date.now() - t0) / 1000;
  const ops = opsPer.reduce((a, b) => a + b, 0);
  const avg = (f: (s: HostSample) => number) => samples.reduce((a, s) => a + f(s), 0) / Math.max(1, samples.length);
  const r: StepResult = {
    phones: k,
    ops,
    errors: err.n,
    opsPerSec: ops / secs,
    screenshotP50: pctl(lat.shot, 50),
    screenshotP95: pctl(lat.shot, 95),
    actionP50: pctl(lat.act, 50),
    actionP95: pctl(lat.act, 95),
    host: {
      cpuPctAvg: avg((s) => s.cpuPct),
      cpuPctMax: Math.max(...samples.map((s) => s.cpuPct)),
      rssMBAvg: avg((s) => s.rssMB),
      xcodebuildRssMB: avg((s) => s.xcodebuildRssMB),
      load1Max: Math.max(...samples.map((s) => s.load1)),
      freeMBMin: Math.min(...samples.map((s) => s.freeMB)),
    },
  };
  results.push(r);
  if (err.first) console.log(`  ! ${err.n} errors, first: ${err.first}`);
  console.log(
    `${k} phone(s): ${r.opsPerSec.toFixed(2)} ops/s · screenshot p50 ${r.screenshotP50}ms p95 ${r.screenshotP95}ms · ` +
      `action p50 ${r.actionP50}ms p95 ${r.actionP95}ms · ${r.errors} errors · ` +
      `stack CPU avg ${r.host.cpuPctAvg.toFixed(0)}% (max ${r.host.cpuPctMax.toFixed(0)}%) · stack RAM ${r.host.rssMBAvg.toFixed(0)} MB`,
  );
}

// Per-phone cost. CPU: marginal between the 1-phone and N-phone steps (the idle WDA of
// every attached phone is present in both, so the difference is the cost of driving one).
// RAM: every attached phone keeps an xcodebuild host alive whether driven or not, so use
// the measured xcodebuild RSS per phone plus the RAM marginal.
const first = results[0];
const last = results[results.length - 1];
const n = last.phones - first.phones;
const perPhoneCpu = n ? (last.host.cpuPctAvg - first.host.cpuPctAvg) / n : first.host.cpuPctAvg;
const hostSample = sampleHost();
const idleHostRamPerPhone = hostSample.xcodebuilds ? hostSample.xcodebuildRssMB / hostSample.xcodebuilds : 0;
const perPhoneRam = idleHostRamPerPhone + Math.max(0, n ? (last.host.rssMBAvg - first.host.rssMBAvg) / n : 0);
const cores = cpus().length;
const cpuBudget = cores * 100 * 0.6; // leave 40% headroom
const ramBudgetMB = (totalmem() / 2 ** 20) * 0.6;
const summary = {
  host: { cores, totalRamGB: +(totalmem() / 2 ** 30).toFixed(1) },
  perActivePhone: { cpuPct: +perPhoneCpu.toFixed(1), ramMB: +perPhoneRam.toFixed(0), idleXcodebuildRamMB: +idleHostRamPerPhone.toFixed(0) },
  valid: results.every((r) => r.errors === 0),
  extrapolatedMaxPhones: {
    byCpu: perPhoneCpu > 0 ? Math.floor(cpuBudget / perPhoneCpu) : null,
    byRam: perPhoneRam > 0 ? Math.floor(ramBudgetMB / perPhoneRam) : null,
    note: "Linear extrapolation from a small N with 40% headroom; ignores USB power/topology and xcodebuild stability.",
  },
};
console.log(
  (summary.valid ? "" : "\n⚠ Some steps had errors — treat the numbers below as unreliable.") +
  `\nPer active phone: ~${summary.perActivePhone.cpuPct}% CPU (marginal), ~${summary.perActivePhone.ramMB} MB RAM (xcodebuild host ${summary.perActivePhone.idleXcodebuildRamMB} MB + marginal)` +
    `\nThis Mac (${cores} cores, ${summary.host.totalRamGB} GB): extrapolated ~${summary.extrapolatedMaxPhones.byCpu ?? "∞"} phones by CPU, ` +
    `~${summary.extrapolatedMaxPhones.byRam ?? "∞"} by RAM — EXTRAPOLATION from ${last.phones} phone(s), not measured.`,
);
const dir = defaultRunsDir();
mkdirSync(dir, { recursive: true });
const out = join(dir, `scale-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify({ windowSec, devices: ids, results, summary }, null, 2));
console.log(`\nSaved ${out}`);
