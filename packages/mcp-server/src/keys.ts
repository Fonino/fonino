// Customer API keys for the hosted service. The owner's mcp-token stays the admin
// credential; each customer gets their own key, scoped to specific phones.
//
// Keys look like `apk_<id>_<secret>`. Only a SHA-256 of the whole key is stored
// (~/.agentphone/keys.json, 0600), so a leaked keys file can't be used to connect.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalRecipient } from "@agentphone/agent-runtime";

export type ApiKeyRecord = {
  id: string;
  name: string;
  /** sha256 hex of the full key. */
  hash: string;
  /** Friendly device ids this key may use, or "*" for every phone on the host. */
  devices: string[] | "*";
  /** Consequential actions (sending messages, …) wait for the owner's approval. */
  requireApproval: boolean;
  /** If set, phone_send_message only goes to these recipients (canonical form, see canonicalRecipient). */
  allowRecipients?: string[];
  /** Cloud relay: the host (Mac) that serves this key's phones. */
  hostId?: string;
  /** If set, the only apps (bundle ids) this key's agents may operate; otherwise policy.ts defaults. */
  allowApps?: string[];
  /** sha256 of the short sign-in code the customer types on the OAuth consent page. */
  signinHash?: string;
  /** OAuth tokens issued before this (ISO time) are void: set when the sign-in code is reset. */
  tokensValidAfter?: string;
  createdAt: string;
  revokedAt?: string;
};

/** Who is calling: the host owner (admin token) or a customer key. */
export type Principal =
  | { kind: "owner"; id: "owner"; name: "owner" }
  | { kind: "customer"; id: string; name: string; devices: string[] | "*"; requireApproval: boolean; allowRecipients?: string[]; allowApps?: string[] };

export const OWNER: Principal = { kind: "owner", id: "owner", name: "owner" };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function canUseDevice(p: Principal, deviceId: string): boolean {
  return p.kind === "owner" || p.devices === "*" || p.devices.includes(deviceId);
}

/** May this principal text `to`? Owner and keys without an allowlist: anyone. */
export function canMessage(p: Principal, to: string): boolean {
  return p.kind === "owner" || !p.allowRecipients || p.allowRecipients.includes(canonicalRecipient(to));
}

const SIGNIN_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O, 1/I
/** 12 characters from a 32-letter alphabet = 60 bits (XXXX-XXXX-XXXX). */
function newSigninCode(): string {
  const b = randomBytes(12);
  const c = [...b].map((x) => SIGNIN_ALPHABET[x % 32]).join(""); // 256 % 32 == 0: unbiased
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}
const normSignin = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, "");

