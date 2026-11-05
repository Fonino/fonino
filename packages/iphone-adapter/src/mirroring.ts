// IPhoneMirroringAdapter: controls the iPhone that macOS's iPhone Mirroring app is
// showing. Screen capture via ScreenCaptureKit and input via CGEvents, both done by
// the native helper in native/agentphone-macos (see docs/iphone-control-research.md).
//
// Limits (tested, see docs): one mirrored iPhone per Mac; input drives the real Mac
// cursor/keyboard focus, so actions are serialized through a host-wide lock.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeviceAdapter, GetScreenOptions, PhoneDevice } from "@agentphone/device-core";
import { Mutex } from "@agentphone/device-core";
import type { DeviceInfo, DeviceStatus, ScreenState, SpecialKey, StatusCheck } from "@agentphone/shared";
import { DeviceError, sleep } from "@agentphone/shared";

export const MIRROR_DEVICE_ID = "iphone-mirror";

export function nativeBinPath(): string {
  return (
    process.env.AGENTPHONE_NATIVE_BIN ??
    fileURLToPath(new URL("../../../native/agentphone-macos/.build/release/agentphone-macos", import.meta.url))
  );
}

type NativeStatus = {
  running: boolean;
  screenCaptureAccess: boolean;
  accessibilityAccess: boolean;
  windowFound: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  frontmost?: boolean;
  /** false when the window shows an interstitial ("Timed Out", "iPhone in Use", ...). */
  sessionActive?: boolean;
  sessionState?: "active" | "auth_required" | "interrupted";
  message?: string;
};

/** Host-wide: the Mac has one cursor and one key window. */
const hostInput = new Mutex();

export function runNative<T = Record<string, unknown>>(args: string[], timeoutMs = 15000): Promise<T> {
  const bin = nativeBinPath();
  if (!existsSync(bin)) {
    return Promise.reject(
      new DeviceError("native_missing", `Native helper not built: ${bin}`, "Run `npm run build:native` (needs Xcode Command Line Tools)."),
    );
  }
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "");
      } catch {
        /* fallthrough */
      }
      if (parsed && parsed.ok !== false && !err) return resolve(parsed as T);
      const code = (parsed?.code as string) ?? "native_error";
      const msg = (parsed?.error as string) ?? (stderr || err?.message || "unknown native error");
      reject(new DeviceError(code, msg, FIXES[code]));
    });
  });
}

const FIXES: Record<string, string> = {
  no_window: "Open the iPhone Mirroring app and make sure it shows your iPhone (the phone must be locked and nearby).",
  no_screen_capture_permission:
    "System Settings → Privacy & Security → Screen Recording: enable the app that runs agentphone (Terminal/iTerm/your IDE), then restart it.",
  no_accessibility_permission:
    "System Settings → Privacy & Security → Accessibility: enable the app that runs agentphone, then restart it.",
};

class MirroredIPhone implements PhoneDevice {
  readonly id = MIRROR_DEVICE_ID;
  readonly adapter = "iphone-mirroring";
  readonly name: string;
  private readonly restoreFocus: boolean;

  constructor(name: string) {
    this.name = name;
    this.restoreFocus = process.env.AGENTPHONE_RESTORE_FOCUS !== "0";
  }

  /** Run an input command, auto-launching iPhone Mirroring once if its window is gone. */
  private input(args: string[]): Promise<void> {
    const full = [...args, ...(this.restoreFocus ? ["--restore-focus"] : [])];
    return hostInput.run(async () => {
      try {
        await runNative(full);
      } catch (e) {
        if ((e as DeviceError).code !== "no_window") throw e;
        await runNative(["launch"]);
        await sleep(1500);
        await runNative(full);
      }
    });
  }

  /** If mirroring was interrupted, press Connect / Try Again once and wait for it to resume. */
  /** Returns a host notice (e.g. auth required) to attach to the screen, if any. */
  private async ensureSession(): Promise<string | undefined> {
    const s = await runNative<NativeStatus>(["status"]);
    if (!s.windowFound) {
      await hostInput.run(() => runNative(["launch"]));
      await sleep(1500);
      return this.ensureSession();
    }
    if (s.sessionState === "auth_required") {
      // A locked iOS app asked for the Mac owner's Touch ID / password. Never answer it.
      return `AUTHENTICATION REQUIRED ON THE MAC: ${s.message ?? ""} Only the owner can do this; AgentPhone will not.`;
    }
    if (s.sessionActive === false) {
      try {
        await hostInput.run(() => runNative(["connect", "--timeout", "20"], 30000));
        await sleep(800);
      } catch (e) {
        throw new DeviceError(
          "mirroring_interrupted",
          `iPhone Mirroring is not showing the phone: ${s.message ?? "interrupted"} (${(e as Error).message})`,
          "Lock the iPhone (mirroring only works while it is locked), keep it near the Mac, then click Connect / Try Again in the iPhone Mirroring window.",
        );
      }
    }
  }

