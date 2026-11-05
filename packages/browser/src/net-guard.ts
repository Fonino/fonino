// The browser runs on the owner's Mac, next to Fonino's own servers (/admin, /mcp) and the home
// network. An agent (or a page it visits) must not be able to point it at any of them.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { DeviceError } from "@agentphone/shared";

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 || // this-network, private, loopback, multicast/reserved
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local (incl. cloud metadata)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) // benchmarking
  );
}

/** True for loopback, private, link-local and other non-public addresses (v4 and v6). */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return privateV4(ip);
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return privateV4(mapped[1]);
    return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s);
  }
  return false;
}

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|home|lan|intranet)$/i;

/** Cheap check without DNS (used for every subresource request): literal private IPs and local names. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  return LOCAL_NAMES.test(h) || isPrivateIp(h) || !h.includes(".") && !isIP(h);
}

export interface GuardOptions {
  /** Tests serve fixture sites on 127.0.0.1. Never set in production. */
  allowPrivate?: boolean;
}

/** Throws unless the URL is a public http(s) address. Resolves the name to catch DNS tricks. */
export async function assertAllowedUrl(raw: string, opts: GuardOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DeviceError("bad_url", `Not a valid URL: ${raw.slice(0, 200)}`, "Pass a full URL such as https://example.com/");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DeviceError("blocked_url", `Only http and https pages can be opened (got ${url.protocol}).`);
  }
  if (url.username || url.password) throw new DeviceError("blocked_url", "URLs with embedded credentials are not allowed.");
  if (opts.allowPrivate) return url;
  const blocked = () =>
    new DeviceError("blocked_url", `${url.hostname} is a local or private address. The browser only opens public websites.`);
  if (isLocalHost(url.hostname)) throw blocked();
  if (!isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
    let addrs: { address: string }[];
    try {
      addrs = await lookup(url.hostname, { all: true });
    } catch {
      throw new DeviceError("dns_failed", `Could not resolve ${url.hostname}.`, "Check the address.");
    }
    if (addrs.some((a) => isPrivateIp(a.address))) throw blocked();
  }
  return url;
}
