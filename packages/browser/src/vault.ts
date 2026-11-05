// Secrets for websites live in the macOS Keychain, one item per (exact origin, kind). Only the
// browser reads them, only to fill a field on that same origin. No MCP tool can read, list or
// write the vault, and the agent never sees a value.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DeviceError } from "@agentphone/shared";
import { SECRET_KINDS, type SecretKind } from "./types.ts";

export interface VaultEntry {
  origin: string;
  kind: SecretKind;
}

export interface Vault {
  has(origin: string, kind: SecretKind): boolean;
  /** The secret for exactly this origin. Throws vault_missing if there is none. */
  get(origin: string, kind: SecretKind): string;
  list(): VaultEntry[];
}

/** "saucedemo.com", "https://www.saucedemo.com/inventory.html" → "https://saucedemo.com" / "https://www.saucedemo.com". */
export function normalizeOrigin(input: string): string {
  const s = input.trim();
  try {
    return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).origin;
  } catch {
    throw new DeviceError("bad_origin", `Not a website address: ${s}`, "Use the site's address, e.g. https://www.example.com");
  }
}

export function assertKind(kind: string): SecretKind {
  if (!(SECRET_KINDS as readonly string[]).includes(kind)) throw new DeviceError("bad_secret_kind", `Unknown secret "${kind}". Use one of: ${SECRET_KINDS.join(", ")}.`);
  return kind as SecretKind;
}

const missing = (origin: string, kind: string) =>
  new DeviceError("vault_missing", `No saved ${kind} for ${origin}.`, `Ask the owner to run: fonino vault add ${origin} ${kind}`);

const home = () => process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone");

/** macOS Keychain via the `security` CLI. Item names (never values) are indexed in ~/.agentphone/vault.json. */
export class KeychainVault implements Vault {
  private readonly keychain?: string;
  private readonly indexPath: string;

  /** `keychain`: a specific keychain file (tests/e2e); default is the user's login keychain. */
  constructor(opts: { keychain?: string; indexPath?: string } = {}) {
    this.keychain = opts.keychain;
    this.indexPath = opts.indexPath ?? join(home(), "vault.json");
  }

  private static service(origin: string) {
    return `fonino-browser:${origin}`;
  }

  private kcArgs(): string[] {
    return this.keychain ? [this.keychain] : [];
  }

  list(): VaultEntry[] {
    if (!existsSync(this.indexPath)) return [];
    try {
      return JSON.parse(readFileSync(this.indexPath, "utf8")) as VaultEntry[];
    } catch {
      return [];
    }
  }

  private saveIndex(entries: VaultEntry[]) {
    mkdirSync(dirname(this.indexPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.indexPath, JSON.stringify(entries, null, 2), { mode: 0o600 });
  }

  has(origin: string, kind: SecretKind): boolean {
    return this.list().some((e) => e.origin === origin && e.kind === kind);
  }

  get(origin: string, kind: SecretKind): string {
    if (!this.has(origin, kind)) throw missing(origin, kind);
    try {
      return execFileSync("security", ["find-generic-password", "-s", KeychainVault.service(origin), "-a", kind, "-w", ...this.kcArgs()], {
        stdio: ["ignore", "pipe", "ignore"],
      }).toString().replace(/\n$/, "");
    } catch {
      throw missing(origin, kind);
    }
  }

  /**
   * Interactive add: `security` itself prompts for the value (hidden input), so the secret never
   * appears in argv, shell history or this process's memory.
   */
  addInteractive(origin: string, kind: SecretKind): boolean {
    const host = new URL(origin).host;
    const r = spawnSync(
      "security",
      ["add-generic-password", "-U", "-s", KeychainVault.service(origin), "-a", kind, "-l", `Fonino browser: ${host} (${kind})`, ...this.kcArgs(), "-w"],
      { stdio: "inherit" },
    );
    if (r.status !== 0) return false;
    this.index(origin, kind);
    return true;
  }

  /** Non-interactive add, for throwaway test keychains only (the value passes through argv). */
  addValueForTesting(origin: string, kind: SecretKind, value: string) {
    execFileSync("security", ["add-generic-password", "-U", "-s", KeychainVault.service(origin), "-a", kind, "-w", value, ...this.kcArgs()], { stdio: "ignore" });
    this.index(origin, kind);
  }

  remove(origin: string, kind: SecretKind): boolean {
    let ok = true;
    try {
      execFileSync("security", ["delete-generic-password", "-s", KeychainVault.service(origin), "-a", kind, ...this.kcArgs()], { stdio: "ignore" });
    } catch {
      ok = false;
    }
    this.saveIndex(this.list().filter((e) => !(e.origin === origin && e.kind === kind)));
    return ok;
  }

  private index(origin: string, kind: SecretKind) {
    const entries = this.list().filter((e) => !(e.origin === origin && e.kind === kind));
    entries.push({ origin, kind });
    this.saveIndex(entries);
  }
}

/** In-memory vault for tests. */
export class MemoryVault implements Vault {
  private readonly items = new Map<string, string>();
  set(origin: string, kind: SecretKind, value: string) {
    this.items.set(`${origin} ${kind}`, value);
    return this;
  }
  has(origin: string, kind: SecretKind) {
    return this.items.has(`${origin} ${kind}`);
  }
  get(origin: string, kind: SecretKind) {
    const v = this.items.get(`${origin} ${kind}`);
    if (v === undefined) throw missing(origin, kind);
    return v;
  }
  list(): VaultEntry[] {
    return [...this.items.keys()].map((k) => {
      const [origin, kind] = k.split(" ");
      return { origin, kind: kind as SecretKind };
    });
  }
}
