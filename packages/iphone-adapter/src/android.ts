// Android phones over adb: a phone with USB (or Wi-Fi) debugging on, or an emulator. Nothing to
// install on the phone: screenshots come from `screencap`, input from `input`, the UI tree from
// `uiautomator dump`, and texts go through the default SMS app with every step verified before
// Send is pressed, exactly once.
//
// Coordinates are density-independent pixels (dp), like iPhone points: screenshots are resampled
// to dp, so a screenshot pixel is a tap coordinate, and taps are scaled back to device pixels.
//
// Observed on Android 16 (emulator, Google Messages):
// * `am start -a android.intent.action.SENDTO -d sms:<to> --es sms_body <text>` opens the
//   conversation with the text in the compose field (resource-id …/compose_message_text).
// * The header shows the number ("(628) 555-0142") or the contact name; Send is the clickable
//   node with resource-id "Compose:Draft:Send" (child content-desc "Send SMS" / "Send message").
// * `content query --uri content://sms` lists the SMS history (type 1 = received, 2 = sent,
//   4/6 = sending, 5 = failed). RCS chats aren't there; the UI fallback reads the bubbles
//   ("You said <text> <time>." / "<who> said <text> <time>.").

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { DeviceAdapter, GetScreenOptions, MessageResult, PhoneDevice, ThreadMessage } from "@agentphone/device-core";
import type { DeviceInfo, DeviceStatus, ScreenState, SpecialKey, StatusCheck } from "@agentphone/shared";
import { DeviceError, sleep } from "@agentphone/shared";
import { normalizeAddress, optedOut } from "./messages.ts";
import { pngSignature } from "./signature.ts";

const pexec = promisify(execFile);
export const ANDROID_ADAPTER = "android-adb";

/** Runs `adb [-s serial] args…` and returns stdout. Injectable for tests. */
export type AdbRun = (serial: string | undefined, args: string[], opts?: { timeoutMs?: number }) => Promise<Buffer>;

/** adb from ANDROID_ADB, the Android SDK (ANDROID_HOME / the default SDK folder) or PATH. */
export function adbPath(): string | undefined {
  const sdk = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), "Library/Android/sdk")];
  const candidates = [
    process.env.ANDROID_ADB,
    ...sdk.map((s) => (s ? join(s, "platform-tools", "adb") : undefined)),
    ...(process.env.PATH ?? "").split(delimiter).map((d) => (d ? join(d, "adb") : undefined)),
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
  ];
  return candidates.find((c): c is string => !!c && existsSync(c));
}

function defaultRun(bin: string): AdbRun {
  return async (serial, args, opts = {}) => {
    try {
      const { stdout } = await pexec(bin, [...(serial ? ["-s", serial] : []), ...args], {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 20_000,
      });
      return stdout;
    } catch (e) {
      const err = e as { stderr?: Buffer; message: string };
      const why = err.stderr?.toString().trim() || err.message;
      throw new DeviceError("adb_failed", `adb ${args.slice(0, 2).join(" ")}: ${why.split("\n")[0]}`, "Is the phone still connected? Check with `fonino devices`.");
    }
  };
}

/** Quote for the phone's shell (adb shell joins its arguments into one command line). */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export type AdbDeviceLine = { serial: string; state: string; model?: string; product?: string };

export function parseDevices(out: string): AdbDeviceLine[] {
  const lines: AdbDeviceLine[] = [];
  for (const line of out.split("\n").slice(1)) {
    const m = line.trim().match(/^(\S+)\s+(\S+)(.*)$/);
    if (!m) continue;
    const kv = Object.fromEntries([...m[3].matchAll(/(\w+):(\S+)/g)].map((x) => [x[1], x[2]]));
    lines.push({ serial: m[1], state: m[2], model: kv.model?.replace(/_/g, " "), product: kv.product });
  }
  return lines;
}

