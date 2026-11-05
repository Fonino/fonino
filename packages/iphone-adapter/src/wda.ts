// IPhoneWdaAdapter: controls physical iPhones through WebDriverAgent (an XCUITest
// runner, i.e. Apple's UI-testing framework) running on the phone. Unlike iPhone
// Mirroring this addresses each phone independently by UDID, doesn't touch the
// Mac's cursor, and so supports several phones at once.
//
// Requirements: Xcode, a signing team, Developer Mode on the phone, and WDA
// launched per device (`agentphone wda up`). Transport is a usbmuxd tunnel to
// device port 8100, or AGENTPHONE_WDA_URLS="<udid>=http://ip:8100,..." for Wi-Fi.
//
// Reliability rules:
// * A mutation (tap/swipe/type/home) whose request may have reached the phone is
//   never replayed automatically: its outcome is unknown, so the caller must
//   re-observe. Only failures that provably happened before sending, or WDA's
//   "invalid session id" (command not executed), are retried.
// * The phone is re-resolved by UDID on every connection, so a replug (which gives
//   it a new usbmuxd DeviceID) doesn't strand the transport.
// * Lock state is tri-state; "unknown" is never treated as unlocked.
// * Screen size/orientation are re-read on every screenshot (rotation).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DeviceAdapter, GetScreenOptions, MessageResult, PhoneDevice, ThreadMessage } from "@agentphone/device-core";
import type { DeviceInfo, DeviceStatus, ScreenState, SpecialKey } from "@agentphone/shared";
import { DeviceError, sleep } from "@agentphone/shared";
import { findById, normalizeAddress, optedOut, parseTranscript, recipientShown, resultFrom, serviceOf, smsUrl, type UiNode } from "./messages.ts";
import { pngSignature } from "./signature.ts";
import { keepAliveAgent, staleReuse } from "./keepalive.ts";
import { isTrusted, listMuxDevices, lockdownGetValues, modelName, muxConnect, type MuxDevice } from "./usbmux.ts";

const pexec = promisify(execFile);
const WDA_PORT = Number(process.env.AGENTPHONE_WDA_PORT ?? 8100);
/** WDA's MJPEG screen stream (device side). */
const MJPEG_PORT = Number(process.env.AGENTPHONE_MJPEG_PORT ?? 9100);

function wdaUrlOverrides(): Map<string, string> {
  const m = new Map<string, string>();
  for (const pair of (process.env.AGENTPHONE_WDA_URLS ?? "").split(",").filter(Boolean)) {
    const [udid, url] = pair.split("=");
    if (udid && url) m.set(udid.trim(), url.trim().replace(/\/$/, ""));
  }
  return m;
}

type Json = Record<string, any>;
export type LockState = "locked" | "unlocked" | "unknown";

const LOCKED_FIX = "Unlock the phone and set Settings → Display & Brightness → Auto-Lock → Never.";

function connectTcp(url: URL): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(url.port || 80), url.hostname, () => resolve(s));
    s.once("error", reject);
  });
}

class WdaClient {
  private readonly udid: string;
  private readonly baseUrl: string | undefined;
  private mux: MuxDevice | undefined;

  constructor(udid: string, mux: MuxDevice | undefined, baseUrl: string | undefined) {
    this.udid = udid;
    this.mux = mux;
    this.baseUrl = baseUrl;
  }

  /**
   * Open WDA's MJPEG stream (multipart/x-mixed-replace of JPEG frames). Read-only.
   * Tested: ~9 fps at full resolution; mjpegScalingFactor and mjpegServerFramerate work,
   * mjpegServerScreenshotQuality has no visible effect (~125 KB/frame).
   */
  async stream(): Promise<http.IncomingMessage> {
    const url = this.baseUrl ? new URL(this.baseUrl) : undefined;
    const sock = this.baseUrl ? undefined : await this.tunnel(MJPEG_PORT);
    return new Promise((resolve, reject) => {
      const opts: http.RequestOptions = { method: "GET", host: url?.hostname ?? "127.0.0.1", port: MJPEG_PORT, path: "/" };
      const req = http.request(sock ? { ...opts, createConnection: () => sock } : { ...opts, agent: false }, (res) =>
        (res.statusCode ?? 500) < 400 ? resolve(res) : reject(new DeviceError("stream_unavailable", `MJPEG server answered ${res.statusCode}`)),
      );
      req.on("error", (e) => reject(new DeviceError("stream_unavailable", `Can't open the live stream: ${e.message}`, "Is WebDriverAgent running (agentphone wda up)?")));
      req.end();
    });
  }

