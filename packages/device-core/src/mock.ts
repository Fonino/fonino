// A fake phone for exercising the CLI / agent loop / MCP server without hardware.
// Enabled with AGENTPHONE_MOCK=1. It renders a plain PNG whose colour changes
// after every action, and logs actions to stderr.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { DeviceInfo, DeviceStatus, ScreenState, SpecialKey } from "@agentphone/shared";
import { DeviceError, sleep } from "@agentphone/shared";
import type { DeviceAdapter, GetScreenOptions, MessageResult, PhoneDevice, ThreadMessage } from "./index.ts";

function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

class MockPhone implements PhoneDevice {
  readonly adapter = "mock";
  private actions = 0;
  readonly id: string;
  readonly name: string;
  readonly width = 390;
  readonly height = 844;
  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
  }

  private act(desc: string): Promise<void> {
    this.actions++;
    process.stderr.write(`[mock ${this.id}] ${desc}\n`);
    return sleep(20);
  }

  async getScreen(opts: GetScreenOptions = {}): Promise<ScreenState> {
    const shade = (this.actions * 37) % 200;
    const bytes = png(this.width, this.height, [30 + shade, 60, 120]);
    const path = opts.outPath ?? join(tmpdir(), `agentphone-mock-${this.id}-${Date.now()}.png`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return {
      deviceId: this.id,
      timestamp: new Date().toISOString(),
      width: this.width,
      height: this.height,
      screenshotPath: path,
      screenshotBase64: opts.includeBase64 ? bytes.toString("base64") : undefined,
      screenshotHash: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  tap(x: number, y: number) { return this.act(`tap ${x},${y}`); }
  swipe(a: number, b: number, c: number, d: number) { return this.act(`swipe ${a},${b} -> ${c},${d}`); }
  type(text: string) { return this.act(`type ${JSON.stringify(text)}`); }
  key(key: SpecialKey) { return this.act(`key ${key}`); }
  async home() { await this.act("home"); this.front = "com.apple.springboard"; }
  appSwitcher() { return this.act("app switcher"); }
  wait(ms: number) { return sleep(ms); }

  /** Test hook / openApp target: the app "in front". */
  front = "com.apple.springboard";
  async openApp(bundleId: string) { await this.act(`open ${bundleId}`); this.front = bundleId; }
  async foregroundApp() { return this.front; }
  async latestPhotos(count: number) {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    return Array.from({ length: Math.min(count, 2) }, (_, i) => ({ name: `IMG_000${i}.PNG`, modified: new Date().toISOString(), data: png }));
  }
  /** Test hook: URLs saved to "Photos" (the mock downloads them like the phone would). */
  photos: Array<{ url: string; bytes: number }> = [];
  async saveImageToPhotos(url: string) {
    await this.act(`save image ${url}`);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    this.photos.push({ url, bytes: (await r.arrayBuffer()).byteLength });
  }
  /** Test hook: a button on screen (label + rect). */
  buttons: Array<{ label: string; x: number; y: number; w: number; h: number }> = [];
  async labelAt(x: number, y: number, pattern: string) {
    const re = new RegExp(pattern, "i");
    return this.buttons.find((b) => re.test(b.label) && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)?.label;
  }

  /** Messages "sent" from this mock, per canonical-ish recipient (digits or lowercase email). */
  readonly sent: Array<{ to: string; body: string }> = [];
  async sendMessage(to: string, body: string): Promise<MessageResult> {
    await this.act(`send message to ${to}: ${JSON.stringify(body)}`);
    const theirs = this.thread.filter((m) => m.to === to && m.from === "them").map((m) => m.body.trim().toLowerCase());
    if (theirs.lastIndexOf("stop") > theirs.lastIndexOf("start")) {
      throw new DeviceError("recipient_opted_out", `${to} replied STOP. Nothing was sent.`);
    }
    this.sent.push({ to, body });
    this.thread.push({ to, body, from: "me" });
    return { status: "delivered", service: "iMessage" };
  }
  /** Test hook: the other person replies. */
  receive(from: string, body: string) {
    this.thread.push({ to: from, body, from: "them" });
  }
  private readonly thread: Array<{ to: string; body: string; from: "me" | "them" }> = [];
  async readMessages(to: string, limit = 10): Promise<ThreadMessage[]> {
    await this.act(`open conversation with ${to}`);
    return this.thread.filter((m) => m.to === to).slice(-limit).map((m) => ({ from: m.from, text: m.body, label: m.body }));
  }
  async getStatus(): Promise<DeviceStatus> {
    return {
      id: this.id,
      name: this.name,
      adapter: this.adapter,
      status: "connected",
      width: this.width,
      height: this.height,
      capabilities: {
        screenshot: true, tap: true, swipe: true, type: true, home: true, appSwitcher: true,
        keys: ["return", "delete", "escape"], usesHostInput: false,
      },
      checks: [{ name: "mock device", ok: true }],
    };
  }
}

export class MockAdapter implements DeviceAdapter {
  readonly name = "mock";
  private readonly phones: MockPhone[];
  constructor(count = 2) {
    this.phones = Array.from({ length: count }, (_, i) => new MockPhone(`mock-${i + 1}`, `Mock iPhone ${i + 1}`));
  }
  async listDevices(): Promise<DeviceInfo[]> {
    return this.phones.map((p) => ({ id: p.id, name: p.name, adapter: this.name, status: "connected" as const }));
  }
  async getDevice(id: string): Promise<PhoneDevice> {
    const p = this.phones.find((x) => x.id === id);
    if (!p) throw new Error(`mock device ${id} not found`);
    return p;
  }
}
