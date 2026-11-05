// Talks to macOS's usbmuxd (/var/run/usbmuxd) directly — no libimobiledevice needed.
// Lists attached iPhones (USB and Wi-Fi-paired) and opens TCP tunnels to device ports.

import net from "node:net";
import { decodePlist, encodePlist, type PlistValue } from "./plist.ts";

const MUX_SOCKET = "/var/run/usbmuxd";

export type MuxDevice = {
  deviceId: number; // usbmuxd handle (changes on reconnect)
  udid: string;
  connectionType: "USB" | "Network" | string;
  productId?: number;
};

type Dict = Record<string, PlistValue>;

function muxRequest(msg: Dict, keepSocket = false): Promise<{ reply: Dict; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(MUX_SOCKET);
    const body = Buffer.from(encodePlist({ ClientVersionString: "agentphone", ProgName: "agentphone", ...msg }));
    const header = Buffer.alloc(16);
    header.writeUInt32LE(16 + body.length, 0);
    header.writeUInt32LE(1, 4); // version
    header.writeUInt32LE(8, 8); // plist message
    header.writeUInt32LE(1, 12); // tag
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("usbmuxd timeout")); }, 5000);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < len) return;
      clearTimeout(timer);
      sock.off("data", onData);
      const reply = decodePlist(buf.subarray(16, len).toString("utf8")) as Dict;
      if (!keepSocket) sock.end();
      resolve({ reply, socket: sock });
    };
    sock.on("data", onData);
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
    sock.write(Buffer.concat([header, body]));
  });
}

export async function listMuxDevices(): Promise<MuxDevice[]> {
  const { reply } = await muxRequest({ MessageType: "ListDevices" });
  const list = (reply.DeviceList as Dict[]) ?? [];
  const byUdid = new Map<string, MuxDevice>();
  for (const d of list) {
    const p = d.Properties as Dict;
    const dev: MuxDevice = {
      deviceId: p.DeviceID as number,
      udid: p.SerialNumber as string,
      connectionType: p.ConnectionType as string,
      productId: p.ProductID as number | undefined,
    };
    // A phone can appear twice (USB + Network); prefer USB.
    const prev = byUdid.get(dev.udid);
    if (!prev || (prev.connectionType !== "USB" && dev.connectionType === "USB")) byUdid.set(dev.udid, dev);
  }
  return [...byUdid.values()];
}

/** Open a raw TCP tunnel to `port` on the device. */
export async function muxConnect(deviceId: number, port: number): Promise<net.Socket> {
  const swapped = ((port & 0xff) << 8) | ((port >> 8) & 0xff); // usbmuxd wants network byte order
  const { reply, socket } = await muxRequest({ MessageType: "Connect", DeviceID: deviceId, PortNumber: swapped }, true);
  if (reply.Number !== 0) {
    socket.destroy();
    throw new Error(`usbmuxd: connect to device port ${port} failed (result ${String(reply.Number)})`);
  }
  return socket;
}

/**
 * Read values from lockdownd without a pairing session. iOS answers a small set
 * of keys (DeviceName, ProductType, ProductVersion...) on this unauthenticated path;
 * anything else needs pairing records we deliberately don't touch.
 */
export async function lockdownGetValues(deviceId: number, keys: string[]): Promise<Record<string, string>> {
  const sock = await muxConnect(deviceId, 62078);
  const out: Record<string, string> = {};
  let buf = Buffer.alloc(0);
  const pending: Array<(d: Dict) => void> = [];
  sock.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      const len = buf.readUInt32BE(0);
      const msg = decodePlist(buf.subarray(4, 4 + len).toString("utf8")) as Dict;
      buf = buf.subarray(4 + len);
      pending.shift()?.(msg);
    }
  });
  const ask = (req: Dict) =>
    new Promise<Dict>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("lockdownd timeout")), 3000);
      pending.push((d) => { clearTimeout(t); resolve(d); });
      const body = Buffer.from(encodePlist({ Label: "agentphone", ...req }));
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      sock.write(Buffer.concat([len, body]));
    });
  try {
    for (const k of keys) {
      const r = await ask({ Request: "GetValue", Key: k });
      if (typeof r.Value === "string") out[k] = r.Value;
    }
  } finally {
    sock.destroy();
  }
  return out;
}

/** True if this Mac holds a pair record for the phone, i.e. the user tapped "Trust". */
export async function isTrusted(udid: string): Promise<boolean> {
  try {
    const { reply } = await muxRequest({ MessageType: "ReadPairRecord", PairRecordID: udid });
    return reply.PairRecordData !== undefined;
  } catch {
    return false;
  }
}

// ProductType → marketing name for recent models (unknown types fall back to the raw id).
const MODELS: Record<string, string> = {
  "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max",
  "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus",
  "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
  "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max",
  "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus", "iPhone17,5": "iPhone 16e",
  "iPhone18,1": "iPhone 17 Pro", "iPhone18,2": "iPhone 17 Pro Max", "iPhone18,3": "iPhone 17",
};
export const modelName = (productType?: string) => (productType ? (MODELS[productType] ?? productType) : undefined);