  /** Open a tunnel, re-resolving the phone by UDID if its usbmuxd DeviceID went stale. */
  private async tunnel(port = WDA_PORT): Promise<net.Socket> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.mux || attempt > 0) {
        this.mux = (await listMuxDevices().catch(() => [] as MuxDevice[])).find((d) => d.udid === this.udid);
        if (!this.mux) {
          throw new DeviceError("device_unreachable", `iPhone ${this.udid} is not attached`, "Check the USB cable, unlock the phone, then retry.");
        }
      }
      try {
        return await muxConnect(this.mux.deviceId, port);
      } catch (e) {
        if (attempt === 1) {
          throw new DeviceError(
            "device_unreachable",
            `Can't reach WebDriverAgent on ${this.udid}: ${(e as Error).message}`,
            "Is `agentphone wda up` running? Reconnect the phone if it was unplugged.",
          );
        }
      }
    }
    throw new DeviceError("device_unreachable", `Can't reach ${this.udid}`);
  }

  /**
   * Errors are classified by whether the request may have reached the phone:
   * `device_unreachable` (never sent — safe to retry), `invalid_session` (WDA refused
   * before executing — safe to retry with a new session), `outcome_unknown` (sent, no
   * answer — must NOT be replayed for mutations).
   */
  async request(method: string, path: string, body?: unknown, timeoutMs = 30000, retried = false): Promise<Json> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const url = this.baseUrl ? new URL(this.baseUrl + path) : undefined;
    // Kept-alive connections: WDA dies after ~2,500 connections, so never open one per request.
    const agent = this.baseUrl ? keepAliveAgent(this.baseUrl, () => connectTcp(url!)) : keepAliveAgent(`${this.udid}:${WDA_PORT}`, () => this.tunnel());
    return new Promise((resolve, reject) => {
      const opts: http.RequestOptions = {
        method,
        host: url?.hostname ?? "127.0.0.1",
        port: url?.port ?? WDA_PORT,
        path: url ? url.pathname + url.search : path,
        headers: { "content-type": "application/json", ...(payload ? { "content-length": payload.length } : {}) },
        timeout: timeoutMs,
      };
      let sent = false;
      const unknown = (why: string) =>
        new DeviceError(
          sent ? "outcome_unknown" : "device_unreachable",
          `WDA ${method} ${path}: ${why}${sent ? " (the request may have been executed)" : ""}`,
          sent ? "Take a fresh screenshot to see whether it happened before retrying." : "Retry; check the cable / WDA if it persists.",
        );
      let answered = false;
      const req = http.request({ ...opts, agent }, (res) => {
        answered = true;
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let json: Json;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            return reject(unknown("unreadable response"));
          }
          if ((res.statusCode ?? 500) < 400 && !json?.value?.error) return resolve(json);
          const err = String(json?.value?.error ?? "");
          const msg = String(json?.value?.message ?? res.statusCode);
          if (/could not be, unlocked|reason: Locked/i.test(msg)) {
            reject(new DeviceError("phone_locked", "The iPhone is locked, so iOS refuses UI actions.", LOCKED_FIX));
          } else if (/invalid session id/i.test(err) || /session .*does not exist/i.test(msg)) {
            reject(new DeviceError("invalid_session", `WDA session expired (${path})`));
          } else {
            reject(new DeviceError("wda_error", `WDA ${method} ${path}: ${msg.slice(0, 300)}`));
          }
        });
      });
      req.on("finish", () => (sent = true));
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", (e: NodeJS.ErrnoException) => {
        // An idle kept-alive connection WDA had just closed: the request never reached it.
        if (staleReuse(req, e, answered) && !retried) return resolve(this.request(method, path, body, timeoutMs, true));
        reject(unknown(e.message));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
}

class WdaIPhone implements PhoneDevice {
  readonly adapter = "iphone-wda";
  private session?: string;
  private size?: { width: number; height: number };
  private orientation?: string;

  readonly id: string;
  readonly name: string;
  private readonly wda: WdaClient;
  constructor(id: string, name: string, wda: WdaClient) {
    this.id = id;
    this.name = name;
    this.wda = wda;
  }

  private async sid(): Promise<string> {
    if (this.session) return this.session;
    // Don't wait for apps to go idle before each action: busy apps (Amazon, feeds, video) never
    // do, and XCUITest would sit out its whole timeout (~16 s per swipe, measured). We settle
    // briefly ourselves and verify every action with a screenshot anyway.
    const caps = { capabilities: { alwaysMatch: { shouldWaitForQuiescence: false, waitForIdleTimeout: 1, animationCoolOffTimeout: 0 }, firstMatch: [{}] } };
    // Creating a session changes nothing on screen, so a dropped connection is safe to retry
    // (seen: "write EPIPE" right after WDA restarted, which surfaced to the agent as outcome_unknown).
    let r: Json;
    try {
      r = await this.wda.request("POST", "/session", caps);
    } catch (e) {
      const code = (e as DeviceError).code;
      if (code !== "outcome_unknown" && code !== "device_unreachable") throw e;
      await sleep(1000);
      r = await this.wda.request("POST", "/session", caps);
    }
    this.session = (r.sessionId ?? r.value?.sessionId) as string;
    await this.wda
      .request("POST", `/session/${this.session}/appium/settings`, { settings: { waitForIdleTimeout: 1, animationCoolOffTimeout: 0 } })
      .catch(() => undefined);
    return this.session;
  }

