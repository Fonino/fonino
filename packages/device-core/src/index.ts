// device-core: the only contract the rest of AgentPhone knows about.
// Agents, CLI, MCP and the web bridge talk to PhoneDevice; how a device is
// actually controlled (iPhone Mirroring, WebDriverAgent, adb, ...) lives in an adapter.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DeviceInfo, DeviceStatus, ScreenState, SpecialKey } from "@agentphone/shared";
import { DeviceError } from "@agentphone/shared";
import { LeaseStore, leasedError } from "./lease.ts";

export type GetScreenOptions = {
  /** Where to write the PNG. Adapters pick a temp path if omitted. */
  outPath?: string;
  /** Include base64 PNG in the result (for models / MCP). */
  includeBase64?: boolean;
};

export interface PhoneDevice {
  readonly id: string;
  readonly name: string;
  readonly adapter: string;

  getScreen(opts?: GetScreenOptions): Promise<ScreenState>;

  tap(x: number, y: number): Promise<void>;

  swipe(startX: number, startY: number, endX: number, endY: number, durationMs?: number): Promise<void>;

  type(text: string): Promise<void>;

  /** Press a non-text key (Return, Delete, ...). */
  key(key: SpecialKey): Promise<void>;

  home(): Promise<void>;

  appSwitcher(): Promise<void>;

  /** Optional: live screen as an MJPEG (multipart/x-mixed-replace) stream. Read-only. */
  openLiveStream?(opts?: { scalePct?: number; fps?: number }): Promise<NodeJS.ReadableStream>;

  /** Optional: open an app by bundle id; fresh=true terminates it first (cold start). */
  openApp?(bundleId: string, fresh?: boolean): Promise<void>;

  /** Optional: label of a button/link at (x, y) whose label matches `pattern` (case-insensitive regex). */
  labelAt?(x: number, y: number, pattern: string): Promise<string | undefined>;

  /** Optional: the newest photos in the camera roll, newest first (original files). */
  latestPhotos?(count: number): Promise<Array<{ name: string; modified: string; data: Buffer }>>;

  /** Optional: save the image at `url` (reachable from the phone) into the Photos library. */
  saveImageToPhotos?(url: string): Promise<void>;

  /** Optional: bundle id of the app in front, cheaply (no screenshot). */
  foregroundApp?(): Promise<string | undefined>;

  /**
   * Optional: send a text (iMessage/SMS/RCS, whatever the phone picks) without coordinates.
   * The adapter verifies the compose screen before pressing Send and never presses it twice.
   */
  sendMessage?(to: string, body: string): Promise<MessageResult>;

  /** Optional: the latest messages in the conversation with `to` (oldest first). */
  readMessages?(to: string, limit?: number): Promise<ThreadMessage[]>;

  wait(ms: number): Promise<void>;

  getStatus(): Promise<DeviceStatus>;
}

export type MessageResult = {
  /** delivered/read: the phone showed that status; sent: it left the compose field with no failure shown. */
  status: "delivered" | "read" | "sent" | "failed";
  service?: "iMessage" | "SMS" | "RCS";
  detail?: string;
};

export type ThreadMessage = { from: "me" | "them"; text: string; label: string };

export interface DeviceAdapter {
  /** Stable adapter name, e.g. "iphone-mirroring". */
  readonly name: string;
  listDevices(): Promise<DeviceInfo[]>;
  /** Return a controller for a device this adapter listed. */
  getDevice(id: string): Promise<PhoneDevice>;
}

/** Minimal async mutex: runs tasks one at a time, in call order. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/**
 * Wraps a device so that all calls to it are serialized. Multiple clients
 * (an agent loop + an MCP client + the web UI) can then share one phone
 * without interleaving half-finished gestures.
 */
/** Lease key for a physical device: stable across processes and friendly-id aliases. */
export function leaseKey(adapter: string, nativeId: string): string {
  return `${adapter}_${nativeId}`;
}

/**
 * Wraps a device so that all calls to it are serialized within this process, and
 * mutations are refused while another process holds the phone's lease. Multiple
 * clients (an agent loop + an MCP client + the web UI) can then share one phone
 * without interleaving half-finished gestures or fighting a leased task.
 */
