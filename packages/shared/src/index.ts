// Types shared by every AgentPhone layer (device adapters, runtime, CLI, MCP).
// Coordinates are always in the device's *logical* coordinate space
// (ScreenState.width x ScreenState.height). Adapters guarantee that screenshots
// they return are rendered at that same size, so a screenshot pixel == a tap point.

export type ScreenState = {
  deviceId: string;
  timestamp: string;

  width: number;
  height: number;
  /** e.g. "PORTRAIT" / "LANDSCAPE" when the adapter knows it. */
  orientation?: string;
  /** Bundle id of the app in front (e.g. "com.apple.springboard" = Home Screen), when known. */
  foregroundApp?: string;

  screenshotPath?: string;
  screenshotBase64?: string;
  /** sha256 of the PNG bytes (exact equality only; animations defeat it). */
  screenshotHash?: string;
  /**
   * Something the host (not the phone UI) is reporting, e.g. "Mac authentication required".
   * Agents must surface it rather than act on it.
   */
  notice?: string;
  /** Coarse grayscale grid (base64 bytes) for perceptual change detection; see screenChange(). */
  signature?: string;
};

/**
 * Fraction (0..1) of the screen that visibly changed between two screenshots.
 * Uses the coarse signature when both have one, else falls back to exact hash equality.
 * Tiny animations (a clock hand, a blinking cursor) stay well under 0.01.
 */
export function screenChange(a: ScreenState, b: ScreenState): number {
  if (a.signature && b.signature) {
    const x = Buffer.from(a.signature, "base64");
    const y = Buffer.from(b.signature, "base64");
    if (x.length === y.length && x.length > 0) {
      let changed = 0;
      for (let i = 0; i < x.length; i++) if (Math.abs(x[i] - y[i]) > 18) changed++;
      return changed / x.length;
    }
  }
  return a.screenshotHash && a.screenshotHash === b.screenshotHash ? 0 : 1;
}

/**
 * Change near the given points only (fraction of signature cells within `radius` screen points of
 * any point that changed). An animated ad elsewhere on the page doesn't count. Falls back to
 * screenChange() without signatures.
 */
export function regionChange(a: ScreenState, b: ScreenState, points: Array<[number, number]>, radius = 70): number {
  if (!a.signature || !b.signature || !a.width || !a.height) return screenChange(a, b);
  const x = Buffer.from(a.signature, "base64");
  const y = Buffer.from(b.signature, "base64");
  const W = 48;
  const H = 104;
  if (x.length !== W * H || y.length !== W * H) return screenChange(a, b);
  let total = 0;
  let changed = 0;
  for (let gy = 0; gy < H; gy++) {
    for (let gx = 0; gx < W; gx++) {
      const px = ((gx + 0.5) / W) * a.width;
      const py = ((gy + 0.5) / H) * a.height;
      if (!points.some(([tx, ty]) => Math.hypot(px - tx, py - ty) <= radius)) continue;
      total++;
      if (Math.abs(x[gy * W + gx] - y[gy * W + gx]) > 18) changed++;
    }
  }
  return total ? changed / total : 0;
}

/** Below this, treat the screen as unchanged. */
export const UNCHANGED_THRESHOLD = 0.004;

export type ConnectionState =
  | "connected" // observable and controllable right now
  | "disconnected" // known device, but not currently reachable
  | "unavailable"; // present but something is missing (permissions, WDA not running, ...)

export type DeviceInfo = {
  /** Stable, human-friendly id (e.g. "iphone-001"); every operation takes this. */
  id: string;
  /** The adapter's own id (UDID, "iphone-mirror", ...). */
  nativeId?: string;
  name: string;
  /** Which adapter controls this device, e.g. "iphone-mirroring", "iphone-wda". */
  adapter: string;
  status: ConnectionState;
  detail?: string;
};

export type DeviceStatus = DeviceInfo & {
  width?: number;
  height?: number;
  capabilities: DeviceCapabilities;
  checks: StatusCheck[];
};