  /**
   * Session-scoped call. Retries only when the command provably did not run:
   * an expired session, or a failure before sending. A mutation with an unknown
   * outcome is surfaced, never replayed.
   */
  private async s(method: string, path: string, body?: unknown, mutation = method !== "GET"): Promise<Json> {
    try {
      return await this.wda.request(method, `/session/${await this.sid()}${path}`, body);
    } catch (e) {
      const code = (e as DeviceError).code;
      const safeToRetry = code === "invalid_session" || code === "device_unreachable" || (!mutation && code === "outcome_unknown");
      if (!safeToRetry) throw e;
      this.session = undefined; // reconnects/replugs also invalidate the session
      return this.wda.request(method, `/session/${await this.sid()}${path}`, body);
    }
  }

  /** Current logical screen size (points) and orientation; re-read so rotation is noticed. */
  private async refreshGeometry() {
    const r = await this.s("GET", "/window/size");
    this.size = { width: r.value.width, height: r.value.height };
    this.orientation = (await this.s("GET", "/orientation").catch(() => undefined))?.value;
    return this.size;
  }

  private async geometry() {
    return this.size ?? this.refreshGeometry();
  }

  private async assertInBounds(points: Array<[number, number]>) {
    const { width, height } = await this.geometry();
    for (const [x, y] of points) {
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width || y > height) {
        throw new DeviceError(
          "out_of_bounds",
          `Point (${x}, ${y}) is outside the ${width}x${height} screen`,
          "Use coordinates from the most recent screenshot (origin top-left).",
        );
      }
    }
  }

  private pointer(actions: Json[]) {
    return this.s("POST", "/actions", {
      actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions }],
    });
  }

  async getScreen(opts: GetScreenOptions = {}): Promise<ScreenState> {
    const { width, height } = await this.refreshGeometry();
    const foregroundApp = (await this.wda.request("GET", "/wda/activeAppInfo", undefined, 5000).catch(() => undefined))?.value?.bundleId as
      | string
      | undefined;
    const r = await this.wda.request("GET", "/screenshot");
    const out = opts.outPath ?? join(tmpdir(), `agentphone-${this.id}-${Date.now()}.png`);
    writeFileSync(out, Buffer.from(r.value as string, "base64"));
    // WDA returns device pixels (2x/3x). Resample to points so pixel == tap coordinate.
    await pexec("sips", ["-z", String(height), String(width), out, "--out", out]);
    const bytes = readFileSync(out);
    return {
      deviceId: this.id,
      timestamp: new Date().toISOString(),
      width,
      height,
      orientation: this.orientation,
      foregroundApp,
      screenshotPath: out,
      screenshotBase64: opts.includeBase64 ? bytes.toString("base64") : undefined,
      screenshotHash: createHash("sha256").update(bytes).digest("hex"),
      signature: await pngSignature(out),
    };
  }

  async tap(x: number, y: number) {
    await this.assertInBounds([[x, y]]);
    await this.pointer([
      { type: "pointerMove", duration: 0, x: Math.round(x), y: Math.round(y) },
      { type: "pointerDown", button: 0 },
      { type: "pause", duration: 60 },
      { type: "pointerUp", button: 0 },
    ]);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 300) {
    await this.assertInBounds([[x1, y1], [x2, y2]]);
    await this.pointer([
      { type: "pointerMove", duration: 0, x: Math.round(x1), y: Math.round(y1) },
      { type: "pointerDown", button: 0 },
      { type: "pointerMove", duration: Math.max(50, Math.min(5000, durationMs)), x: Math.round(x2), y: Math.round(y2) },
      { type: "pointerUp", button: 0 },
    ]);
  }

  async type(text: string) {
    await this.s("POST", "/wda/keys", { value: [...text] });
  }

  async key(key: SpecialKey) {
    const map: Partial<Record<SpecialKey, string>> = { return: "\n", delete: "\b", tab: "\t", space: " " };
    const ch = map[key];
    if (!ch) throw new DeviceError("unsupported", `key "${key}" is not supported by the WDA adapter`, "Supported: return, delete, tab, space.");
    await this.type(ch);
  }

  async home() {
    // Tested (iOS 26.2.1): XCUITest's Home — /wda/homescreen, pressButton home, and a
    // synthesized bottom-edge swipe — returns to the Home Screen from an app, but is a
    // no-op when SpringBoard is already in front (it does NOT jump back to page 1).
    // Session-less endpoint; same no-replay rule as session calls.
    try {
      await this.wda.request("POST", "/wda/homescreen");
    } catch (e) {
      if ((e as DeviceError).code !== "device_unreachable") throw e;
      await this.wda.request("POST", "/wda/homescreen");
    }
  }

  async openApp(bundleId: string, fresh = false) {
    if (fresh) {
      // Terminating a non-running app is fine; the command is idempotent, so a retry is safe.
      await this.s("POST", "/wda/apps/terminate", { bundleId }, false).catch((e) => {
        if ((e as DeviceError).code !== "wda_error") throw e;
      });
    }
    await this.s("POST", "/wda/apps/launch", { bundleId });
  }

  async latestPhotos(count: number) {
    const { latestPhotos } = await import("./afc.ts");
    const items = await latestPhotos(this.id, count, true);
    return items.map((p) => ({ name: p.name, modified: p.modified.toISOString(), data: p.data! }));
  }

  /** Open the image in Safari, long-press it, tap "Save to Photos" (tested on iOS 26.2: no prompt). */
  async saveImageToPhotos(url: string): Promise<void> {
    await this.s("POST", "/url", { url });
    await sleep(2500); // let Safari load and lay out the image
    const findSave = async () => {
      const b = (await this.s("POST", "/element", { using: "predicate string", value: `type == 'XCUIElementTypeButton' AND (label == 'Save to Photos' OR label == 'Add to Photos')` }, false).catch(() => undefined))?.value;
      return (b?.ELEMENT ?? b?.["element-6066-11e4-a52e-4f735466cecf"]) as string | undefined;
    };
    let save: string | undefined;
    const deadline = Date.now() + 25_000;
    while (!save && Date.now() < deadline) {
      // The largest visible image (not overlays), by position: elements go stale while pages load.
      const els = ((await this.s("POST", "/elements", { using: "class name", value: "XCUIElementTypeImage" }, false).catch(() => undefined))?.value as Json[]) ?? [];
      let best: { x: number; y: number; width: number; height: number } | undefined;
      for (const el of els.slice(0, 10)) {
        const id = el.ELEMENT ?? el["element-6066-11e4-a52e-4f735466cecf"];
        const name = String((await this.s("GET", `/element/${id}/attribute/name`).catch(() => undefined))?.value ?? "");
        if (/overlay|shadow|dimming/i.test(name)) continue;
        const r = (await this.s("GET", `/element/${id}/rect`).catch(() => undefined))?.value as typeof best;
        if (r && r.width > 40 && r.height > 40 && (!best || r.width * r.height > best.width * best.height)) best = r;
      }
      if (!best) {
        await sleep(800);
        continue;
      }
      // Press near a corner first: images with words in them (ads, posters) trigger Live Text in the
      // middle, which selects text (Copy / Look Up) instead of opening the image menu.
      const { width, height } = await this.geometry();
      const r = best;
      for (const [fx, fy] of [[0.05, 0.05], [0.95, 0.95], [0.05, 0.95], [0.95, 0.05], [0.5, 0.5]]) {
        const x = Math.min(Math.max(r.x + r.width * fx, 20), width - 20);
        const y = Math.min(Math.max(r.y + r.height * fy, 120), height - 160);
        await this.s("POST", "/wda/touchAndHold", { x, y, duration: 1.6 }, false).catch(() => undefined);
        await sleep(1000);
        save = await findSave();
        if (save) break;
        // Not the image menu (Live Text selection or nothing): dismiss with a tap outside the image.
        const below = r.y + r.height + 30;
        await this.tap(width / 2, below < height - 160 ? below : Math.max(r.y - 30, 110)).catch(() => undefined);
        await sleep(500);
      }
      if (!save) await sleep(700);
    }
    if (!save) throw new DeviceError("save_unavailable", "Couldn't open Safari's “Save to Photos” for this image.", "Check the phone is online, then take a screenshot to see what's on screen.");
    await this.s("POST", `/element/${save}/click`, {});
    await sleep(1200);
    // First time only, iOS may ask to let Safari add photos: allow it (this is the phone's own photo library).
    const alert = (await this.wda.request("GET", "/wda/alert/buttons").catch(() => undefined))?.value as string[] | undefined;
    const allow = alert?.find((b) => /allow|^ok$/i.test(b));
    if (allow) await this.wda.request("POST", "/alert/accept", { name: allow }).catch(() => undefined);
  }

  /** Buttons/links whose label matches `pattern`, hit-tested against (x, y). One predicate query
   * (fast) instead of the whole accessibility tree. */
  async labelAt(x: number, y: number, pattern: string): Promise<string | undefined> {
    const pred = `(type == 'XCUIElementTypeButton' OR type == 'XCUIElementTypeLink') AND label MATCHES[c] '${pattern.replace(/'/g, "")}'`;
    const r = await this.s("POST", "/elements", { using: "predicate string", value: pred }, false).catch(() => undefined);
    const els = ((r?.value as Json[]) ?? []).slice(0, 12);
    for (const el of els) {
      const id = el.ELEMENT ?? el["element-6066-11e4-a52e-4f735466cecf"];
      if (!id) continue;
      const rect = (await this.s("GET", `/element/${id}/rect`).catch(() => undefined))?.value as { x: number; y: number; width: number; height: number } | undefined;
      if (!rect) continue;
      const pad = 6;
      if (x >= rect.x - pad && x <= rect.x + rect.width + pad && y >= rect.y - pad && y <= rect.y + rect.height + pad) {
        return String((await this.s("GET", `/element/${id}/attribute/label`).catch(() => undefined))?.value ?? "button");
      }
    }
    return undefined;
  }

  async foregroundApp(): Promise<string | undefined> {
    return (await this.wda.request("GET", "/wda/activeAppInfo", undefined, 5000))?.value?.bundleId as string | undefined;
  }

  // ---------- Messages (see messages.ts) ----------

  private async uiTree(): Promise<UiNode> {
    return (await this.s("GET", "/source?format=json")).value as UiNode;
  }

  private async elementId(id: string): Promise<string | undefined> {
    try {
      const v = (await this.s("POST", "/element", { using: "accessibility id", value: id }, false)).value;
      return v?.ELEMENT ?? v?.["element-6066-11e4-a52e-4f735466cecf"];
    } catch (e) {
      if ((e as DeviceError).code === "wda_error") return undefined; // no such element
      throw e;
    }
  }

  private async fieldValue(eid: string): Promise<string> {
    return String((await this.s("GET", `/element/${eid}/attribute/value`)).value ?? "");
  }

  /** Open the conversation with `to` (optionally pre-filling `body`) and verify the recipient. */
  private async openConversation(to: string, body?: string): Promise<UiNode> {
    if (!normalizeAddress(to)) throw new DeviceError("bad_recipient", `"${to}" is not a phone number or email`, "Use a number with country code, e.g. +16285551234, or an iMessage email.");
    await this.s("POST", "/url", { url: smsUrl(to, body) });
    const deadline = Date.now() + 8000;
    for (;;) {
      const front = (await this.wda.request("GET", "/wda/activeAppInfo", undefined, 5000).catch(() => undefined))?.value?.bundleId;
      if (front === "com.apple.MobileSMS" && (await this.elementId("messageBodyField"))) break;
      if (Date.now() > deadline) {
        throw new DeviceError(
          "messages_unavailable",
          `Messages didn't open the conversation (front app: ${front ?? "unknown"}).`,
          "Usually the phone auto-locked (iOS then asks for Face ID even though WDA reports unlocked; set Auto-Lock to Never) or Messages requires Face ID (long-press Messages → Don't Require Face ID). Ask the owner (phone_request_help); check with phone_get_screen.",
        );
      }
      await sleep(400);
    }
    // The transcript loads a moment after the compose field; a brand-new conversation has none.
    let tree = await this.uiTree();
    for (let i = 0; i < 3 && !parseTranscript(tree).length; i++) {
      await sleep(500);
      tree = await this.uiTree();
    }
    const shown = recipientShown(tree, to);
    if (!shown.ok) {
      throw new DeviceError(
        "recipient_unverified",
        `The open conversation shows "${shown.shown ?? "?"}", which isn't ${to}. Nothing was sent.`,
        "If the number is saved as a contact the name is shown instead; send it manually or remove the contact.",
      );
    }
    return tree;
  }

  async sendMessage(to: string, body: string): Promise<MessageResult> {
    const text = body.replace(/\r\n?/g, "\n");
    const opened = await this.openConversation(to, text);
    const field = await this.elementId("messageBodyField");
    if (!field) throw new DeviceError("messages_unavailable", "No message field in the open conversation.");
    if (optedOut(parseTranscript(opened))) {
      await this.s("POST", `/element/${field}/clear`, {}).catch(() => undefined); // don't leave our draft behind
      throw new DeviceError("recipient_opted_out", `${to} replied STOP and hasn't opted back in. Nothing was sent.`, "Don't contact this person again unless they text START.");
    }
    // The URL normally fills the field; if an old draft won, replace it and check again.
    if ((await this.fieldValue(field)) !== text) {
      await this.s("POST", `/element/${field}/clear`, {});
      await this.s("POST", `/element/${field}/value`, { value: [...text] });
      const now = await this.fieldValue(field);
      if (now !== text) {
        await this.s("POST", `/element/${field}/clear`, {}).catch(() => undefined);
        throw new DeviceError("compose_mismatch", "Couldn't put the exact text in the message field. Nothing was sent.");
      }
    }
    const before = parseTranscript(await this.uiTree()).filter((m) => m.from === "me" && m.text === text.trim()).length;
    const send = await this.elementId("sendButton");
    if (!send) throw new DeviceError("messages_unavailable", "No Send button (is the text empty?). Nothing was sent.");
    // The one consequential command: never replayed (an unknown outcome surfaces as outcome_unknown).
    await this.s("POST", `/element/${send}/click`, {});
    const deadline = Date.now() + 12_000;
    let last: ReturnType<typeof parseTranscript> = [];
    for (;;) {
      await sleep(700);
      const tree = await this.uiTree();
      last = parseTranscript(tree).filter((m) => m.from === "me" && m.text === text.trim());
      const pending = String(findById(tree, "messageBodyField")?.value ?? "");
      const appeared = last.length > before;
      if (appeared && (last[last.length - 1].status || Date.now() > deadline - 6000)) {
        const r = resultFrom(last[last.length - 1]);
        return { ...r, service: r.service ?? serviceOf(pending) };
      }
      if (Date.now() > deadline) {
        if (pending === text) return { status: "failed", detail: "The text is still in the compose field: Send didn't go through. Nothing was sent." };
        return appeared ? resultFrom(last[last.length - 1]) : { status: "sent", detail: "The compose field emptied but the new bubble wasn't found; check with phone_read_messages." };
      }
    }
  }

  async readMessages(to: string, limit = 10): Promise<ThreadMessage[]> {
    const tree = await this.openConversation(to);
    return parseTranscript(tree).slice(-limit).map(({ from, text, label }) => ({ from, text, label }));
  }

  /** Live screen as an MJPEG HTTP response; frames are scaled to `scalePct` % at up to `fps`. */
  async openLiveStream(opts: { scalePct?: number; fps?: number } = {}): Promise<NodeJS.ReadableStream> {
    await this.s("POST", "/appium/settings", {
      settings: { mjpegScalingFactor: opts.scalePct ?? 35, mjpegServerFramerate: opts.fps ?? 5 },
    }, false);
    return this.wda.stream();
  }

  async appSwitcher() {
    // Face ID phones: slow swipe up from the home indicator and pause.
    const { width, height } = await this.geometry();
    await this.pointer([
      { type: "pointerMove", duration: 0, x: Math.round(width / 2), y: height - 2 },
      { type: "pointerDown", button: 0 },
      { type: "pointerMove", duration: 500, x: Math.round(width / 2), y: Math.round(height * 0.55) },
      { type: "pause", duration: 600 },
      { type: "pointerUp", button: 0 },
    ]);
  }

  wait(ms: number) {
    return sleep(ms);
  }

  async lockState(): Promise<LockState> {
    return lockStateOf(this.wda);
  }

  async getStatus(): Promise<DeviceStatus> {
    let wdaOk = false;
    let detail: string | undefined;
    try {
      const r = await this.wda.request("GET", "/status", undefined, 4000);
      wdaOk = r.value?.ready !== false;
    } catch (e) {
      detail = (e as Error).message;
    }
    const lock: LockState = wdaOk ? await lockStateOf(this.wda) : "unknown";
    const size = wdaOk && lock === "unlocked" ? await this.refreshGeometry().catch(() => undefined) : undefined;
    return {
      id: this.id,
      name: this.name,
      adapter: this.adapter,
      status: wdaOk && lock === "unlocked" ? "connected" : "unavailable",
      detail: detail ?? (lock === "unknown" && wdaOk ? "lock state unknown" : undefined),
      width: size?.width,
      height: size?.height,
      capabilities: {
        screenshot: true, tap: true, swipe: true, type: true, home: true, appSwitcher: true,
        keys: ["return", "delete", "tab", "space"], usesHostInput: false,
      },
      checks: [
        { name: "device attached (usbmuxd)", ok: true },
        {
          name: "WebDriverAgent reachable",
          ok: wdaOk,
          detail,
          fix: wdaOk ? undefined : `Start WDA: agentphone wda up (or scripts/wda.sh start ${this.id})`,
        },
        {
          name: "phone unlocked",
          ok: lock === "unlocked",
          detail: lock,
          fix: lock === "locked" ? LOCKED_FIX : lock === "unknown" ? "Couldn't read lock state; check WDA and retry." : undefined,
        },
      ],
    };
  }
}

