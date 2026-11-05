// Read photos from a USB iPhone's camera roll (/DCIM) through Apple File Conduit (com.apple.afc),
// the same media service Image Capture uses. Needs only the pairing this Mac already has ("Trust"):
// lockdownd session over TLS with the pair record from usbmuxd → StartService → AFC protocol.

import net from "node:net";
import tls from "node:tls";
import { decodePlist, encodePlist, type PlistValue } from "./plist.ts";
import { listMuxDevices, muxConnect } from "./usbmux.ts";

type Dict = Record<string, PlistValue>;

function muxPairRecord(udid: string): Promise<Dict> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection("/var/run/usbmuxd");
    const body = Buffer.from(encodePlist({ MessageType: "ReadPairRecord", PairRecordID: udid, ClientVersionString: "fonino", ProgName: "fonino" }));
    const h = Buffer.alloc(16);
    h.writeUInt32LE(16 + body.length, 0);
    h.writeUInt32LE(1, 4);
    h.writeUInt32LE(8, 8);
    h.writeUInt32LE(1, 12);
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => (sock.destroy(), reject(new Error("usbmuxd timeout"))), 5000);
    sock.on("data", (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length < 4 || buf.length < buf.readUInt32LE(0)) return;
      clearTimeout(t);
      sock.end();
      const r = decodePlist(buf.subarray(16, buf.readUInt32LE(0)).toString("utf8")) as Dict;
      const d = r.PairRecordData;
      if (!Buffer.isBuffer(d)) return reject(new Error("This Mac isn't trusted by the iPhone (no pair record)."));
      resolve(decodePlist(d.toString("utf8")) as Dict);
    });
    sock.on("error", (e) => (clearTimeout(t), reject(e)));
    sock.write(Buffer.concat([h, body]));
  });
}

/** Length-prefixed plist messages on a lockdownd connection (plain or TLS). */
function lockdownChannel(sock: net.Socket | tls.TLSSocket) {
  let buf = Buffer.alloc(0);
  const waiters: Array<(d: Dict) => void> = [];
  const onData = (c: Buffer) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      const len = buf.readUInt32BE(0);
      const msg = decodePlist(buf.subarray(4, 4 + len).toString("utf8")) as Dict;
      buf = buf.subarray(4 + len);
      waiters.shift()?.(msg);
    }
  };
  sock.on("data", onData);
  return {
    detach: () => sock.off("data", onData),
    ask: (req: Dict) =>
      new Promise<Dict>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("lockdownd timeout")), 8000);
        waiters.push((d) => (clearTimeout(t), resolve(d)));
        const body = Buffer.from(encodePlist({ Label: "fonino", ...req }));
        const len = Buffer.alloc(4);
        len.writeUInt32BE(body.length);
        sock.write(Buffer.concat([len, body]));
      }),
  };
}

/** Start com.apple.afc on the phone and return a raw socket to it. */
async function startAfc(udid: string): Promise<{ sock: net.Socket | tls.TLSSocket; done: () => void }> {
  const dev = (await listMuxDevices()).find((d) => d.udid === udid);
  if (!dev) throw new Error("The iPhone isn't connected over USB.");
  const pair = await muxPairRecord(udid);
  const raw = await muxConnect(dev.deviceId, 62078);
  let ch = lockdownChannel(raw);
  const s = await ch.ask({ Request: "StartSession", HostID: pair.HostID as string, SystemBUID: pair.SystemBUID as string });
  if (s.Error) throw new Error(`lockdownd: ${String(s.Error)}`);
  let ctl: net.Socket | tls.TLSSocket = raw;
  if (s.EnableSessionSSL) {
    ch.detach();
    ctl = tls.connect({ socket: raw, cert: pair.HostCertificate as Buffer, key: pair.HostPrivateKey as Buffer, rejectUnauthorized: false, minVersion: "TLSv1.2" });
    await new Promise<void>((resolve, reject) => (ctl as tls.TLSSocket).once("secureConnect", () => resolve()).once("error", reject));
    ch = lockdownChannel(ctl);
  }
  const svc = await ch.ask({ Request: "StartService", Service: "com.apple.afc" });
  if (svc.Error || typeof svc.Port !== "number") throw new Error(`lockdownd: couldn't start the photo service (${String(svc.Error ?? "no port")})`);
  let sock: net.Socket | tls.TLSSocket = await muxConnect(dev.deviceId, svc.Port);
  if (svc.EnableServiceSSL) {
    sock = tls.connect({ socket: sock, cert: pair.HostCertificate as Buffer, key: pair.HostPrivateKey as Buffer, rejectUnauthorized: false });
    await new Promise<void>((resolve, reject) => (sock as tls.TLSSocket).once("secureConnect", () => resolve()).once("error", reject));
  }
  return { sock, done: () => (ctl.destroy(), sock.destroy()) };
}

const OP = { STATUS: 1, DATA: 2, READ_DIR: 3, GET_FILE_INFO: 10, FILE_OPEN: 13, FILE_OPEN_RES: 14, FILE_READ: 15, FILE_CLOSE: 20 } as const;
const MAGIC = Buffer.from("CFA6LPAA", "latin1");