function serialized(device: PhoneDevice, id: string, leases: LeaseStore | undefined): PhoneDevice {
  const lock = new Mutex();
  const q = <T>(fn: () => Promise<T>) => lock.run(fn);
  const key = leaseKey(device.adapter, device.id);
  const m = <T>(fn: () => Promise<T>) =>
    q(() => {
      const other = leases?.heldElsewhere(key);
      if (other) throw leasedError(other);
      return fn();
    });
  return {
    id,
    name: device.name,
    adapter: device.adapter,
    getScreen: (o) => q(async () => ({ ...(await device.getScreen(o)), deviceId: id })),
    tap: (x, y) => m(() => device.tap(x, y)),
    swipe: (a, b, c, d, ms) => m(() => device.swipe(a, b, c, d, ms)),
    type: (t) => m(() => device.type(t)),
    key: (k) => m(() => device.key(k)),
    home: () => m(() => device.home()),
    appSwitcher: () => m(() => device.appSwitcher()),
    openApp: device.openApp ? (b, f) => m(() => device.openApp!(b, f)) : undefined,
    latestPhotos: device.latestPhotos ? (n) => q(() => device.latestPhotos!(n)) : undefined,
    saveImageToPhotos: device.saveImageToPhotos ? (u) => m(() => device.saveImageToPhotos!(u)) : undefined,
    labelAt: device.labelAt ? (x, y, p) => q(() => device.labelAt!(x, y, p)) : undefined,
    foregroundApp: device.foregroundApp ? () => q(() => device.foregroundApp!()) : undefined,
    sendMessage: device.sendMessage ? (to, body) => m(() => device.sendMessage!(to, body)) : undefined,
    readMessages: device.readMessages ? (to, n) => m(() => device.readMessages!(to, n)) : undefined,
    openLiveStream: device.openLiveStream ? (o) => device.openLiveStream!(o) : undefined,
    // wait is intentionally not serialized: it touches nothing.
    wait: (ms) => device.wait(ms),
    getStatus: async () => ({ ...(await device.getStatus()), id, nativeId: device.id }),
  };
}

/**
 * Persistent friendly ids: maps "<adapter>:<nativeId>" -> "iphone-001".
 * Stored in ~/.agentphone/devices.json (override with AGENTPHONE_HOME).
 */
export class AliasStore {
  private readonly path: string;
  private map: Record<string, string>;
  constructor(path = join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "devices.json")) {
    this.path = path;
    this.map = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }
  aliasFor(adapter: string, nativeId: string): string {
    const key = `${adapter}:${nativeId}`;
    let alias = this.map[key];
    if (!alias) {
      const prefix = adapter.startsWith("mock") ? "mock" : adapter.split("-")[0] || "device";
      const used = new Set(Object.values(this.map));
      let n = 1;
      while (used.has(`${prefix}-${String(n).padStart(3, "0")}`)) n++;
      alias = `${prefix}-${String(n).padStart(3, "0")}`;
      this.map[key] = alias;
      try {
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, JSON.stringify(this.map, null, 2));
      } catch {
        /* read-only home: aliases just won't persist */
      }
    }
    return alias;
  }
}

export class DeviceRegistry {
  private readonly adapters: DeviceAdapter[] = [];
  private readonly cache = new Map<string, PhoneDevice>();
  private readonly keys = new Map<string, string>();
  private readonly aliases: AliasStore | undefined;
  readonly leases: LeaseStore | undefined;

  constructor(opts: { aliases?: AliasStore | false; leases?: LeaseStore | false } = {}) {
    this.leases = opts.leases === false ? undefined : (opts.leases ?? new LeaseStore());
    this.aliases = opts.aliases === false ? undefined : (opts.aliases ?? new AliasStore());
  }

  register(adapter: DeviceAdapter): this {
    this.adapters.push(adapter);
    return this;
  }

  get adapterNames(): string[] {
    return this.adapters.map((a) => a.name);
  }

  private withAlias(d: DeviceInfo): DeviceInfo {
    const nativeId = d.nativeId ?? d.id;
    const id = this.aliases ? this.aliases.aliasFor(d.adapter, nativeId) : nativeId;
    return { ...d, id, nativeId };
  }

  /** All devices from all adapters. An adapter that throws is reported, not fatal. */
  async listDevices(): Promise<DeviceInfo[]> {
    const results = await Promise.all(
      this.adapters.map(async (a) => {
        try {
          return (await a.listDevices()).map((d) => this.withAlias(d));
        } catch (err) {
          return [
            {
              id: `${a.name}:error`,
              name: a.name,
              adapter: a.name,
              status: "unavailable" as const,
              detail: (err as Error).message,
            },
          ];
        }
      }),
    );
    return results.flat();
  }

  /** Lease key of a device obtained from getDevice() (friendly id). */
  leaseKeyOf(id: string): string {
    const k = this.keys.get(id);
    if (!k) throw new DeviceError("unknown_device", `Device ${id} hasn't been opened in this process`);
    return k;
  }

  /** Accepts a friendly id ("iphone-001") or the adapter's native id (UDID). */
  async getDevice(id: string): Promise<PhoneDevice> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    for (const a of this.adapters) {
      const devices = (await a.listDevices().catch(() => [] as DeviceInfo[])).map((d) => this.withAlias(d));
      const match = devices.find((d) => d.id === id || d.nativeId === id);
      if (match) {
        const dev = serialized(await a.getDevice(match.nativeId!), match.id, this.leases);
        this.cache.set(match.id, dev);
        this.cache.set(match.nativeId!, dev);
        this.keys.set(match.id, leaseKey(a.name, match.nativeId!));
        return dev;
      }
    }
    const known = (await this.listDevices()).map((d) => d.id).join(", ") || "none";
    throw new DeviceError("unknown_device", `No device with id "${id}". Known devices: ${known}`, "Run `fonino devices`.");
  }
}

export { MockAdapter } from "./mock.ts";
export { LeaseStore, leasedError, type Lease } from "./lease.ts";