/** What the WDA supervisor (separate service) says a person must fix on this phone, if anything. */
function supervisorNeedsHuman(udid: string): string | undefined {
  try {
    const dir = join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "wda");
    const h = JSON.parse(readFileSync(join(dir, "health.json"), "utf8"))[udid];
    return h && (h.health === "needs_human" || h.health === "untrusted") && h.detail ? String(h.detail) : undefined;
  } catch {
    return undefined;
  }
}

/** WDA answers /wda/locked even when the phone is locked. Failure → "unknown", never "unlocked". */
async function lockStateOf(client: WdaClient): Promise<LockState> {
  try {
    const v = (await client.request("GET", "/wda/locked", undefined, 2500)).value;
    return v === true ? "locked" : v === false ? "unlocked" : "unknown";
  } catch {
    return "unknown";
  }
}

export class IPhoneWdaAdapter implements DeviceAdapter {
  readonly name = "iphone-wda";
  private readonly names = new Map<string, string>();
  private readonly info = new Map<string, string>();
  private readonly devices = new Map<string, WdaIPhone>();

  private async deviceName(d: MuxDevice): Promise<string> {
    const cached = this.names.get(d.udid);
    if (cached) return cached;
    const v = await lockdownGetValues(d.deviceId, ["DeviceName", "ProductType", "ProductVersion"]).catch(
      () => ({}) as Record<string, string>,
    );
    // Phones often share a name ("Alex's iPhone"); add the model so they can't be confused.
    const model = modelName(v.ProductType);
    const name = `${v.DeviceName ?? "iPhone"}${model ? ` (${model})` : ` (${d.udid.slice(-6)})`}`;
    this.names.set(d.udid, name);
    this.info.set(d.udid, [model, v.ProductVersion && `iOS ${v.ProductVersion}`].filter(Boolean).join(", "));
    return name;
  }

