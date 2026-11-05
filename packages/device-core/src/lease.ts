// Exclusive per-phone leases that work across processes (CLI, stdio MCP, web bridge,
// HTTP MCP service). A lease is a JSON file created with O_EXCL, so only one holder
// can win; it records the owning pid and an expiry. A lease whose pid is gone or whose
// expiry has passed is stale and may be taken over.
//
// Mutating calls in any process check the lease (see DeviceRegistry): if another
// process holds it, the call is refused. Within the lease-owning process, the caller
// must also present the right leaseId (enforced by the service's tool layer).

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DeviceError } from "@agentphone/shared";

export type Lease = {
  leaseId: string;
  key: string;
  deviceId: string;
  holder: string;
  task: string;
  pid: number;
  acquiredAt: string;
  expiresAt: string;
};

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class LeaseStore {
  readonly dir: string;

  constructor(dir = join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "leases")) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private file(key: string) {
    return join(this.dir, `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  private isLive(l: Lease): boolean {
    return Date.parse(l.expiresAt) > Date.now() && pidAlive(l.pid);
  }

  /** The live lease on this key, or undefined (stale leases are removed). */
  read(key: string): Lease | undefined {
    let l: Lease;
    try {
      l = JSON.parse(readFileSync(this.file(key), "utf8"));
    } catch {
      return undefined;
    }
    if (this.isLive(l)) return l;
    try {
      unlinkSync(this.file(key));
    } catch {
      /* raced with another cleaner */
    }
    return undefined;
  }

  list(): Lease[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.read(f.slice(0, -5)))
      .filter((l): l is Lease => !!l);
  }

  acquire(opts: { key: string; deviceId: string; holder: string; task: string; ttlMs: number }): Lease {
    const lease: Lease = {
      leaseId: randomUUID(),
      key: opts.key,
      deviceId: opts.deviceId,
      holder: opts.holder,
      task: opts.task,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + opts.ttlMs).toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(this.file(opts.key), JSON.stringify(lease, null, 2), { flag: "wx" });
        return lease;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const current = this.read(opts.key); // removes it if stale
        if (current) throw leasedError(current);
      }
    }
    throw new DeviceError("device_leased", `Couldn't acquire ${opts.deviceId}; try again.`);
  }

  /** Extend a lease this process holds. Throws if it's gone or someone else's. */
  renew(key: string, leaseId: string, ttlMs: number): Lease {
    const l = this.read(key);
    if (!l || l.leaseId !== leaseId) {
      throw new DeviceError("lease_invalid", "This lease is no longer valid (expired or released).", "Acquire the phone again with phone_acquire.");
    }
    l.expiresAt = new Date(Date.now() + ttlMs).toISOString();
    writeFileSync(this.file(key), JSON.stringify(l, null, 2));
    return l;
  }

  release(key: string, leaseId?: string): boolean {
    const l = this.read(key);
    if (!l || (leaseId && l.leaseId !== leaseId)) return false;
    try {
      unlinkSync(this.file(key));
      return true;
    } catch {
      return false;
    }
  }

  /** A live lease held by a different process, if any. */
  heldElsewhere(key: string): Lease | undefined {
    const l = this.read(key);
    return l && l.pid !== process.pid ? l : undefined;
  }
}

export function leasedError(l: Lease): DeviceError {
  return new DeviceError(
    "device_leased",
    `${l.deviceId} is in use by ${l.holder} for "${l.task}" until ${l.expiresAt}.`,
    "Wait for it to be released, use a different phone, or (as the owner) run `fonino lease release <device>`.",
  );
}