/** Package of the app in front, from `dumpsys activity activities`. */
export function parseForeground(out: string): string | undefined {
  const m = out.match(/(?:topResumedActivity|mResumedActivity|ResumedActivity)[:=]\s*ActivityRecord\{\S+ u\d+ ([\w.]+)\//);
  return m?.[1];
}

/** Text for `input text`: one shell word, spaces as %s (its only escape). */
export function inputTextArg(chunk: string): string {
  return shq(chunk.replace(/ /g, "%s"));
}

// ── UI tree (uiautomator dump) ────────────────────────────────────────────────

export type AndroidNode = {
  id: string; // resource-id without the package prefix
  text: string;
  desc: string;
  clickable: boolean;
  bounds: [number, number, number, number]; // device pixels: left, top, right, bottom
  depth: number;
};

const unescapeXml = (s: string) =>
  s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Flat list of nodes in document order, with their nesting depth. */
export function parseUiDump(xml: string): AndroidNode[] {
  const nodes: AndroidNode[] = [];
  let depth = 0;
  for (const m of xml.matchAll(/<(\/?)node\b([^>]*?)(\/?)>/g)) {
    if (m[1]) {
      depth--;
      continue;
    }
    // uiautomator switches to single quotes for values that contain a double quote.
    const attr = (k: string) => {
      const a = m[2].match(new RegExp(`\\s${k}=(?:"([^"]*)"|'([^']*)')`));
      return unescapeXml(a?.[1] ?? a?.[2] ?? "");
    };
    const b = attr("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    nodes.push({
      id: attr("resource-id").replace(/^[\w.]+:id\//, ""),
      text: attr("text"),
      desc: attr("content-desc"),
      clickable: attr("clickable") === "true",
      bounds: b ? [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])] : [0, 0, 0, 0],
      depth,
    });
    if (!m[3]) depth++;
  }
  return nodes;
}

const inside = (n: AndroidNode, x: number, y: number) => x >= n.bounds[0] && x <= n.bounds[2] && y >= n.bounds[1] && y <= n.bounds[3];
const area = (n: AndroidNode) => (n.bounds[2] - n.bounds[0]) * (n.bounds[3] - n.bounds[1]);

/** The node and everything nested in it. */
function subtree(nodes: AndroidNode[], i: number): AndroidNode[] {
  const out = [nodes[i]];
  for (let j = i + 1; j < nodes.length && nodes[j].depth > nodes[i].depth; j++) out.push(nodes[j]);
  return out;
}

/** Labels of the smallest clickable element at (x, y) in device pixels: its own text/description, then its children's. */
export function labelsAt(nodes: AndroidNode[], x: number, y: number): string[] {
  let best = -1;
  nodes.forEach((n, i) => {
    if (n.clickable && inside(n, x, y) && (best < 0 || area(n) <= area(nodes[best]))) best = i;
  });
  if (best < 0) return [];
  return subtree(nodes, best).flatMap((n) => [n.text, n.desc]).map((s) => s.trim()).filter(Boolean);
}

/** Messages in an open Google Messages conversation, oldest first (from the bubbles' descriptions). */
export function parseBubbles(nodes: AndroidNode[]): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  for (const n of nodes) {
    if (n.id !== "message_text" || !n.desc) continue;
    const mine = /^You said\b/i.test(n.desc);
    if (!mine && !/\bsaid\b/i.test(n.desc)) continue;
    out.push({ from: mine ? "me" : "them", text: n.text, label: n.desc });
  }
  return out; // document order is top to bottom = oldest first
}

/** Rows of `content query --uri content://sms --projection address:type:date:body`, oldest first. */
export type SmsRow = { address: string; type: number; date: number; body: string };
export function parseSmsRows(out: string): SmsRow[] {
  const rows: SmsRow[] = [];
  for (const chunk of out.split(/^Row: \d+ /m).slice(1)) {
    const m = chunk.match(/^address=(.*?), type=(\d+), date=(\d+), body=([\s\S]*)$/);
    if (m) rows.push({ address: m[1], type: Number(m[2]), date: Number(m[3]), body: m[4].replace(/\n$/, "") });
  }
  return rows.sort((a, b) => a.date - b.date);
}

const sameAddress = (a: string, b: string) => {
  const x = normalizeAddress(a);
  const y = normalizeAddress(b);
  return !!x && !!y && (x === y || (x.length >= 10 && y.length >= 10 && x.slice(-10) === y.slice(-10)));
};

// ── adapter ───────────────────────────────────────────────────────────────────