  private async wdaReachable(client: WdaClient): Promise<boolean> {
    try {
      await client.request("GET", "/status", undefined, 2500);
      return true;
    } catch {
      return false;
    }
  }

  async listDevices(): Promise<DeviceInfo[]> {
    if (process.platform !== "darwin" && process.platform !== "linux") return [];
    const overrides = wdaUrlOverrides();
    const mux = await listMuxDevices().catch(() => [] as MuxDevice[]);
    const out: DeviceInfo[] = [];
    for (const d of mux) {
      const client = new WdaClient(d.udid, d, overrides.get(d.udid));
      const name = await this.deviceName(d);
      const trusted = await isTrusted(d.udid);
      const reachable = trusted && (await this.wdaReachable(client));
      const lock: LockState = reachable ? await lockStateOf(client) : "unknown";
      const ok = reachable && lock === "unlocked";
      const info = `${this.info.get(d.udid) || "iPhone"}, ${d.connectionType}`;
      out.push({
        id: d.udid,
        name,
        adapter: this.name,
        status: ok ? "connected" : "unavailable",
        detail: ok
          ? info
          : !trusted
            ? `${info}; not trusted — unlock the phone and tap "Trust This Computer"`
            : !reachable
              ? `${info}; ${supervisorNeedsHuman(d.udid) ?? "the phone helper isn't running yet (starting, or the Fonino service is stopped)"}`
              : lock === "locked"
                ? `${info}; phone is locked — unlock it and set Auto-Lock to Never`
                : `${info}; lock state unknown — retry`,
      });
    }
    // Wi-Fi-only devices configured by URL that usbmuxd doesn't list.
    for (const [udid, url] of overrides) {
      if (out.some((d) => d.id === udid)) continue;
      const ok = await this.wdaReachable(new WdaClient(udid, undefined, url));
      out.push({ id: udid, name: `iPhone ${udid.slice(-6)}`, adapter: this.name, status: ok ? "connected" : "disconnected", detail: url });
    }
    return out;
  }