  async getScreen(opts: GetScreenOptions = {}): Promise<ScreenState> {
    const notice = await this.ensureSession();
    const out = opts.outPath ?? join(tmpdir(), `agentphone-${this.id}-${Date.now()}.png`);
    const r = await runNative<{ path: string; width: number; height: number; signature?: string }>(["screenshot", "--out", out, "--scale", "1"]);
    const bytes = readFileSync(r.path);
    return {
      deviceId: this.id,
      timestamp: new Date().toISOString(),
      width: r.width,
      height: r.height,
      screenshotPath: r.path,
      screenshotBase64: opts.includeBase64 ? bytes.toString("base64") : undefined,
      screenshotHash: createHash("sha256").update(bytes).digest("hex"),
      signature: r.signature,
      notice,
    };
  }

  tap(x: number, y: number) {
    return this.input(["tap", String(Math.round(x)), String(Math.round(y))]);
  }

  swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300) {
    return this.input(["swipe", ...[x1, y1, x2, y2].map((v) => String(Math.round(v))), "--duration", String(durationMs)]);
  }

  type(text: string) {
    return this.input(["type", text]);
  }

  key(key: SpecialKey) {
    return this.input(["key", key]);
  }

  home() {
    return this.input(["home"]);
  }

  appSwitcher() {
    return this.input(["app-switcher"]);
  }

  wait(ms: number) {
    return sleep(ms);
  }

  async getStatus(): Promise<DeviceStatus> {
    const s = await runNative<NativeStatus>(["status"]);
    const checks: StatusCheck[] = [
      { name: "iPhone Mirroring running", ok: s.running, fix: s.running ? undefined : "Open the iPhone Mirroring app." },
      { name: "mirroring window visible", ok: s.windowFound, fix: s.windowFound ? undefined : FIXES.no_window },
      {
        name: "mirroring session active",
        ok: s.sessionActive !== false,
        ...(s.sessionState === "auth_required" ? { fix: "iPhone Mirroring is waiting for your Touch ID / Mac password (a locked app was opened)." } : {}),
        detail: s.message,
        fix: s.sessionActive === false ? "Lock the iPhone and click Connect / Try Again in iPhone Mirroring (or run any agentphone action: it auto-reconnects)." : undefined,
      },
      { name: "Screen Recording permission", ok: s.screenCaptureAccess, fix: s.screenCaptureAccess ? undefined : FIXES.no_screen_capture_permission },
      { name: "Accessibility permission", ok: s.accessibilityAccess, fix: s.accessibilityAccess ? undefined : FIXES.no_accessibility_permission },
    ];
    const ok = checks.every((c) => c.ok);
    return {
      id: this.id,
      name: this.name,
      adapter: this.adapter,
      status: ok ? "connected" : s.running ? "unavailable" : "disconnected",
      width: s.bounds?.width,
      height: s.bounds?.height,
      capabilities: {
        screenshot: true, tap: true, swipe: true, type: true, home: true, appSwitcher: true,
        keys: ["return", "delete", "escape", "tab", "space", "up", "down", "left", "right"],
        usesHostInput: true,
      },
      checks,
    };
  }
}

export class IPhoneMirroringAdapter implements DeviceAdapter {
  readonly name = "iphone-mirroring";
  private device?: MirroredIPhone;

  private get deviceName() {
    return process.env.AGENTPHONE_MIRROR_NAME ?? "iPhone (via iPhone Mirroring)";
  }

  async listDevices(): Promise<DeviceInfo[]> {
    if (process.platform !== "darwin") return [];
    let s: NativeStatus;
    try {
      s = await runNative<NativeStatus>(["status"]);
    } catch (e) {
      return [{ id: MIRROR_DEVICE_ID, name: this.deviceName, adapter: this.name, status: "unavailable", detail: (e as Error).message }];
    }
    const missing = [
      !s.screenCaptureAccess && "Screen Recording permission",
      !s.accessibilityAccess && "Accessibility permission",
    ].filter(Boolean);
    const status =
      !s.running || !s.windowFound || s.sessionActive === false ? "disconnected" : missing.length ? "unavailable" : "connected";
    const detail = !s.running
      ? "iPhone Mirroring not running (will auto-launch on first action)"
      : !s.windowFound
        ? "iPhone Mirroring has no window"
        : s.sessionActive === false
          ? `mirroring interrupted: ${(s.message ?? "").replace(/\s+/g, " ").trim()}` +
            (s.sessionState === "auth_required"
              ? " (waiting for the owner's Touch ID / password)"
              : /in use/i.test(s.message ?? "")
                ? " (someone must dismiss what's on the phone and lock it)"
                : " (auto-reconnects on next action)")
          : missing.length
            ? `missing ${missing.join(", ")}`
            : undefined;
    return [{ id: MIRROR_DEVICE_ID, name: this.deviceName, adapter: this.name, status, detail }];
  }

  async getDevice(id: string): Promise<PhoneDevice> {
    if (id !== MIRROR_DEVICE_ID) throw new DeviceError("unknown_device", `iphone-mirroring has no device ${id}`);
    this.device ??= new MirroredIPhone(this.deviceName);
    return this.device;
  }
}
