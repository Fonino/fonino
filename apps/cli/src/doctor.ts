// `fonino doctor`: diagnose the setup, with an actionable fix for every failure.

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { arch, release } from "node:os";
import type { DeviceRegistry } from "@agentphone/device-core";
import { listMuxDevices, nativeBinPath, runNative } from "@agentphone/iphone-adapter";
import { screenChange, sleep, UNCHANGED_THRESHOLD } from "@agentphone/shared";

type Check = { ok: boolean | "warn" | "skip"; name: string; detail?: string; fix?: string };

const sh = (cmd: string, a: string[]) => {
  try {
    return execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
};

export async function runDoctor(registry: DeviceRegistry, opts: { input: boolean }): Promise<boolean> {
  const checks: Check[] = [];
  const add = (c: Check) => {
    checks.push(c);
    const icon = c.ok === true ? "\x1b[32m✓\x1b[0m" : c.ok === "warn" ? "\x1b[33m!\x1b[0m" : c.ok === "skip" ? "\x1b[2m–\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`${icon} ${c.name}${c.detail ? `\x1b[2m  ${c.detail}\x1b[0m` : ""}`);
    if (c.ok !== true && c.fix) console.log(`    → ${c.fix}`);
  };

  // --- Host ---
  const macos = sh("sw_vers", ["-productVersion"]);
  const major = Number(macos?.split(".")[0] ?? 0);
  add({
    ok: process.platform === "darwin" && major >= 15,
    name: "macOS supported",
    detail: macos ? `macOS ${macos} (${arch()})` : `${process.platform} ${release()}`,
    fix: "iPhone Mirroring needs macOS 15 Sequoia or later on Apple silicon (or an Intel Mac with T2).",
  });
  const nodeOk = Number(process.versions.node.split(".")[0]) > 22 || (process.versions.node.startsWith("22.") && Number(process.versions.node.split(".")[1]) >= 18);
  add({ ok: nodeOk, name: "Node.js ≥ 22.18", detail: process.versions.node, fix: "Install Node 22.18+ (runs TypeScript natively)." });

  const clt = sh("xcode-select", ["-p"]);
  add({ ok: !!clt, name: "Xcode Command Line Tools", detail: clt, fix: "xcode-select --install" });
  const xcode = sh("xcodebuild", ["-version"])?.split("\n")[0];
  add({
    ok: xcode ? true : "warn",
    name: "Xcode (only for the WebDriverAgent / multi-phone adapter)",
    detail: xcode ?? "not installed",
    fix: "Install Xcode from the App Store, then: sudo xcode-select -s /Applications/Xcode.app && scripts/wda.sh setup",
  });

  const bin = nativeBinPath();
  const built = existsSync(bin);
  add({ ok: built, name: "native helper built", detail: built ? bin.replace(process.cwd() + "/", "") : undefined, fix: "npm run build:native" });

  add({
    ok: process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? true : "warn",
    name: "model credentials (for `fonino agent`)",
    detail: process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY set" : "ANTHROPIC_API_KEY not set",
    fix: "export ANTHROPIC_API_KEY=sk-ant-...",
  });

  // --- iPhone Mirroring path ---
  console.log("\n\x1b[1miPhone Mirroring adapter\x1b[0m");
  let mirrorConnected = false;
  if (built) {
    try {
      const s = await runNative<{
        running: boolean; windowFound: boolean; screenCaptureAccess: boolean; accessibilityAccess: boolean;
        bounds?: { width: number; height: number };
      }>(["status"]);
      add({ ok: s.screenCaptureAccess, name: "Screen Recording permission", fix: "System Settings → Privacy & Security → Screen Recording → enable your terminal app, then restart it." });
      add({ ok: s.accessibilityAccess, name: "Accessibility permission (input)", fix: "System Settings → Privacy & Security → Accessibility → enable your terminal app, then restart it." });
      add({ ok: s.running, name: "iPhone Mirroring running", fix: "open -a 'iPhone Mirroring'  (first time: follow its setup; iPhone must be on iOS 18+, same Apple Account, nearby, locked)" });
      add({
        ok: s.windowFound,
        name: "iPhone detected (mirroring window)",
        detail: s.bounds ? `${s.bounds.width}x${s.bounds.height} pt` : undefined,
        fix: "Open iPhone Mirroring and connect. If it says 'iPhone in Use', lock the phone and click Try Again.",
      });
      mirrorConnected = s.running && s.windowFound && s.screenCaptureAccess && s.accessibilityAccess;
    } catch (e) {
      add({ ok: false, name: "native helper runs", detail: (e as Error).message });
    }
  }

  if (mirrorConnected) {
    const dev = await registry.getDevice("iphone-mirror");
    let before;
    try {
      before = await dev.getScreen();
      const size = statSync(before.screenshotPath!).size;
      // A blank/black frame compresses to almost nothing.
      add({
        ok: size > 20_000 ? true : "warn",
        name: "screen capture working",
        detail: `${before.width}x${before.height}, ${(size / 1024).toFixed(0)} KB`,
        fix: "The capture looks blank — is the phone showing 'iPhone in Use' or a connection error in the mirroring window?",
      });
    } catch (e) {
      add({ ok: false, name: "screen capture working", detail: (e as Error).message });
    }
    if (opts.input && before) {
      // Open Spotlight, check the screen changed, then go back Home.
      await dev.home();
      await sleep(800);
      const home = await dev.getScreen();
      await dev.swipe(home.width / 2, home.height * 0.35, home.width / 2, home.height * 0.6, 300);
      await sleep(900);
      const after = await dev.getScreen();
      await dev.home();
      add({
        ok: screenChange(home, after) >= UNCHANGED_THRESHOLD,
        name: "input working",
        detail: `home → pull-down Spotlight → home (${(screenChange(home, after) * 100).toFixed(1)}% of screen changed)`,
        fix: "Input events didn't change the screen. Check Accessibility permission, and that no other window covers iPhone Mirroring.",
      });
    } else {
      add({ ok: "skip", name: "input working", detail: "run `fonino doctor --input` (presses Home and opens Spotlight on the phone)" });
    }
  }

  // --- USB / WebDriverAgent path ---
  console.log("\n\x1b[1mUSB / WebDriverAgent adapter\x1b[0m");
  const mux = await listMuxDevices().catch((e) => {
    add({ ok: false, name: "usbmuxd reachable", detail: (e as Error).message });
    return [];
  });
  add({
    ok: mux.length ? true : "warn",
    name: "iPhones attached via USB/Wi-Fi (usbmuxd)",
    detail: mux.length ? mux.map((d) => `${d.udid} (${d.connectionType})`).join(", ") : "none",
    fix: "Connect the iPhone with a cable, unlock it and tap 'Trust This Computer'.",
  });
  if (mux.length) {
    const devices = (await registry.listDevices()).filter((d) => d.adapter === "iphone-wda");
    for (const d of devices) {
      add({
        ok: d.status === "connected" ? true : "warn",
        name: `WebDriverAgent on ${d.name} (${d.id})`,
        detail: d.detail,
        fix: `Enable Developer Mode (Settings → Privacy & Security → Developer Mode), then scripts/wda.sh start ${d.nativeId}`,
      });
    }
  }

  const failed = checks.filter((c) => c.ok === false).length;
  const connected = (await registry.listDevices()).filter((d) => d.status === "connected");
  console.log(
    `\n${connected.length ? `\x1b[32m${connected.length} controllable device(s): ${connected.map((d) => d.id).join(", ")}\x1b[0m` : "\x1b[31mNo controllable devices.\x1b[0m"}` +
      (failed ? `  ·  ${failed} check(s) failed` : ""),
  );
  return connected.length > 0;
}