  async getDevice(id: string): Promise<PhoneDevice> {
    const existing = this.devices.get(id);
    if (existing) return existing;
    const url = wdaUrlOverrides().get(id);
    const mux = (await listMuxDevices().catch(() => [] as MuxDevice[])).find((d) => d.udid === id);
    if (!mux && !url) throw new DeviceError("unknown_device", `iPhone ${id} is not attached`, "Plug it in and run `agentphone devices`.");
    const name = mux ? await this.deviceName(mux) : `iPhone ${id.slice(-6)}`;
    // The client re-resolves the UDID on reconnect, so this object stays valid across replugs.
    const dev = new WdaIPhone(id, name, new WdaClient(id, mux, url));
    this.devices.set(id, dev);
    return dev;
  }
}

type SettingsPage = {
  /** Taps the row (or button) with this exact label, scrolling until it's in view; false if never found. */
  open(label: string, type?: string): Promise<boolean>;
  /** Labels of the elements of this type on the current page (for checks and debugging). */
  labels(type: string): Promise<string[]>;
  touch(pts: Array<[number, number]>, ms: number): Promise<unknown>;
  /** Value of the first slider on the page, after moving it to `position` (0…1) if given. */
  slider(position?: number): Promise<string | undefined>;
  size: { width: number; height: number };
};