const KEYCODES: Record<SpecialKey, string> = {
  return: "KEYCODE_ENTER",
  delete: "KEYCODE_DEL",
  escape: "KEYCODE_ESCAPE",
  tab: "KEYCODE_TAB",
  space: "KEYCODE_SPACE",
  up: "KEYCODE_DPAD_UP",
  down: "KEYCODE_DPAD_DOWN",
  left: "KEYCODE_DPAD_LEFT",
  right: "KEYCODE_DPAD_RIGHT",
};

export class AndroidAdapter implements DeviceAdapter {
  readonly name = ANDROID_ADAPTER;
  private readonly run: AdbRun | undefined;
  private readonly props = new Map<string, { model: string; release: string }>();
  private readonly devices = new Map<string, AndroidDevice>();

  constructor(opts: { run?: AdbRun } = {}) {
    const bin = opts.run ? undefined : adbPath();
    this.run = opts.run ?? (bin ? defaultRun(bin) : undefined);
  }

  async listDevices(): Promise<DeviceInfo[]> {
    if (!this.run) return []; // no adb on this Mac: no Android phones, not an error
    const run = this.run;
    const out = (await run(undefined, ["devices", "-l"], { timeoutMs: 8000 })).toString();
    return Promise.all(
      parseDevices(out).map(async (d): Promise<DeviceInfo> => {
        const base = { id: d.serial, nativeId: d.serial, adapter: this.name };
        if (d.state === "unauthorized")
          return { ...base, name: d.model ?? "Android phone", status: "unavailable", detail: "On the phone, tap Allow on “Allow USB debugging?”" };
        if (d.state !== "device") return { ...base, name: d.model ?? "Android phone", status: "unavailable", detail: `adb says the phone is ${d.state}; reconnect it` };
        let p = this.props.get(d.serial);
        if (!p) {
          const [model, release] = (await run(d.serial, ["shell", "getprop ro.product.model; getprop ro.build.version.release"]).catch(() => Buffer.from("")))
            .toString()
            .split("\n")
            .map((s) => s.trim());
          p = { model: model || d.model || "Android phone", release: release || "?" };
          this.props.set(d.serial, p);
        }
        const name = d.serial.startsWith("emulator-") ? `Android emulator (${p.model})` : p.model;
        const locked = await this.device(d.serial).locked().catch(() => false);
        return locked
          ? { ...base, name, status: "unavailable", detail: "phone is locked: unlock it (and set Screen timeout to the longest)" }
          : { ...base, name, status: "connected", detail: `${p.model}, Android ${p.release}${d.serial.includes(":") ? ", Wi-Fi" : d.serial.startsWith("emulator-") ? "" : ", USB"}` };
      }),
    );
  }

  private device(serial: string): AndroidDevice {
    let d = this.devices.get(serial);
    if (!d) {
      if (!this.run) throw new DeviceError("adb_missing", "adb isn't installed", "Install Android platform-tools.");
      d = new AndroidDevice(serial, this.props.get(serial)?.model ?? serial, this.run);
      this.devices.set(serial, d);
    }
    return d;
  }

  async getDevice(id: string): Promise<PhoneDevice> {
    return this.device(id);
  }
}

export class AndroidDevice implements PhoneDevice {
  readonly adapter = ANDROID_ADAPTER;
  private scale: number | undefined; // device pixels per dp
  private size: { width: number; height: number } | undefined; // dp

  readonly id: string;
  readonly name: string;
  private readonly run: AdbRun;

  constructor(id: string, name: string, run: AdbRun) {
    this.id = id;
    this.name = name;
    this.run = run;
  }

  private sh(cmd: string, timeoutMs?: number) {
    return this.run(this.id, ["shell", cmd], { timeoutMs }).then((b) => b.toString());
  }

  private async density(): Promise<number> {
    if (this.scale) return this.scale;
    const out = await this.sh("wm density");
    const d = Number(out.match(/Override density:\s*(\d+)/)?.[1] ?? out.match(/Physical density:\s*(\d+)/)?.[1] ?? 160);
    this.scale = d / 160;
    return this.scale;
  }

  private async geometry(): Promise<{ width: number; height: number }> {
    if (this.size) return this.size;
    const s = await this.density();
    const m = (await this.sh("wm size")).match(/(\d+)x(\d+)\s*$/m);
    if (!m) throw new DeviceError("adb_failed", "Couldn't read the screen size");
    this.size = { width: Math.round(Number(m[1]) / s), height: Math.round(Number(m[2]) / s) };
    return this.size;
  }

