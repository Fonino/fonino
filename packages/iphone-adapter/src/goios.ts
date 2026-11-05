// go-ios (vendor/go-ios, MIT): drives the iPhone's developer services without Xcode or sudo.
// Fonino for Mac uses it to start the helper (WebDriverAgent), so customers never install Xcode.
//
// iOS 17+ needs a tunnel to the phone; `ios tunnel start --userspace` runs one without root.
// Every command talks to that tunnel through its info API on TUNNEL_INFO_PORT.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TUNNEL_INFO_PORT = Number(process.env.AGENTPHONE_GOIOS_TUNNEL_PORT ?? 28100);

/** The go-ios binary: AGENTPHONE_GOIOS, else the copy shipped with Fonino. */
export function goiosPath(): string | undefined {
  const p = process.env.AGENTPHONE_GOIOS ?? fileURLToPath(new URL("../../../vendor/go-ios/ios", import.meta.url));
  return existsSync(p) ? p : undefined;
}

/** Use go-ios instead of xcodebuild: AGENTPHONE_RUNNER=goios, or automatically when Xcode is missing. */
export function useGoios(hasXcode: boolean): boolean {
  const r = process.env.AGENTPHONE_RUNNER;
  if (r === "xcode") return false;
  if (r === "goios") return true;
  return !hasXcode && !!goiosPath();
}

const common = () => ["--nojson", `--tunnel-info-port=${TUNNEL_INFO_PORT}`];

/** Runs one go-ios command; resolves stdout (stderr carries go-ios's logs). */
export function goios(args: string[], timeout = 30_000): Promise<string> {
  const bin = goiosPath();
  if (!bin) return Promise.reject(new Error("go-ios not found"));
  return new Promise((resolve, reject) => {
    execFile(bin, [...args, ...common()], { timeout, maxBuffer: 10_000_000, env: { ...process.env, ENABLE_GO_IOS_AGENT: "" } }, (err, stdout, stderr) =>
      err ? reject(new Error(`${err.message}\n${stderr}`.trim())) : resolve(stdout),
    );
  });
}

/** Keeps one userspace tunnel running (it serves every plugged-in phone). */
export class GoiosTunnel {
  private child?: ChildProcess;

  async ensure(): Promise<void> {
    if (this.child && this.child.exitCode === null) return;
    if (await this.up()) return; // already running (another Fonino process, or left over)
    const bin = goiosPath();
    if (!bin) throw new Error("go-ios not found");
    this.child = spawn(bin, ["tunnel", "start", "--userspace", ...common()], { stdio: "ignore" });
    this.child.on("exit", () => (this.child = undefined));
  }

  /** True when the tunnel's info API answers. */
  async up(): Promise<boolean> {
    try {
      const r = await fetch(`http://127.0.0.1:${TUNNEL_INFO_PORT}/tunnels`, { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** True once the tunnel lists this phone. */
  async ready(udid: string): Promise<boolean> {
    try {
      const r = await fetch(`http://127.0.0.1:${TUNNEL_INFO_PORT}/tunnels`, { signal: AbortSignal.timeout(2000) });
      const list = (await r.json()) as Array<{ udid?: string }>;
      return list.some((t) => t.udid === udid);
    } catch {
      return false;
    }
  }

  stop() {
    this.child?.kill();
  }
}

/** Bundle id of the helper Fonino signs (App ID app.fonino.* on Fonino's Apple account). */
export const FONINO_HELPER = "app.fonino.helper.xctrunner";

/** Bundle id of the installed helper (the WebDriverAgent test runner), if any. */
export async function helperBundleId(udid: string): Promise<string | undefined> {
  const out = await goios(["apps", "--list", `--udid=${udid}`]).catch(() => "");
  const ids = out.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((id) => /\.xctrunner$/.test(id ?? ""));
  return ids.find((id) => id === FONINO_HELPER) ?? ids[0]; // the Fonino-signed helper over an older Xcode-built one
}

/** Arguments for `ios runwda`: the helper listens on the phone's loopback only (see wda-supervisor). */
export function runwdaArgs(udid: string, bundleId: string, lan: boolean): string[] {
  return [
    "runwda", `--udid=${udid}`, `--bundleid=${bundleId}`, `--testrunnerbundleid=${bundleId}`, "--xctestconfig=WebDriverAgentRunner.xctest",
    ...(lan ? [] : ["--env=TEST_RUNNER_USE_IP=127.0.0.1"]), ...common(),
  ];
}

/** Developer Mode: "enabled" | "disabled" | undefined (unknown). */
export async function devModeStatus(udid: string): Promise<"enabled" | "disabled" | undefined> {
  const out = await goios(["devmode", "get", `--udid=${udid}`]).catch(() => "");
  if (/true/i.test(out)) return "enabled";
  if (/false/i.test(out)) return "disabled";
  return undefined;
}

/** Makes the Developer Mode switch appear in the iPhone's Settings (it's hidden until a developer tool asks). */
export function revealDevMode(udid: string): Promise<string> {
  return goios(["devmode", "reveal", `--udid=${udid}`]);
}

/** Mounts the developer disk image the phone needs for the helper (no-op if already mounted). */
export function mountDeveloperImage(udid: string, dir: string): Promise<string> {
  return goios(["image", "auto", `--udid=${udid}`, `--basedir=${dir}`], 300_000);
}