/**
 * Setup (Fonino for Mac): opens Settings from its main list and runs `fn` on it, then goes back
 * to the home screen. English labels (Fonino is US-only). Used to set what a Fonino phone needs,
 * so the person doesn't have to; on any surprise it returns false and the page asks the person.
 */
export async function inSettings(udid: string, fn: (p: SettingsPage) => Promise<boolean>): Promise<boolean> {
  const mux = (await listMuxDevices()).find((d) => d.udid === udid);
  if (!mux) return false;
  const wda = new WdaClient(udid, mux, undefined);
  const caps = { capabilities: { alwaysMatch: { bundleId: "com.apple.Preferences", shouldWaitForQuiescence: false }, firstMatch: [{}] } };
  const sid = String(((await wda.request("POST", "/session", caps)) as Json).sessionId ?? "");
  if (!sid) return false;
  const s = (m: string, p: string, b?: unknown) => wda.request(m, `/session/${sid}${p}`, b);
  // Same touch gestures as an assistant's taps (element clicks don't open Settings rows on iOS 26).
  const touch = (pts: Array<[number, number]>, ms: number) => s("POST", "/actions", { actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions: [
    { type: "pointerMove", duration: 0, x: Math.round(pts[0][0]), y: Math.round(pts[0][1]) }, { type: "pointerDown", button: 0 },
    pts[1] ? { type: "pointerMove", duration: ms, x: Math.round(pts[1][0]), y: Math.round(pts[1][1]) } : { type: "pause", duration: ms },
    { type: "pointerUp", button: 0 }] }] });
  const ids = async (pred: string): Promise<string[]> => {
    const v = ((await s("POST", "/elements", { using: "predicate string", value: pred }).catch(() => undefined)) as Json)?.value;
    return Array.isArray(v) ? v.map((e: Json) => e?.ELEMENT ?? e?.["element-6066-11e4-a52e-4f735466cecf"]).filter(Boolean) : [];
  };
  const rect = async (id: string) => (((await s("GET", `/element/${id}/rect`).catch(() => undefined)) as Json)?.value) as { x: number; y: number; width: number; height: number } | undefined;
  // Start Settings from its main list (it reopens the last page otherwise).
  await s("POST", "/wda/apps/terminate", { bundleId: "com.apple.Preferences" }).catch(() => undefined);
  await s("POST", "/wda/apps/launch", { bundleId: "com.apple.Preferences" }).catch(() => undefined);
  await sleep(1500);
  const size = (((await s("GET", "/window/size").catch(() => undefined)) as Json)?.value ?? { width: 390, height: 844 }) as { width: number; height: number };
  // Only tap well inside the screen: the see-through header and tab bar swallow taps.
  const top = size.height * 0.18;
  const bottom = size.height * 0.85;
  const page: SettingsPage = {
    size,
    touch,
    async open(label, type = "XCUIElementTypeStaticText") {
      const pred = `type == '${type}' AND label == '${label.replace(/'/g, "\\'")}'`;
      for (let i = 0; i < 12; i++) {
        // Rows exist off screen too, and tapping one there does nothing: pick one that's in view.
        const rects = (await Promise.all((await ids(pred)).map(rect))).filter((r): r is NonNullable<typeof r> => !!r && r.width > 0);
        const inView = rects.find((r) => r.y > top && r.y + r.height < bottom);
        if (inView) {
          await touch([[inView.x + inView.width / 2, inView.y + inView.height / 2]], 60);
          await sleep(1300);
          return true;
        }
        const x = size.width / 2;
        const down = !rects.length || rects[0].y > top; // below the screen (or not loaded yet): scroll down; above: back up
        await touch([[x, size.height * (down ? 0.7 : 0.35)], [x, size.height * (down ? 0.45 : 0.6)]], 350).catch(() => undefined);
        await sleep(1200); // let the scroll settle, or the next tap only stops it
      }
      return false;
    },
    async slider(position) {
      const [id] = await ids("type == 'XCUIElementTypeSlider'");
      if (!id) return undefined;
      if (position !== undefined) {
        await s("POST", `/element/${id}/value`, { value: [String(position)] });
        await sleep(800);
      }
      return String((((await s("GET", `/element/${id}/attribute/value`).catch(() => undefined)) as Json)?.value) ?? "");
    },
    async labels(type) {
      const out: string[] = [];
      for (const id of (await ids(`type == '${type}'`)).slice(0, 40)) out.push(String((((await s("GET", `/element/${id}/attribute/label`).catch(() => undefined)) as Json)?.value) ?? ""));
      return out;
    },
  };
  try {
    return await fn(page);
  } finally {
    await wda.request("POST", "/wda/homescreen").catch(() => undefined);
    await wda.request("DELETE", `/session/${sid}`).catch(() => undefined);
  }
}

/** Settings → Display & Brightness → Auto-Lock → Never: a locked phone blocks every action. */
export function setAutoLockNever(udid: string): Promise<boolean> {
  return inSettings(udid, async (p) => (await p.open("Display & Brightness")) && (await p.open("Auto-Lock")) && (await p.open("Never")));
}

/**
 * Settings → Battery → Charging → Charge Limit 80% (iPhone 15 and later). A Fonino phone is plugged
 * in all the time; held at 100% its battery wears out much faster. Returns false on older iPhones.
 */
export function setChargeLimit80(udid: string): Promise<boolean> {
  return inSettings(udid, async (p) => {
    if (!((await p.open("Battery")) && (await p.open("Charging", "XCUIElementTypeCell")))) return false;
    // The slider runs 80% … 100% and reports its position, so far left ("0%") is the 80% limit.
    return (await p.slider(0)) === "0%";
  });
}