class Afc {
  private buf = Buffer.alloc(0);
  private n = 0;
  private waiter?: (p: { op: number; params: Buffer; data: Buffer }) => void;
  private readonly sock: net.Socket | tls.TLSSocket;
  constructor(sock: net.Socket | tls.TLSSocket) {
    this.sock = sock;
    sock.on("data", (c: Buffer) => {
      this.buf = Buffer.concat([this.buf, c]);
      while (this.buf.length >= 40) {
        const entire = Number(this.buf.readBigUInt64LE(8));
        if (this.buf.length < entire) break;
        const thisLen = Number(this.buf.readBigUInt64LE(16));
        const op = Number(this.buf.readBigUInt64LE(32));
        const pkt = { op, params: this.buf.subarray(40, thisLen), data: this.buf.subarray(thisLen, entire) };
        this.buf = this.buf.subarray(entire);
        const w = this.waiter;
        this.waiter = undefined;
        w?.(pkt);
      }
    });
  }
  private call(op: number, params: Buffer, data = Buffer.alloc(0)) {
    return new Promise<{ op: number; params: Buffer; data: Buffer }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("AFC timeout")), 20_000);
      this.waiter = (p) => (clearTimeout(t), resolve(p));
      const h = Buffer.alloc(40);
      MAGIC.copy(h, 0);
      h.writeBigUInt64LE(BigInt(40 + params.length + data.length), 8);
      h.writeBigUInt64LE(BigInt(40 + params.length), 16);
      h.writeBigUInt64LE(BigInt(this.n++), 24);
      h.writeBigUInt64LE(BigInt(op), 32);
      this.sock.write(Buffer.concat([h, params, data]));
    });
  }
  private static ok(p: { op: number; params: Buffer }, what: string) {
    if (p.op === OP.STATUS) {
      const code = p.params.length >= 8 ? Number(p.params.readBigUInt64LE(0)) : -1;
      if (code !== 0) throw new Error(`AFC ${what} failed (${code})`);
    }
  }
  async readDir(path: string): Promise<string[]> {
    const p = await this.call(OP.READ_DIR, Buffer.from(path + "\0"));
    Afc.ok(p, `list ${path}`);
    return p.data.toString("utf8").split("\0").filter((x) => x && x !== "." && x !== "..");
  }
  async stat(path: string): Promise<Record<string, string>> {
    const p = await this.call(OP.GET_FILE_INFO, Buffer.from(path + "\0"));
    Afc.ok(p, `stat ${path}`);
    const parts = p.data.toString("utf8").split("\0");
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < parts.length; i += 2) out[parts[i]] = parts[i + 1];
    return out;
  }
  async readFile(path: string, max: number): Promise<Buffer> {
    const mode = Buffer.alloc(8);
    mode.writeBigUInt64LE(1n); // read-only
    const o = await this.call(OP.FILE_OPEN, Buffer.concat([mode, Buffer.from(path + "\0")]));
    Afc.ok(o, `open ${path}`);
    const handle = o.params.readBigUInt64LE(0);
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const req = Buffer.alloc(16);
        req.writeBigUInt64LE(handle, 0);
        req.writeBigUInt64LE(1n << 20n, 8); // 1 MB per read
        const r = await this.call(OP.FILE_READ, req);
        Afc.ok(r, `read ${path}`);
        if (!r.data.length) break;
        chunks.push(Buffer.from(r.data));
        total += r.data.length;
        if (total > max) throw new Error("photo too large");
      }
    } finally {
      const c = Buffer.alloc(8);
      c.writeBigUInt64LE(handle);
      await this.call(OP.FILE_CLOSE, c).catch(() => undefined);
    }
    return Buffer.concat(chunks);
  }
}

export type CameraRollItem = { name: string; path: string; modified: Date; size: number };

const PHOTO = /\.(heic|jpe?g|png|gif|webp|dng)$/i;

/** The newest photos in the camera roll (newest first), optionally with their bytes. */
export async function latestPhotos(udid: string, count: number, withData: boolean, maxBytes = 40_000_000): Promise<Array<CameraRollItem & { data?: Buffer }>> {
  const { sock, done } = await startAfc(udid);
  try {
    const afc = new Afc(sock);
    const folders = (await afc.readDir("/DCIM")).filter((f) => /^\d{3}/.test(f)).sort().reverse();
    const out: Array<CameraRollItem & { data?: Buffer }> = [];
    // Newest folders first; within a folder IMG_#### grows over time. Stat a window and sort by mtime.
    const candidates: CameraRollItem[] = [];
    for (const f of folders) {
      const names = (await afc.readDir(`/DCIM/${f}`)).filter((n) => PHOTO.test(n)).sort().reverse().slice(0, Math.max(count * 4, 12));
      for (const n of names) {
        const st = await afc.stat(`/DCIM/${f}/${n}`).catch(() => undefined);
        if (st) candidates.push({ name: n, path: `/DCIM/${f}/${n}`, modified: new Date(Number(BigInt(st.st_mtime ?? "0") / 1_000_000n)), size: Number(st.st_size ?? 0) });
      }
      if (candidates.length >= count * 4) break;
    }
    candidates.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    for (const c of candidates.slice(0, count)) out.push(withData ? { ...c, data: await afc.readFile(c.path, maxBytes) } : c);
    return out;
  } finally {
    done();
  }
}
