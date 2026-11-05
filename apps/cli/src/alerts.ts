// Owner alerts from the WDA watchdog: a Mac notification, plus a POST to
// AGENTPHONE_ALERT_WEBHOOK if set (Slack/Discord-style {"text": "..."} body).
//
// Only real problems: a phone that needs a person (untrusted, Developer Mode, locked…)
// right away; a phone that stays down for longer than the watchdog's own restarts
// (DOWN_GRACE_MS); and "back online" once an alerted phone is healthy again.

import { execFile } from "node:child_process";

export type Health = "healthy" | "starting" | "down" | "needs_human" | "untrusted";
export type Notify = (title: string, message: string) => void;

export const DOWN_GRACE_MS = 90_000;

export function defaultNotify(webhook = process.env.AGENTPHONE_ALERT_WEBHOOK): Notify {
  return (title, message) => {
    const q = (x: string) => x.replace(/[\\"\u0000-\u001f\u007f]/g, " ").slice(0, 200);
    execFile("osascript", ["-e", `display notification "${q(message)}" with title "${q(title)}" sound name "Basso"`], () => {});
    if (webhook) {
      fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `*${title}*\n${message}` }) }).catch(() => {});
    }
  };
}

export class HealthAlerter {
  private readonly state = new Map<string, { health: Health; since: number; alerted: boolean; timer?: NodeJS.Timeout }>();
  private readonly notify: Notify;
  private readonly graceMs: number;
  constructor(notify: Notify = defaultNotify(), graceMs = DOWN_GRACE_MS) {
    this.notify = notify;
    this.graceMs = graceMs;
  }

  update(phone: string, health: Health, detail?: string) {
    const prev = this.state.get(phone);
    if (prev?.health === health) return;
    if (prev?.timer) clearTimeout(prev.timer);
    const next = { health, since: Date.now(), alerted: prev?.alerted ?? false, timer: undefined as NodeJS.Timeout | undefined };
    this.state.set(phone, next);
    if (health === "healthy") {
      if (next.alerted) this.notify(`AgentPhone: ${phone} is back`, "The phone is healthy again.");
      next.alerted = false;
    } else if (health === "needs_human" || health === "untrusted") {
      this.notify(`AgentPhone: ${phone} needs you`, detail ?? (health === "untrusted" ? "The phone doesn't trust this Mac / the developer certificate." : "Something on the phone needs a person."));
      next.alerted = true;
    } else if (health === "down" || health === "starting") {
      // Restarts normally recover in seconds: only alert if it stays unhealthy.
      next.timer = setTimeout(() => {
        const cur = this.state.get(phone);
        if (cur && cur.health !== "healthy" && !cur.alerted) {
          this.notify(`AgentPhone: ${phone} is offline`, `Not healthy for ${Math.round(this.graceMs / 1000)} s${detail ? `: ${detail}` : ""}. Check the cable/hub and that it's unlocked.`);
          cur.alerted = true;
        }
      }, this.graceMs);
      next.timer.unref?.();
    }
  }
}
