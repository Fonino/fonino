// Remembered opt-outs (STOP) per phone and recipient, so an opt-out holds even when the
// reply has scrolled out of the visible transcript. Learned from every conversation we read
// (phone_read_messages, phone_wait_for_reply) and from sends the phone refused; START clears it.
// ~/.agentphone/optouts.json, 0600.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalRecipient } from "@agentphone/agent-runtime";
import { optedOut } from "@agentphone/shared";

export class OptOutStore {
  readonly path: string;
  constructor(path = join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "optouts.json")) {
    this.path = path;
  }
  private read(): Record<string, string> {
    try {
      return existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {};
    } catch {
      return {};
    }
  }
  private write(all: Record<string, string>) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path + ".tmp", JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(this.path + ".tmp", this.path);
  }
  private key = (device: string, to: string) => `${device} ${canonicalRecipient(to)}`;

  isOptedOut(device: string, to: string): boolean {
    return this.key(device, to) in this.read();
  }
  set(device: string, to: string, out: boolean) {
    const all = this.read();
    const k = this.key(device, to);
    if (out === k in all) return;
    if (out) all[k] = new Date().toISOString();
    else delete all[k];
    this.write(all);
  }
  /** Update from a conversation we just read (oldest first). */
  learn(device: string, to: string, messages: Array<{ from: "me" | "them"; text: string }>) {
    const theirs = messages.filter((m) => m.from === "them");
    if (!theirs.length) return; // nothing new said by them: keep what we knew
    this.set(device, to, optedOut(messages));
  }
}