export class KeyStore {
  readonly path: string;
  constructor(path = join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "keys.json")) {
    this.path = path;
  }

  /** Last good read, used if the file is momentarily unreadable (never crash auth on it). */
  private cache: ApiKeyRecord[] = [];

  list(): ApiKeyRecord[] {
    if (!existsSync(this.path)) return [];
    try {
      this.cache = JSON.parse(readFileSync(this.path, "utf8")) as ApiKeyRecord[];
    } catch {
      /* mid-write elsewhere: use the last good copy */
    }
    return this.cache;
  }

  /** Atomic replace (temp file + rename), so readers never see a half-written file. */
  private save(all: ApiKeyRecord[]) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.cache = all;
  }

  /** Returns the only copy of the secret key; it can't be recovered later. */
  create(name: string, opts: { devices?: string[] | "*"; requireApproval?: boolean; allowRecipients?: string[]; hostId?: string } = {}): { key: string; signinCode: string; record: ApiKeyRecord } {
    const all = this.list();
    if (all.some((k) => k.name === name && !k.revokedAt)) throw new Error(`An active key named "${name}" already exists`);
    const id = randomBytes(4).toString("hex");
    const key = `apk_${id}_${randomBytes(24).toString("base64url")}`;
    const signinCode = newSigninCode();
    const record: ApiKeyRecord = {
      id,
      name,
      hash: sha256(key),
      signinHash: sha256(normSignin(signinCode)),
      devices: opts.devices ?? "*",
      requireApproval: opts.requireApproval ?? true,
      ...(opts.allowRecipients ? { allowRecipients: opts.allowRecipients.map(canonicalRecipient) } : {}),
      ...(opts.hostId ? { hostId: opts.hostId } : {}),
      createdAt: new Date().toISOString(),
    };
    this.save([...all, record]);
    return { key, signinCode, record };
  }

  /** New sign-in code for a key (the old one stops working). */
  resetSignin(idOrName: string): { signinCode: string; record: ApiKeyRecord } {
    const all = this.list();
    const k = all.find((r) => (r.id === idOrName || r.name === idOrName) && !r.revokedAt);
    if (!k) throw new Error(`No active key "${idOrName}"`);
    const signinCode = newSigninCode();
    k.signinHash = sha256(normSignin(signinCode));
    k.tokensValidAfter = new Date().toISOString(); // a leaked code's existing connections end too
    this.save(all);
    return { signinCode, record: k };
  }

  /** Customer for a sign-in code typed on the consent page. */
  authenticateSignin(code: string): Principal | undefined {
    const h = sha256(normSignin(code));
    const rec = this.list().find((r) => !r.revokedAt && r.signinHash === h);
    return rec ? this.toPrincipal(rec) : undefined;
  }

  /** When OAuth tokens for this key start being valid (ms), or 0. */
  tokensValidAfter(id: string): number {
    const t = this.list().find((r) => r.id === id)?.tokensValidAfter;
    return t ? Date.parse(t) : 0;
  }

  /** The host serving a key's phones (cloud relay). */
  hostOf(id: string): string | undefined {
    return this.list().find((r) => r.id === id && !r.revokedAt)?.hostId;
  }

  /** Attach a key to the host that serves its phones (keys made before the account had one). */
  setHost(id: string, hostId: string) {
    const all = this.list();
    const k = all.find((r) => r.id === id && !r.revokedAt);
    if (!k || k.hostId) return;
    k.hostId = hostId;
    this.save(all);
  }

  /** Current principal for a key id (undefined once revoked): OAuth tokens re-check this on every use. */
  principalFor(id: string): Principal | undefined {
    const rec = this.list().find((r) => r.id === id && !r.revokedAt);
    return rec ? this.toPrincipal(rec) : undefined;
  }

  private toPrincipal(rec: ApiKeyRecord): Principal {
    return { kind: "customer", id: rec.id, name: rec.name, devices: rec.devices, requireApproval: rec.requireApproval, allowRecipients: rec.allowRecipients, allowApps: rec.allowApps };
  }

  /** Replace a key's recipient allowlist; undefined removes it (anyone). */
  setAllowlist(idOrName: string, recipients: string[] | undefined): ApiKeyRecord {
    const all = this.list();
    const k = all.find((r) => (r.id === idOrName || r.name === idOrName) && !r.revokedAt);
    if (!k) throw new Error(`No active key "${idOrName}"`);
    if (recipients) k.allowRecipients = recipients.map(canonicalRecipient);
    else delete k.allowRecipients;
    this.save(all);
    return k;
  }

  /** Replace which devices a key may use ("*" = all, e.g. ["iphone-002", "browser-001"]). */
  setDevices(idOrName: string, devices: string[] | "*"): ApiKeyRecord {
    const all = this.list();
    const k = all.find((r) => (r.id === idOrName || r.name === idOrName) && !r.revokedAt);
    if (!k) throw new Error(`No active key "${idOrName}"`);
    if (devices !== "*" && (!devices.length || devices.some((d) => !/^[\w:.-]{1,64}$/.test(d)))) throw new Error("devices must be '*' or a comma-separated list of device ids");
    k.devices = devices;
    this.save(all);
    return k;
  }

  revoke(idOrName: string): ApiKeyRecord {
    const all = this.list();
    const k = all.find((r) => (r.id === idOrName || r.name === idOrName) && !r.revokedAt);
    if (!k) throw new Error(`No active key "${idOrName}"`);
    k.revokedAt = new Date().toISOString();
    this.save(all);
    return k;
  }

  /** Customer principal for a presented key, or undefined. Re-reads the file so revocation is immediate. */
  authenticate(presented: string): Principal | undefined {
    const m = presented.match(/^apk_([0-9a-f]{8})_[A-Za-z0-9_-]+$/);
    if (!m) return undefined;
    const rec = this.list().find((r) => r.id === m[1]);
    if (!rec || rec.revokedAt) return undefined;
    const a = Buffer.from(sha256(presented), "hex");
    const b = Buffer.from(rec.hash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
    return this.toPrincipal(rec);
  }
}
