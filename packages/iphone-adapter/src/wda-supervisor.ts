// Keeps WebDriverAgent running on every attached, trusted iPhone.
//
// Every few seconds: list phones via usbmuxd, health-check WDA's /status through the
// usbmuxd tunnel, and (re)start `xcodebuild test-without-building` for any phone
// whose WDA is down. Already-running WDAs (started elsewhere) are adopted, not
// duplicated. Failures back off exponentially; errors only a human can fix
// (untrusted developer certificate, Developer Mode off, locked phone) are flagged
// and retried slowly instead of spinning.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dropAgents, keepAliveAgent, staleReuse } from "./keepalive.ts";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GoiosTunnel, goiosPath, helperBundleId, runwdaArgs, useGoios } from "./goios.ts";
import { isTrusted, listMuxDevices, muxConnect, type MuxDevice } from "./usbmux.ts";

export type PhoneHealth = "healthy" | "starting" | "down" | "needs_human" | "untrusted";

export type SupervisedPhone = {
  udid: string;
  health: PhoneHealth;
  detail?: string;
  restarts: number;
  /** PID of the xcodebuild we launched (undefined if adopted or not running). */
  pid?: number;
  adopted: boolean;
  lastHealthyAt?: number;
  lastStatusMs?: number;
  /** Consecutive failed health checks. */
  misses?: number;
};

type Internal = SupervisedPhone & {
  child?: ChildProcess;
  startedAt?: number;
  failures: number;
  nextAttemptAt: number;
  logPath: string;
};

const WDA_PORT = Number(process.env.AGENTPHONE_WDA_PORT ?? 8100);
const START_GRACE_MS = 120_000; // xcodebuild + app launch can take a while
/**
 * Consecutive failed health checks before a running WDA is killed. Tested: WDA can be
 * busy for several seconds (e.g. waiting for an app to idle after a swipe); killing it
 * on the first missed check caused an outage mid-task.
 */
const FAILS_BEFORE_RESTART = 3;
const STATUS_TIMEOUT_MS = 8000;
const HUMAN_RETRY_MS = 60_000;
export const HEALTH_FILE = "health.json";

const HUMAN_ERRORS: Array<[RegExp, string]> = [
  // A full iPhone also shows up as the automation-mode timeout below, so this comes first.
  [/isn.t enough storage|Failed to create bundle directory/i, "the iPhone is out of storage — free up at least 2 GB (Settings → General → iPhone Storage)"],
  [/Developer App Certificate is not trusted|not been explicitly trusted/i, "trust the developer certificate on the phone (Settings → General → VPN & Device Management)"],
  [/Developer Mode disabled|Developer Mode is turned off/i, "enable Developer Mode on the phone (Settings → Privacy & Security)"],
  [/provisioning profile has expired|No Accounts: Add a new account|profile cannot be installed on this device/i, "the phone helper needs a new Apple signing (it expired, or this iPhone is new) — open Xcode → Settings → Accounts, sign in with your Apple ID, then unplug and replug the iPhone"],
  [/Timed out while enabling automation mode/i, "the iPhone is asking for its passcode (the prompt says “XCTest”: that's Fonino's helper) — unlock the iPhone and enter it; it asks again only after the iPhone restarts (if no prompt shows, turn on Settings → Developer → Enable UI Automation)"],
  [/device was still locked|is locked/i, "unlock the phone (and set Auto-Lock to Never)"],
  // go-ios (no Xcode): the phone refuses to open a helper whose signing it doesn't accept.
  [/pidFromResponse|failed to launch app/i, "the iPhone wouldn't open the Fonino helper — if Settings → General → VPN & Device Management lists it, tap Trust; otherwise unplug and replug the iPhone so Fonino renews it"],
  [/Fonino helper isn't on this iPhone/, "the Fonino helper isn't on this iPhone yet — open Fonino on the Mac to install it"],
];

function defaultXctestrun(): string | undefined {
  const build = process.env.AGENTPHONE_WDA_BUILD ?? fileURLToPath(new URL("../../../vendor/wda-build", import.meta.url));
  const dir = join(build, "Build/Products");
  if (!existsSync(dir)) return undefined;
  const f = readdirSync(dir).find((x) => x.endsWith(".xctestrun"));
  return f ? join(dir, f) : undefined;
}

/** GET a WDA path through the usbmuxd tunnel (a kept-alive connection) and parse the JSON body. */
async function wdaGet(dev: MuxDevice, path: string, timeoutMs = 4000, retried = false): Promise<any> {
  // WDA dies after ~2,500 connections: health checks every few seconds must reuse one.
  const agent = keepAliveAgent(`sup:${dev.udid}:${dev.deviceId}`, () => muxConnect(dev.deviceId, WDA_PORT), 1);
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = http.request({ host: "127.0.0.1", port: WDA_PORT, path, method: "GET", timeout: timeoutMs, agent }, (res) => {
      answered = true;
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (staleReuse(req, e, answered) && !retried) return resolve(wdaGet(dev, path, timeoutMs, true));
      reject(e);
    });
    req.end();
  });
}

