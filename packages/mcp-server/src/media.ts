// Images an assistant wants on the phone (phone_save_image): fetched or decoded here, checked to be a
// real image, then served to the phone at a short-lived unguessable URL (through the cloud relay).
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { crc32 } from "node:zlib";
import { DeviceError } from "@agentphone/shared";
import { privateAddress } from "./oauth.ts";

export const MAX_IMAGE_BYTES = 20_000_000;
const TTL_MS = 10 * 60_000;

/** Image type from the file's first bytes (never trust a Content-Type header or file name). */
export function sniffImage(b: Buffer): { ext: string; mime: string } | undefined {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", mime: "image/png" };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (b.length > 6 && (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a")) return { ext: "gif", mime: "image/gif" };
  if (b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return { ext: "webp", mime: "image/webp" };
  if (b.length > 12 && b.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|mif1|msf1|heim|heis)$/.test(b.subarray(8, 12).toString("latin1"))) return { ext: "heic", mime: "image/heic" };
  return undefined;
}

/** Strict base64 → bytes. Buffer.from skips invalid characters silently, which turns a garbled string into a "valid" broken image. */
export function decodeBase64Image(s: string): Buffer {
  const b64 = s.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64) || b64.length % 4 === 1) {
    throw new DeviceError("corrupt_image", "image_base64 isn't valid base64.", "Pass a public https image_url instead (base64 typed out by a model is often garbled).");
  }
  return Buffer.from(b64, "base64");
}

/**
 * Is the file complete and undamaged? Models that type out base64 by hand often change a few
 * characters: the header still says PNG/JPEG, but the pixels come out black or smeared. PNG chunks
 * carry checksums; the other formats get end-of-file checks.
 */
export function imageIntact(b: Buffer, ext: string): boolean {
  if (ext === "png") {
    let o = 8;
    while (o + 12 <= b.length) {
      const len = b.readUInt32BE(o);
      if (o + 12 + len > b.length) return false;
      const type = b.subarray(o + 4, o + 8);
      if (crc32(b.subarray(o + 4, o + 8 + len)) !== b.readUInt32BE(o + 8 + len)) return false;
      o += 12 + len;
      if (type.toString("latin1") === "IEND") return true;
    }
    return false;
  }
  if (ext === "jpg") {
    let e = b.length;
    while (e > 2 && (b[e - 1] === 0 || b[e - 1] === 0x0a || b[e - 1] === 0x0d)) e--; // tolerate trailing padding
    return b[e - 2] === 0xff && b[e - 1] === 0xd9;
  }
  if (ext === "gif") return b[b.length - 1] === 0x3b;
  if (ext === "webp") return b.readUInt32LE(4) + 8 <= b.length;
  return true;
}

/** Download an image over HTTPS from a public address (no internal networks), ≤ 20 MB, ≤ 3 redirects. */
export async function fetchImage(url: string, redirects = 3): Promise<Buffer> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new DeviceError("bad_image_url", "That isn't a valid URL.");
  }
  if (u.protocol !== "https:") throw new DeviceError("bad_image_url", "Only https:// image links are supported.", "Pass the image itself as image_base64 instead.");
  const addrs = isIP(u.hostname) ? [{ address: u.hostname, family: isIP(u.hostname) }] : await lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw new DeviceError("bad_image_url", "That address isn't reachable from Fonino.");
  const { address, family } = addrs[0];
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: u.hostname, path: u.pathname + u.search, port: u.port || 443, timeout: 20_000, headers: { "user-agent": "Fonino/1.0 (image fetch)", accept: "image/*" },
        lookup: ((_h: string, o: { all?: boolean }, cb: (e: Error | null, a: unknown, f?: number) => void) => (o?.all ? cb(null, [{ address, family }]) : cb(null, address, family))) as never },
      (res: http.IncomingMessage) => {
        const loc = res.headers.location;
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc && redirects > 0) {
          res.resume();
          return resolve(fetchImage(new URL(loc, u).toString(), redirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new DeviceError("image_fetch_failed", `The image link answered HTTP ${res.statusCode}.`));
        }
        const chunks: Buffer[] = [];
        let n = 0;
        res.on("data", (c: Buffer) => {
          n += c.length;
          if (n > MAX_IMAGE_BYTES) {
            req.destroy();
            reject(new DeviceError("image_too_large", "The image is larger than 20 MB."));
          } else chunks.push(c);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", () => reject(new DeviceError("image_fetch_failed", "The download was interrupted.")));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => reject(e instanceof DeviceError ? e : new DeviceError("image_fetch_failed", `Couldn't download the image (${e.message}).`)));
  });
}

/** Short-lived image URLs for the phone to download. */
export class MediaStore {
  private readonly items = new Map<string, { buf: Buffer; mime: string; exp: number }>();
  put(buf: Buffer, mime: string, ext: string): string {
    const now = Date.now();
    for (const [k, v] of this.items) if (v.exp < now) this.items.delete(k);
    if (this.items.size > 200) this.items.delete(this.items.keys().next().value!);
    const token = randomBytes(24).toString("base64url");
    this.items.set(`${token}.${ext}`, { buf, mime, exp: now + TTL_MS });
    return `${token}.${ext}`;
  }
  get(name: string) {
    const v = this.items.get(name);
    return v && v.exp > Date.now() ? v : undefined;
  }
  delete(name: string) {
    this.items.delete(name);
  }
}