  private async px(x: number, y: number): Promise<[number, number]> {
    const { width, height } = await this.geometry();
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width || y > height) {
      throw new DeviceError("out_of_bounds", `Point (${x}, ${y}) is outside the ${width}x${height} screen`, "Use coordinates from the most recent screenshot (origin top-left).");
    }
    const s = await this.density();
    return [Math.round(x * s), Math.round(y * s)];
  }

  async locked(): Promise<boolean> {
    const out = await this.sh("dumpsys window | grep -E 'isKeyguardShowing|mDreamingLockscreen'; dumpsys power | grep mWakefulness=");
    return /isKeyguardShowing=true|mDreamingLockscreen=true/.test(out) || /mWakefulness=(Asleep|Dozing)/.test(out);
  }

  async getScreen(opts: GetScreenOptions = {}): Promise<ScreenState> {
    const s = await this.density();
    const [png, foregroundApp] = await Promise.all([
      this.run(this.id, ["exec-out", "screencap", "-p"]),
      this.foregroundApp().catch(() => undefined),
    ]);
    if (png.length < 24 || png.toString("ascii", 1, 4) !== "PNG") throw new DeviceError("screenshot_failed", "The phone didn't return a screenshot", "Is it unlocked?");
    const pxW = png.readUInt32BE(16);
    const pxH = png.readUInt32BE(20);
    const width = Math.round(pxW / s);
    const height = Math.round(pxH / s);
    this.size = { width, height }; // follows rotation
    const out = opts.outPath ?? join(tmpdir(), `agentphone-${this.id.replace(/[^\w.-]/g, "_")}-${Date.now()}.png`);
    writeFileSync(out, png);
    await pexec("sips", ["-z", String(height), String(width), out, "--out", out]);
    const bytes = readFileSync(out);
    return {
      deviceId: this.id,
      timestamp: new Date().toISOString(),
      width,
      height,
      orientation: width > height ? "LANDSCAPE" : "PORTRAIT",
      foregroundApp,
      screenshotPath: out,
      screenshotBase64: opts.includeBase64 ? bytes.toString("base64") : undefined,
      screenshotHash: createHash("sha256").update(bytes).digest("hex"),
      signature: await pngSignature(out),
    };
  }

  async tap(x: number, y: number) {
    const [a, b] = await this.px(x, y);
    await this.sh(`input tap ${a} ${b}`);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300) {
    const [a, b] = await this.px(x1, y1);
    const [c, d] = await this.px(x2, y2);
    await this.sh(`input swipe ${a} ${b} ${c} ${d} ${Math.round(Math.max(50, Math.min(5000, durationMs)))}`);
  }

  async type(text: string) {
    const t = text.replace(/\r\n?/g, "\n");
    if (/[^\x20-\x7e\n]/.test(t)) {
      throw new DeviceError(
        "unsupported_text",
        "Android's input can only type plain ASCII characters (no emoji, accents or other scripts).",
        "Type the text without them, or for texts use phone_send_message, which supports any characters.",
      );
    }
    const lines = t.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (let j = 0; j < lines[i].length; j += 80) await this.sh(`input text ${inputTextArg(lines[i].slice(j, j + 80))}`);
      // A new line, not Enter: in chat apps Enter can send.
      if (i < lines.length - 1) await this.sh("input keycombination KEYCODE_SHIFT_LEFT KEYCODE_ENTER");
    }
  }

  async key(key: SpecialKey) {
    await this.sh(`input keyevent ${KEYCODES[key]}`);
  }

  async home() {
    await this.sh("input keyevent KEYCODE_HOME");
  }

  async appSwitcher() {
    await this.sh("input keyevent KEYCODE_APP_SWITCH");
  }

  async openApp(pkg: string, fresh = false) {
    if (!/^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/.test(pkg)) throw new DeviceError("bad_args", `"${pkg}" is not an Android package name`);
    if (fresh) await this.sh(`am force-stop ${pkg}`);
    const comp = (await this.sh(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg}`)).trim().split("\n").pop()?.trim();
    if (!comp || !comp.includes("/")) throw new DeviceError("app_not_found", `${pkg} isn't installed (or has no launcher screen)`, "Check the package name, e.g. com.android.chrome.");
    await this.sh(`am start -n ${comp}`);
    await sleep(800);
  }

  async foregroundApp(): Promise<string | undefined> {
    return parseForeground(await this.sh("dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity'"));
  }

  private async ui(): Promise<AndroidNode[]> {
    for (let attempt = 0; ; attempt++) {
      const xml = (await this.run(this.id, ["exec-out", "uiautomator", "dump", "/dev/tty"], { timeoutMs: 15_000 })).toString();
      if (xml.includes("<hierarchy")) return parseUiDump(xml);
      if (attempt >= 2) throw new DeviceError("ui_unavailable", "Couldn't read the screen's elements (the app may be animating)", "Wait a moment and try again.");
      await sleep(500);
    }
  }

  async labelAt(x: number, y: number, pattern: string): Promise<string | undefined> {
    const [a, b] = await this.px(x, y);
    const re = new RegExp(pattern, "i");
    return labelsAt(await this.ui(), a, b).find((l) => re.test(l));
  }

  /** SMS history with `to` from the phone's message store, oldest first; undefined if the store isn't readable. */
  private async smsWith(to: string): Promise<SmsRow[] | undefined> {
    const out = await this.sh("content query --uri content://sms --projection address:type:date:body").catch(() => undefined);
    if (!out || /Error|Exception|Permission/i.test(out.split("\n")[0] ?? "")) return undefined;
    return parseSmsRows(out).filter((r) => sameAddress(r.address, to));
  }

  private async openConversation(to: string, body?: string): Promise<AndroidNode[]> {
    const addr = to.includes("@") ? to.trim() : to.trim().replace(/[\s().-]/g, "");
    await this.sh(`am start -a android.intent.action.SENDTO -d ${shq(`sms:${addr}`)}${body === undefined ? "" : ` --es sms_body ${shq(body)}`}`);
    const deadline = Date.now() + 10_000;
    for (;;) {
      await sleep(700);
      const nodes = await this.ui().catch(() => [] as AndroidNode[]);
      const field = nodes.find((n) => n.id === "compose_message_text");
      // The app fills the field a moment after the conversation shows; give it up to 4 s.
      if (field && (body === undefined || field.text.trim() === body.trim() || Date.now() > deadline - 6000)) return nodes;
      if (Date.now() > deadline) throw new DeviceError("messages_unavailable", "The messaging app didn't open the conversation.", "Is Google Messages the default SMS app?");
    }
  }

  /** The conversation header shows `to` (as a number) or the contact name saved for it. */
  private async recipientShown(nodes: AndroidNode[], to: string): Promise<boolean> {
    const top = nodes.filter((n) => n.bounds[3] < 320 * (this.scale ?? 2.625));
    if (top.some((n) => sameAddress(n.text, to))) return true;
    if (nodes.some((n) => n.id === "message_text" && /^Texting with /.test(n.text) && sameAddress(n.text.replace(/^Texting with | \(.*$/g, ""), to))) return true;
    const num = normalizeAddress(to);
    if (!num || to.includes("@")) return false;
    const out = await this.sh(`content query --uri ${shq(`content://com.android.contacts/phone_lookup/${num}`)} --projection display_name`).catch(() => "");
    const name = out.match(/display_name=(.*)$/m)?.[1]?.trim();
    return !!name && top.some((n) => n.text.trim() === name);
  }

  async sendMessage(to: string, body: string): Promise<MessageResult> {
    const text = body.replace(/\r\n?/g, "\n").trim();
    if (!normalizeAddress(to)) throw new DeviceError("bad_recipient", `"${to}" is not a phone number or email`, "Use a number with country code, e.g. +16285551234.");
    const history = await this.smsWith(to);
    if (history && optedOut(history.map((r) => ({ from: r.type === 1 ? ("them" as const) : ("me" as const), text: r.body })))) {
      throw new DeviceError("recipient_opted_out", `${to} replied STOP and hasn't opted back in. Nothing was sent.`, "Don't contact this person again unless they text START.");
    }
    const nodes = await this.openConversation(to, text);
    if (!(await this.recipientShown(nodes, to))) {
      throw new DeviceError("recipient_mismatch", `The conversation on screen isn't with ${to}. Nothing was sent.`);
    }
    const field = nodes.find((n) => n.id === "compose_message_text");
    if (field?.text.trim() !== text) {
      throw new DeviceError("compose_mismatch", "The message field doesn't hold exactly this text (an old draft?). Nothing was sent.", "Clear the draft in the conversation, then try again.");
    }
    const sendIdx = nodes.findIndex((n, i) => n.clickable && (/(^|[:_])Send$/i.test(n.id) || subtree(nodes, i).some((c) => /^Send( (SMS|MMS|message|RCS|encrypted message))?$/i.test(c.desc))));
    if (sendIdx < 0) throw new DeviceError("messages_unavailable", "No Send button in the conversation. Nothing was sent.");
    const send = nodes[sendIdx];
    const label = subtree(nodes, sendIdx).map((n) => n.desc).join(" ");
    const sentBefore = history?.filter((r) => r.type !== 1 && r.body.trim() === text).length ?? 0;
    const bubblesBefore = parseBubbles(nodes).filter((m) => m.from === "me" && m.text.trim() === text).length;
    // The one consequential command: never replayed.
    await this.sh(`input tap ${Math.round((send.bounds[0] + send.bounds[2]) / 2)} ${Math.round((send.bounds[1] + send.bounds[3]) / 2)}`);
    const service: MessageResult["service"] = /RCS|chat/i.test(label) ? "RCS" : "SMS";
    const deadline = Date.now() + 12_000;
    for (;;) {
      await sleep(800);
      const rows = (await this.smsWith(to))?.filter((r) => r.type !== 1 && r.body.trim() === text);
      if (rows && rows.length > sentBefore) {
        const r = rows[rows.length - 1];
        if (r.type === 5) return { status: "failed", service: "SMS", detail: "The phone shows the text as not sent." };
        if (r.type === 2) return { status: "sent", service: "SMS", detail: "Sent." };
      }
      const now = await this.ui().catch(() => [] as AndroidNode[]);
      const bubbles = parseBubbles(now).filter((m) => m.from === "me" && m.text.trim() === text);
      const pending = now.find((n) => n.id === "compose_message_text")?.text.trim();
      if (bubbles.length > bubblesBefore && pending !== text && (!rows || Date.now() > deadline - 6000)) {
        const failed = now.some((n) => /not sent|failed to send/i.test(n.text + " " + n.desc));
        return failed ? { status: "failed", service, detail: "The phone shows the text as not sent." } : { status: "sent", service, detail: "Sent." };
      }
      if (Date.now() > deadline) {
        if (pending === text) return { status: "failed", detail: "The text is still in the compose field: Send didn't go through. Nothing was sent." };
        return { status: "sent", detail: "The compose field emptied but the sent message wasn't found; check with phone_read_messages." };
      }
    }
  }

  async readMessages(to: string, limit = 10): Promise<ThreadMessage[]> {
    const rows = await this.smsWith(to);
    if (rows?.length) {
      return rows.slice(-limit).map((r) => ({ from: r.type === 1 ? "them" : "me", text: r.body, label: `${r.type === 1 ? "Received" : "Sent"} ${new Date(r.date).toISOString()}` }));
    }
    return parseBubbles(await this.openConversation(to)).slice(-limit);
  }

  async wait(ms: number) {
    await sleep(ms);
  }

  async getStatus(): Promise<DeviceStatus> {
    const checks: StatusCheck[] = [];
    let ok = true;
    try {
      const locked = await this.locked();
      checks.push({ name: "phone unlocked", ok: !locked, fix: locked ? "Unlock the phone and set Settings → Display → Screen timeout to the longest." : undefined });
      ok = !locked;
    } catch (e) {
      ok = false;
      checks.push({ name: "adb connection", ok: false, detail: (e as Error).message, fix: "Reconnect the phone and allow USB debugging." });
    }
    const size = await this.geometry().catch(() => undefined);
    return {
      id: this.id,
      nativeId: this.id,
      name: this.name,
      adapter: this.adapter,
      status: ok ? "connected" : "unavailable",
      width: size?.width,
      height: size?.height,
      capabilities: {
        screenshot: true,
        tap: true,
        swipe: true,
        type: true,
        home: true,
        appSwitcher: true,
        keys: Object.keys(KEYCODES) as SpecialKey[],
        usesHostInput: false,
      },
      checks,
    };
  }
}