/**
 * True if the phone is locked right now. Tested: a locked phone makes
 * `xcodebuild test-without-building` wait indefinitely without any error.
 */
function isLocked(udid: string): Promise<boolean | undefined> {
  const out = join(tmpdir(), `agentphone-lock-${udid}-${Date.now()}.json`);
  return new Promise((resolve) => {
    execFile("xcrun", ["devicectl", "device", "info", "lockState", "--device", udid, "--json-output", out], { timeout: 20000 }, () => {
      try {
        resolve(JSON.parse(readFileSync(out, "utf8")).result?.passcodeRequired === true);
      } catch {
        resolve(undefined);
      } finally {
        rmSync(out, { force: true });
      }
    });
  });
}

export class WdaSupervisor {
  private readonly phones = new Map<string, Internal>();
  private readonly xctestrun?: string;
  /** Start the helper with go-ios instead of xcodebuild (Fonino for Mac: no Xcode). */
  private readonly goios: boolean;
  private readonly tunnel = new GoiosTunnel();
  private readonly logDir: string;
  private readonly only?: Set<string>;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  onChange?: (phones: SupervisedPhone[], changed: SupervisedPhone) => void;

  constructor(opts: { udids?: string[]; xctestrun?: string; logDir?: string } = {}) {
    const x = opts.xctestrun ?? defaultXctestrun();
    this.goios = useGoios(!!x);
    if (!x && !this.goios) throw new Error("No WebDriverAgent build found. Run: scripts/wda.sh setup <udid> [<udid>…]");
    this.xctestrun = x;
    this.logDir = opts.logDir ?? join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "wda");
    mkdirSync(this.logDir, { recursive: true });
    this.only = opts.udids?.length ? new Set(opts.udids) : undefined;
  }

  snapshot(): SupervisedPhone[] {
    return [...this.phones.values()].map(({ udid, health, detail, restarts, pid, adopted, lastHealthyAt, lastStatusMs }) => ({
      udid, health, detail, restarts, pid, adopted, lastHealthyAt, lastStatusMs,
    }));
  }

  private set(p: Internal, health: PhoneHealth, detail?: string) {
    const changed = p.health !== health || p.detail !== detail;
    p.health = health;
    p.detail = detail;
    if (changed) {
      this.onChange?.(this.snapshot(), this.snapshot().find((x) => x.udid === p.udid)!);
      this.saveHealth();
    }
  }

  /** The MCP service runs in another process: it reads this to tell assistants what a person must fix. */
  private saveHealth() {
    try {
      const out = Object.fromEntries([...this.phones.values()].map((x) => [x.udid, { health: x.health, detail: x.detail, at: new Date().toISOString() }]));
      const f = join(this.logDir, HEALTH_FILE);
      writeFileSync(f + ".tmp", JSON.stringify(out));
      renameSync(f + ".tmp", f);
    } catch {
      /* best effort */
    }
  }

  private async launch(p: Internal) {
    const log = createWriteStream(p.logPath, { flags: "a" });
    log.write(`\n=== ${new Date().toISOString()} starting WDA (attempt ${p.failures + 1}${this.goios ? ", go-ios" : ""})\n`);
    dropAgents(`sup:${p.udid}:`); // connections to the old WDA are dead
    // Bind WDA (commands :8100 and screen stream :9100) to the phone's loopback only. usbmux
    // traffic from this Mac arrives there; without this, anyone on the phone's Wi-Fi can drive
    // the unlocked phone with no auth. Set AGENTPHONE_WDA_LAN=1 only for the Wi-Fi transport.
    const lan = process.env.AGENTPHONE_WDA_LAN === "1";
    let child: ChildProcess;
    if (this.goios) {
      await this.tunnel.ensure();
      for (let i = 0; i < 20 && !(await this.tunnel.ready(p.udid)); i++) await new Promise((r) => setTimeout(r, 1000));
      const bundle = await helperBundleId(p.udid);
      if (!bundle) {
        log.end("Fonino helper isn't on this iPhone\n=== helper exited with 1\n");
        return;
      }
      child = spawn(goiosPath()!, runwdaArgs(p.udid, bundle, lan), { stdio: ["ignore", "pipe", "pipe"] });
    } else {
      child = spawn("xcodebuild", ["test-without-building", "-xctestrun", this.xctestrun!, "-destination", `id=${p.udid}`], {
        stdio: ["ignore", "pipe", "pipe"],
        env: lan ? process.env : { ...process.env, TEST_RUNNER_USE_IP: "127.0.0.1" },
      });
    }
    child.stdout!.pipe(log, { end: false });
    child.stderr!.pipe(log, { end: false });
    child.on("exit", (code) => {
      log.write(`=== ${this.goios ? "go-ios" : "xcodebuild"} exited with ${code}\n`);
      log.end();
      if (p.child === child) {
        p.child = undefined;
        p.pid = undefined;
      }
    });
    p.child = child;
    p.pid = child.pid;
    p.adopted = false;
    p.startedAt = Date.now();
    this.set(p, "starting", `${this.goios ? "go-ios" : "xcodebuild"} pid ${child.pid}`);
  }

  /** Reads the tail of this phone's log for errors a human must fix. */
  private humanError(p: Internal): string | undefined {
    if (!existsSync(p.logPath)) return undefined;
    const tail = readFileSync(p.logPath, "utf8").slice(-200_000); // one failed attempt logs ~15 KB of diagnostics
    const start = tail.lastIndexOf("starting WDA (attempt");
    const lastRun = start >= 0 ? tail.slice(start) : tail; // only the latest attempt (not just its exit line)
    return HUMAN_ERRORS.find(([re]) => re.test(lastRun))?.[1];
  }

  private async checkPhone(dev: MuxDevice) {
    let p = this.phones.get(dev.udid);
    if (!p) {
      p = { udid: dev.udid, health: "down", restarts: 0, adopted: false, failures: 0, nextAttemptAt: 0, logPath: join(this.logDir, `${dev.udid}.log`) };
      this.phones.set(dev.udid, p);
    }
    if (!(await isTrusted(dev.udid))) return this.set(p, "untrusted", 'unlock the phone and tap "Trust This Computer"');

    try {
      // One request per check (it proves WDA answers and reads the lock state): every connection counts.
      const t = Date.now();
      const j = await wdaGet(dev, "/wda/locked", STATUS_TIMEOUT_MS);
      p.lastStatusMs = Date.now() - t;
      p.failures = 0;
      p.misses = 0;
      if (!p.child && p.health !== "healthy" && p.health !== "needs_human") p.adopted = true; // someone else started it
      // WDA up is not enough: iOS refuses every UI action while the phone is locked.
      const locked = typeof j?.value === "boolean" ? j.value : undefined;
      if (locked === true) return this.set(p, "needs_human", "phone is locked — unlock it and set Auto-Lock to Never");
      // Unknown lock state is not "unlocked": report it rather than claiming healthy.
      if (locked === undefined) return this.set(p, "starting", "WDA up but lock state unknown — rechecking");
      p.lastHealthyAt = Date.now();
      return this.set(p, "healthy", p.adopted ? "adopted (started outside the supervisor)" : undefined);
    } catch {
      /* not reachable — decide below */
    }

    const now = Date.now();
    if (await isLocked(dev.udid)) {
      // Don't burn restarts on a locked phone: xcodebuild would just hang.
      return this.set(p, "needs_human", "phone is locked — unlock it and set Auto-Lock to Never");
    }
    if (p.health === "needs_human" && p.detail?.startsWith("phone is locked")) {
      p.nextAttemptAt = 0; // just unlocked: start right away
      p.child?.kill();
      p.child = undefined;
    }
    if (p.child && p.startedAt && now - p.startedAt < START_GRACE_MS) {
      const human = this.humanError(p);
      if (human) {
        p.child.kill();
        p.nextAttemptAt = now + HUMAN_RETRY_MS;
        return this.set(p, "needs_human", human);
      }
      return; // still starting
    }
    // A WDA that was healthy may just be busy: tolerate a few missed checks first.
    p.misses = (p.misses ?? 0) + 1;
    if (p.lastHealthyAt && p.misses < FAILS_BEFORE_RESTART) {
      return this.set(p, p.health === "healthy" ? "healthy" : p.health, `not answering (${p.misses}/${FAILS_BEFORE_RESTART} checks) — waiting before restart`);
    }
    if (p.child) {
      // Unhealthy past the grace period and several checks: kill and restart.
      p.child.kill();
      p.child = undefined;
    }
    // A run that failed fast (bad signing, Developer Mode off…) exits before the check above sees it.
    const human = this.humanError(p);
    if (now < p.nextAttemptAt) {
      if (human) this.set(p, "needs_human", human);
      return;
    }
    if (p.lastHealthyAt || p.failures > 0) p.restarts++; // every launch after the first
    p.failures++;
    p.nextAttemptAt = now + (human ? HUMAN_RETRY_MS : Math.min(300_000, 15_000 * 2 ** Math.min(p.failures - 1, 5)));
    await this.launch(p);
    if (human) this.set(p, "needs_human", human); // keep telling the person while it retries
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const devices = (await listMuxDevices().catch(() => [] as MuxDevice[])).filter(
        (d) => d.connectionType === "USB" && (!this.only || this.only.has(d.udid)),
      );
      await Promise.all(devices.map((d) => this.checkPhone(d).catch(() => undefined)));
      for (const p of this.phones.values()) {
        if (!devices.some((d) => d.udid === p.udid) && p.health !== "down") {
          p.child?.kill();
          this.set(p, "down", "unplugged");
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  async start(intervalMs = 5000) {
    await this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const p of this.phones.values()) p.child?.kill();
    this.tunnel.stop();
  }
}