export type DeviceCapabilities = {
  screenshot: boolean;
  tap: boolean;
  swipe: boolean;
  type: boolean;
  home: boolean;
  appSwitcher: boolean;
  keys: SpecialKey[];
  /** True if input moves the host's real cursor / steals focus (so only one device at a time). */
  usesHostInput: boolean;
};

export type StatusCheck = { name: string; ok: boolean; detail?: string; fix?: string };

export type SpecialKey = "return" | "delete" | "escape" | "tab" | "space" | "up" | "down" | "left" | "right";

export type Risk = "normal" | "external_communication" | "purchase" | "authentication" | "destructive";

export const RISKS: readonly Risk[] = ["normal", "external_communication", "purchase", "authentication", "destructive"];

export class DeviceError extends Error {
  readonly code: string;
  readonly fix?: string;
  /** Extra fields returned to the agent with the error (e.g. an approval link). */
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, fix?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DeviceError";
    this.code = code;
    this.fix = fix;
    this.details = details;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// CTIA-style keywords (a message that is just the keyword, or starts with it), plus "please stop"
// and common Spanish/French equivalents.
const OPT_OUT = /^(?:please\s+)?(stop|stopall|stop all|unsubscribe|cancel|end|quit|opt[- ]?out|revoke|alto|baja|arr[eê]t|arreter|arrêter)\b/i;
const OPT_IN = /^(start|unstop|yes|subscribe|opt[- ]?in)[.!]?$/i;

/** Did the other person opt out (STOP, UNSUBSCRIBE…) without opting back in (START) afterwards? */
export function optedOut(items: Array<{ from: "me" | "them"; text: string }>): boolean {
  let out = false;
  for (const m of items) {
    if (m.from !== "them") continue;
    if (OPT_OUT.test(m.text.trim())) out = true;
    else if (OPT_IN.test(m.text.trim())) out = false;
  }
  return out;
}

export * from "./relay.ts";

/** Largest money amount in an approval's details ("Total: $53.99" → 53.99), if any. */
export function maxAmount(text?: string): number | undefined {
  const xs = [...(text ?? "").matchAll(/[$€£]\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
  return xs.length ? Math.max(...xs) : undefined;
}

/** "Allow for this task": how long it lasts, and the spending cap (approved amount + 20% for tax/shipping). */
export const TASK_APPROVAL_MS = 30 * 60_000;
export function taskCap(payload?: string): number | undefined {
  const a = maxAmount(payload);
  return a === undefined ? undefined : Math.ceil(a * 1.2 * 100) / 100;
}

// ---- "Always allow" standing approval rules (made on the approval page, applied on the Mac) ----

/** Daily cap per standing rule, so a runaway assistant can't spam from the owner's account. */
export const RULE_PER_DAY = 25;

/** What a rule is about, from the operation the assistant declared. Order matters: most specific first. */
const KINDS: Array<[string, string, RegExp]> = [
  ["connection_request", "connection requests", /connection[ _-]?request|\binvit|\bconnect\b/],
  ["follow", "follows", /\bfollow/],
  ["like", "likes and upvotes", /\blike\b|upvote|\breact/],
  ["comment", "comments and replies", /comment|repl(y|ies)/],
  ["post", "posts", /\bpost\b|publish|tweet/],
  ["message", "messages", /message|\bdm\b|\btext\b|imessage|\bsms\b|email/],
];

export function ruleKind(operation: string): { kind: string; label: string } | undefined {
  const op = operation.toLowerCase().replace(/_/g, " ");
  const k = KINDS.find(([, , re]) => re.test(op));
  return k ? { kind: k[0], label: k[1] } : undefined;
}

/** "LinkedIn (Emma Bennet)" and "linkedin" are the same app. */
export const appKey = (app: string) => app.replace(/\(.*?\)/g, "").trim().toLowerCase();

/** Can this request become a standing rule? (The approval page only offers "Always allow" then.) */
export function ruleable(risk: string, spec: { app: string; operation: string }): { kind: string; label: string } | undefined {
  if (risk !== "external_communication" || !appKey(spec.app)) return undefined;
  return ruleKind(spec.operation);
}
