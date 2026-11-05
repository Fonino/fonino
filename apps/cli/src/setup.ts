// `fonino setup`: the BYOF setup wizard. A local web page (127.0.0.1 only, secret per run)
// that checks each step itself and says exactly what to do when a person is needed:
//
//   1 Sign in       "Sign in this Mac": code approved at app.fonino.app → host token saved
//   2 Xcode         installed and ready (needed to put the Fonino helper on the iPhone)
//   3 iPhone        plugged in by USB and trusting this Mac
//   4 Dev Mode      Developer Mode on (Settings → Privacy & Security)
//   5 Apple ID      an "Apple Development" signing identity in Xcode (free Apple ID is fine)
//   6 Helper        build + install WebDriverAgent, then "Trust" it on the iPhone
//   7 Settings      Auto-Lock Never, previews hidden, no Face ID on Messages (checklist)
//   8 Go live       background services + connected to the Fonino cloud
//
// Fonino for Mac (FONINO_APP=1) skips Xcode and the Apple ID: go-ios reveals Developer Mode and
// installs a helper Fonino signs for this iPhone, and the services start it with go-ios.
//
// Security: binds 127.0.0.1, checks Host, needs the per-run key (in the URL it opens) on every
// API call, and never shows the host token (it goes straight into ~/.agentphone/relay.json).

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const REPO = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const HOME = process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone");
const API = process.env.FONINO_API ?? "https://api.fonino.app";
const PORTAL = process.env.FONINO_PORTAL ?? "https://app.fonino.app";
/** Running inside Fonino for Mac: no Xcode, no Apple ID (see header). */
const APP = process.env.FONINO_APP === "1";

type StepState = "done" | "todo" | "working" | "blocked";
type Step = { id: string; title: string; state: StepState; detail: string; action?: string; label?: string; link?: string; /** something is happening on the iPhone right now */ watch?: boolean };

async function sh(cmd: string, args: string[], timeout = 20_000): Promise<string> {
  const { stdout } = await pexec(cmd, args, { timeout, maxBuffer: 20_000_000 });
  return stdout;
}
const relayPath = () => join(HOME, "relay.json");
const setupPath = () => join(HOME, "setup.json");
function readJson<T>(p: string): T | undefined {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return undefined;
  }
}
function writePrivate(p: string, v: unknown) {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(v, null, 2), { mode: 0o600 });
}

export type SetupEngine = Awaited<ReturnType<typeof createEngine>>;

/** The setup steps and actions, shared by the browser wizard and `fonino setup <step>` (for AI agents). */
export async function createEngine(opts: { openBrowser?: boolean; autopilot?: boolean } = {}) {
  let signin: { deviceCode: string; userCode: string; url: string; exp: number; error?: string } | undefined;
  let helper: { running: boolean; log: string; ok?: boolean } = { running: false, log: "" };
  const settings = readJson<{ settingsConfirmed?: boolean; autoLockSet?: boolean; chargeLimitSet?: boolean }>(setupPath()) ?? {};
  let cache: { at: number; steps: Step[] } | undefined;

  async function iphone(): Promise<{ udid?: string; name?: string; paired?: boolean; devMode?: string; error?: string }> {
    try {
      const { listMuxDevices, isTrusted } = await import("@agentphone/iphone-adapter");
      const usb = (await listMuxDevices()).filter((d) => d.connectionType === "USB");
      if (!usb.length) return {};
      const udid = usb[0].udid;
      const paired = await isTrusted(udid);
      let name: string | undefined;
      let devMode: string | undefined;
      if (paired && APP) {
        const { devModeStatus, lockdownGetValues, modelName } = await import("@agentphone/iphone-adapter");
        devMode = await devModeStatus(udid);
        const v = await lockdownGetValues(usb[0].deviceId, ["DeviceName", "ProductType"]).catch(() => ({}) as Record<string, string>);
        name = v.DeviceName ?? modelName(v.ProductType);
      } else if (paired) {
        const out = join(HOME, "setup-device.json");
        await sh("xcrun", ["devicectl", "device", "info", "details", "--device", udid, "--quiet", "--json-output", out], 30_000).catch(() => "");
        const r = readJson<{ result?: { deviceProperties?: { developerModeStatus?: string; name?: string }; hardwareProperties?: { marketingName?: string } } }>(out)?.result;
        devMode = r?.deviceProperties?.developerModeStatus;
        name = r?.hardwareProperties?.marketingName ?? r?.deviceProperties?.name;
      }
      return { udid, name, paired, devMode };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  async function xcode(): Promise<{ ok: boolean; detail: string }> {
    try {
      const path = (await sh("xcode-select", ["-p"])).trim();
      if (!path.includes("Xcode")) return { ok: false, detail: "Xcode isn't installed (or the command-line tools point elsewhere)." };
      const v = (await sh("xcodebuild", ["-version"])).split("\n")[0];
      return { ok: true, detail: v };
    } catch {
      return { ok: false, detail: "Xcode isn't installed yet, or needs to be opened once to finish installing." };
    }
  }

  async function team(): Promise<{ id?: string; label?: string }> {
    try {
      const ids = await sh("security", ["find-identity", "-v", "-p", "codesigning"]);
      const m = ids.match(/"(Apple Development: [^"]+)"/);
      if (!m) return {};
      const pem = await sh("security", ["find-certificate", "-c", m[1], "-p"]);
      const subj = await new Promise<string>((resolve) => {
        const p = spawn("openssl", ["x509", "-noout", "-subject"]);
        let out = "";
        p.stdout.on("data", (c) => (out += c));
        p.on("close", () => resolve(out));
        p.stdin.end(pem);
      });
      const ou = subj.match(/OU\s*=\s*([A-Z0-9]{10})/)?.[1];
      return { id: ou, label: m[1] };
    } catch {
      return {};
    }
  }

  async function helperHealthy(udid?: string): Promise<boolean> {
    if (!udid) return false;
    try {
      const { createDefaultRegistry } = await import("@agentphone/iphone-adapter");
      const devs = await createDefaultRegistry().listDevices();
      return devs.some((d) => d.nativeId === udid && d.status === "connected");
    } catch {
      return false;
    }
  }

  async function servicesUp(): Promise<{ wda: boolean; mcp: boolean; relay: boolean }> {
    const svc = await import("./service.ts");
    const st = await svc.status();
    const log = existsSync(join(HOME, "logs", "mcp.log")) ? readFileSync(join(HOME, "logs", "mcp.log"), "utf8").slice(-4000) : "";
    const lastRelay = log.split("\n").filter((l) => l.startsWith("relay:")).pop() ?? "";
    return { wda: !!st.find((s) => s.name === "wda")?.running, mcp: !!st.find((s) => s.name === "mcp")?.running, relay: lastRelay.startsWith("relay: connected") };
  }

  async function steps(force = false): Promise<Step[]> {
    if (!force && cache && Date.now() - cache.at < 2500) return cache.steps;
    if (APP) return appSteps();
    const out: Step[] = [];
    const relay = readJson<{ hostToken?: string }>(relayPath());
    out.push(relay?.hostToken
      ? { id: "signin", title: "Sign in", state: "done", detail: "This Mac is connected to your Fonino account." }
      : signin && signin.exp > Date.now()
        ? { id: "signin", title: "Sign in", state: "working", detail: `Approve this Mac in your browser. Code: ${signin.userCode}`, link: signin.url, ...(signin.error ? { detail: signin.error } : {}) }
        : { id: "signin", title: "Sign in", state: "todo", detail: "Connect this Mac to your Fonino account.", action: "signin" });
    const xc = APP ? { ok: true, detail: "" } : await xcode();
    if (!APP) out.push(xc.ok ? { id: "xcode", title: "Xcode", state: "done", detail: xc.detail } : { id: "xcode", title: "Xcode", state: "todo", detail: `${xc.detail} Install it from the App Store (free, large download), open it once, then come back.`, link: "macappstore://apps.apple.com/app/id497799835" });
    const ph = await iphone();
    out.push(!ph.udid
      ? { id: "iphone", title: "iPhone", state: "todo", detail: "Plug your iPhone into this Mac with a USB cable and unlock it." }
      : !ph.paired
        ? { id: "iphone", title: "iPhone", state: "todo", detail: "On the iPhone, tap “Trust This Computer” and enter the iPhone passcode." }
        : { id: "iphone", title: "iPhone", state: "done", detail: `${ph.name ?? "iPhone"} is connected and trusts this Mac.` });
    out.push(ph.devMode === "enabled"
      ? { id: "devmode", title: "Developer Mode", state: "done", detail: "On." }
      : { id: "devmode", title: "Developer Mode", state: ph.paired && xc.ok ? "todo" : "blocked", detail: "On the iPhone: Settings → Privacy & Security → Developer Mode → On. The iPhone restarts; unlock it and confirm “Turn On”.", ...(APP && ph.paired ? { action: "devmode" } : {}) });
    const tm = APP ? { id: "fonino", label: "Fonino" } : await team();
    if (!APP) out.push(tm.id
      ? { id: "appleid", title: "Apple ID in Xcode", state: "done", detail: `Signing as ${tm.label}.` }
      : { id: "appleid", title: "Apple ID in Xcode", state: xc.ok ? "todo" : "blocked", detail: "Open Xcode → Settings → Accounts → + → Apple ID and sign in (a free Apple ID works). Then select it → Manage Certificates → + → Apple Development." });
    const healthy = (await helperHealthy(ph.udid)) || (APP && !!ph.udid && ph.devMode === "enabled" && !helper.running && !!(await appHelperInstalled(ph.udid)));
    out.push(healthy
      ? { id: "helper", title: "Fonino helper on the iPhone", state: "done", detail: "Installed and answering." }
      : helper.running
        ? { id: "helper", title: "Fonino helper on the iPhone", state: "working", detail: "Building and installing (a few minutes the first time)…" }
        : { id: "helper", title: "Fonino helper on the iPhone", state: ph.devMode === "enabled" && tm.id ? "todo" : "blocked",
            detail: helper.ok === false && APP
              ? `Install failed: ${helper.log.trim().split("\n").pop()}`
              : helper.ok === false
              ? "Install failed. If the iPhone shows “Untrusted Developer”: Settings → General → VPN & Device Management → your Apple ID → Trust, then try again."
              : helper.ok
                ? APP ? "Installed. Keep the iPhone unlocked." : "Installed. On the iPhone: Settings → General → VPN & Device Management → your Apple ID → Trust. Then keep the iPhone unlocked."
                : "Installs the small app that lets Fonino see and tap the screen.",
            action: ph.devMode === "enabled" && tm.id ? "helper" : undefined });
    out.push(settings.settingsConfirmed
      ? { id: "settings", title: "iPhone settings", state: "done", detail: "Confirmed." }
      : { id: "settings", title: "iPhone settings", state: "todo", detail: `${APP ? "Settings → Developer → Enable UI Automation · " : ""}Auto-Lock → Never · Notifications → Show Previews → Never · long-press Messages → Don't Require Face ID · Battery → Charging → 80% limit.`, action: "settings" });
    const up = await servicesUp();
    out.push(up.wda && up.mcp && up.relay
      ? { id: "live", title: "Go live", state: "done", detail: `Running and connected. Now connect your assistant at ${PORTAL}.`, link: PORTAL }
      : { id: "live", title: "Go live", state: out.every((s) => s.state === "done") ? "todo" : "blocked", detail: "Starts Fonino in the background (it restarts by itself) and connects it to the cloud.", action: "live" });
    cache = { at: Date.now(), steps: out };
    return out;
  }

  // ---- Fonino for Mac: the person only does what Apple requires on the phone (Trust, Developer Mode,
  // UI Automation) and one click to connect; everything else starts by itself (autopilot) and tells
  // them to watch the iPhone while Fonino changes its settings.
  const tried = new Set<string>();
  let devmodeNote: string | undefined;

  /** Settings Fonino changes on the phone itself, in order (one Settings session at a time). */
  const TWEAKS = [
    { key: "autoLockSet", id: "autolock", title: "Keep it awake", required: true, fn: "setAutoLockNever" as const,
      doing: "Fonino is setting Auto-Lock to Never right now. Why: a locked iPhone stops your assistant mid-task.",
      done: "Auto-Lock is on Never, so your assistant never finds a locked screen.",
      manual: "Couldn't do this one for you. On the iPhone: Settings → Display & Brightness → Auto-Lock → Never." },
    { key: "chargeLimitSet", id: "battery", title: "Protect the battery", required: false, fn: "setChargeLimit80" as const,
      doing: "Fonino is setting the charge limit to 80%. Why: your iPhone stays plugged in all day, and sitting at 100% wears a battery out much faster.",
      done: "Charge limit is 80%. Your battery will thank you.",
      manual: "Skipped: this iPhone has no charge limit setting (it's on iPhone 15 and newer), or it moved. Optional: Settings → Battery → Charging → 80%." },
  ];
  const tweak: Record<string, { tries: number; next: number; running: boolean }> = Object.fromEntries(TWEAKS.map((t) => [t.key, { tries: 0, next: 0, running: false }]));
  const gaveUp = (k: string) => tweak[k].tries >= 3 && !tweak[k].running;
  const tweakDone = (k: string) => !!(settings as Record<string, unknown>)[k];

  function phoneHealth(udid?: string): { health?: string; detail?: string } {
    if (!udid) return {};
    return readJson<Record<string, { health: string; detail?: string }>>(join(HOME, "wda", "health.json"))?.[udid] ?? {};
  }

  async function appSteps(): Promise<Step[]> {
    const out: Step[] = [];
    const relay = readJson<{ hostToken?: string }>(relayPath());
    const signedIn = !!relay?.hostToken;
    out.push(signedIn
      ? { id: "signin", title: "Connect this Mac", state: "done", detail: "Connected to your Fonino account." }
      : signin && signin.exp > Date.now()
        ? { id: "signin", title: "Connect this Mac", state: "working", detail: `We opened your browser. Check the code matches, then click “Connect this Mac”. Code: ${signin.userCode}`, link: signin.url }
        : { id: "signin", title: "Connect this Mac", state: "todo", detail: signin?.error ?? "One click to link this Mac to your Fonino account.", action: "signin", label: "Connect this Mac" });
    const ph = await iphone();
    out.push(!ph.udid
      ? { id: "iphone", title: "Plug in your iPhone", state: "todo", detail: "Plug your iPhone into this Mac with a USB cable and unlock it." }
      : !ph.paired
        ? { id: "iphone", title: "Plug in your iPhone", state: "todo", detail: "Tap “Trust” on your iPhone and enter its passcode. Just this once.", watch: true }
        : { id: "iphone", title: "Plug in your iPhone", state: "done", detail: `Say hi to ${ph.name ?? "your iPhone"}.` });
    const devOn = ph.devMode === "enabled";
    out.push(devOn
      ? { id: "devmode", title: "Developer Mode", state: "done", detail: "On. This is what lets Fonino's helper run." }
      : { id: "devmode", title: "Developer Mode", state: ph.paired ? (devmodeNote ? "working" : "todo") : "blocked", watch: ph.paired,
          detail: devmodeNote ?? "Apple asks you to switch this on yourself, for any app that helps operate an iPhone. It's safe: nothing on your phone changes, and you can switch it off anytime. Your iPhone restarts once (about a minute)." });
    const health = phoneHealth(ph.udid);
    const installed = devOn && !!ph.udid && (health.health === "healthy" || !!(await appHelperInstalled(ph.udid)));
    out.push(installed
      ? { id: "helper", title: "Fonino helper", state: "done", detail: "Installed. It's how your assistant sees and taps the screen." }
      : helper.running
        ? { id: "helper", title: "Fonino helper", state: "working", detail: "Installing Fonino's helper on your iPhone (about a minute)…" }
        : { id: "helper", title: "Fonino helper", state: devOn && signedIn ? "todo" : "blocked",
            detail: helper.ok === false ? `That didn't work: ${helper.log.trim().split("\n").pop()}` : "Installs by itself once the steps above are done.",
            ...(helper.ok === false ? { action: "helper", label: "Try again" } : {}) });
    const up = await servicesUp();
    const running = up.wda && up.mcp;
    const healthy = running && health.health === "healthy"; // the file can be left over from before a restart
    const uiAuto = /UI Automation/i.test(health.detail ?? "");
    const passcode = /asking for its passcode/i.test(health.detail ?? ""); // iOS's "Enter iPhone Passcode for XCTest" prompt
    out.push(healthy
      ? { id: "uiauto", title: "UI Automation", state: "done", detail: "On." }
      : { id: "uiauto", title: "UI Automation", state: installed && running ? (uiAuto ? "todo" : "working") : "blocked", watch: uiAuto,
          detail: passcode
            ? "Your iPhone may be asking for its passcode, in a prompt that says “XCTest”: that's Fonino's helper asking to use the screen. Unlock the iPhone and enter it. No prompt? Turn on Settings → Developer → Enable UI Automation."
            : uiAuto || !installed
              ? "Last switch, promise: Settings → Developer → Enable UI Automation. Keep the iPhone unlocked. If it asks for your passcode for “XCTest”, that's Fonino's helper: enter it."
              : "Waking up the helper…" });
    for (const t of TWEAKS) {
      const st = tweak[t.key];
      out.push(tweakDone(t.key)
        ? { id: t.id, title: t.title, state: "done", detail: t.done }
        : gaveUp(t.key)
          ? t.required
            ? { id: t.id, title: t.title, state: "todo", detail: t.manual, action: "settings", label: "I've done it" }
            : { id: t.id, title: t.title, state: "done", detail: t.manual }
          : { id: t.id, title: t.title, state: healthy ? "working" : "blocked", watch: healthy && st.running,
              detail: healthy && st.running ? t.doing : "Fonino does this one for you. Sit back." });
    }
    const live = healthy && up.relay && TWEAKS.every((t) => !t.required || tweakDone(t.key)) && TWEAKS.every((t) => tweakDone(t.key) || gaveUp(t.key));
    out.push(live
      ? { id: "live", title: "You're live", state: "done", detail: "Your assistant can use your iPhone now. Close this window anytime: Fonino keeps running in the background.", link: PORTAL }
      : { id: "live", title: "You're live", state: "blocked", detail: "Almost there." });
    cache = { at: Date.now(), steps: out };
    reportProgress(out, ph, relay?.hostToken);
    if (opts.autopilot) void autopilot(out, ph, { signedIn, installed, running, healthy });
    return out;
  }

  // Where people stop in setup: the first step that isn't done, sent to Fonino whenever it changes
  // (an anonymous per-install id; the Mac's token once it's signed in, so it shows on the account).
  let reported: string | undefined;
  function reportProgress(st: Step[], ph: { udid?: string; paired?: boolean }, token?: string) {
    const next = st.find((x) => x.state !== "done");
    let at = next ? next.id : "live";
    if (at === "iphone") at = ph.udid ? "iphone:trust" : "iphone:plug";
    if (at === "uiauto" && next?.watch) at = "uiauto:phone"; // waiting on the iPhone (switch or passcode)
    if (at === reported) return;
    reported = at;
    let install = readJson<{ id?: string }>(join(HOME, "install.json"))?.id;
    if (!install) writePrivate(join(HOME, "install.json"), { id: (install = randomBytes(12).toString("hex")) });
    void fetch(`${API}/app/progress`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ install, at }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => (reported = undefined)); // try again on the next refresh
  }

  async function autopilot(st: Step[], ph: Awaited<ReturnType<typeof iphone>>, f: { signedIn: boolean; installed: boolean; running: boolean; healthy: boolean }) {
    const once = (k: string) => (tried.has(k) ? false : (tried.add(k), true));
    const state = (id: string) => st.find((x) => x.id === id)?.state;
    try {
      if (!f.signedIn && state("signin") === "todo" && once("signin")) await startSignin();
      if (ph.udid && ph.paired && ph.devMode === "disabled" && once(`devmode:${ph.udid}`)) {
        const { goios, revealDevMode: reveal } = await import("@agentphone/iphone-adapter");
        // No passcode on the phone: go-ios can turn it on and confirm after the restart by itself.
        const on = await goios(["devmode", "enable", "--enable-post-restart", `--udid=${ph.udid}`], 180_000).then(() => true, () => false);
        if (on) devmodeNote = "Your iPhone is restarting to switch on Developer Mode. Unlock it when it's back.";
        else {
          await reveal(ph.udid).catch(() => undefined);
          devmodeNote = undefined;
        }
        cache = undefined;
      }
      if (ph.devMode === "enabled") devmodeNote = undefined;
      if (ph.udid && f.signedIn && ph.devMode === "enabled" && !f.installed && !helper.running && helper.ok === undefined && once(`helper:${ph.udid}`)) void installAppHelper(ph.udid);
      if (f.installed && !f.running && once("live")) await goLive();
      // Phone settings, one at a time, a few tries each (the helper can still be settling right after it starts).
      if (f.healthy && ph.udid && !TWEAKS.some((t) => tweak[t.key].running)) {
        const t = TWEAKS.find((x) => !tweakDone(x.key) && tweak[x.key].tries < 3 && Date.now() >= tweak[x.key].next);
        if (t) {
          const st = tweak[t.key];
          st.running = true;
          st.tries++;
          st.next = Date.now() + 15_000;
          cache = undefined;
          const adapter = await import("@agentphone/iphone-adapter");
          const ok = await adapter[t.fn](ph.udid).catch(() => false);
          st.running = false;
          if (ok) {
            (settings as Record<string, unknown>)[t.key] = true;
            writePrivate(setupPath(), { ...readJson<object>(setupPath()), [t.key]: true });
          }
          cache = undefined;
        }
      }
    } catch {
      /* the page shows each step's state; the person can retry */
    }
  }

  async function startSignin() {
    const r = await fetch(`${API}/device/code`, { method: "POST" });
    if (!r.ok) throw new Error(`Fonino didn't answer (${r.status}). Check the internet connection.`);
    const c = (await r.json()) as { device_code: string; user_code: string; verification_uri_complete: string; expires_in: number; interval: number };
    signin = { deviceCode: c.device_code, userCode: c.user_code, url: c.verification_uri_complete, exp: Date.now() + c.expires_in * 1000 };
    const poll = async () => {
      if (!signin || signin.deviceCode !== c.device_code || Date.now() > signin.exp) return;
      const t = await fetch(`${API}/device/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_code: c.device_code }) }).catch(() => undefined);
      if (t?.status === 428 || !t) return void setTimeout(poll, c.interval * 1000);
      const j = (await t.json().catch(() => ({}))) as { host_token?: string; relay_url?: string; error?: string };
      if (j.host_token) {
        writePrivate(relayPath(), { url: j.relay_url ?? `${API.replace(/^http/, "ws")}/host`, hostToken: j.host_token });
        signin = undefined;
        cache = undefined;
      } else if (signin) {
        signin.error = j.error === "not_entitled" ? "Your Fonino plan doesn't include connecting a Mac. Check your plan at app.fonino.app." : "That sign-in was cancelled or expired. Try again.";
        signin.exp = 0;
      }
    };
    setTimeout(poll, c.interval * 1000);
    if (opts.openBrowser !== false) open(c.verification_uri_complete);
    return { userCode: c.user_code, url: c.verification_uri_complete };
  }

  async function appHelperInstalled(udid: string) {
    const { helperBundleId } = await import("@agentphone/iphone-adapter");
    return helperBundleId(udid);
  }

  /** Fonino for Mac: Fonino signs the helper for this iPhone; go-ios mounts the developer image and installs it. */
  async function installAppHelper(udid: string) {
    helper = { running: true, log: "" };
    const add = (t: string) => (helper.log = (helper.log + t + "\n").slice(-20_000));
    try {
      const { goios, mountDeveloperImage } = await import("@agentphone/iphone-adapter");
      add("Preparing the iPhone…");
      add(await mountDeveloperImage(udid, join(HOME, "ddi")));
      const relay = readJson<{ hostToken?: string }>(relayPath());
      if (!relay?.hostToken) throw new Error("Sign in first.");
      add("Getting the Fonino helper signed for this iPhone…");
      const r = await fetch(`${API}/host/helper`, { method: "POST", headers: { authorization: `Bearer ${relay.hostToken}`, "content-type": "application/json" }, body: JSON.stringify({ udid }) });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Fonino couldn't sign the helper (${r.status}).`);
      const ipa = join(HOME, "helper.ipa");
      writeFileSync(ipa, Buffer.from(await r.arrayBuffer()));
      add("Installing it on the iPhone…");
      add(await goios(["install", `--path=${ipa}`, `--udid=${udid}`], 300_000));
      helper = { running: false, log: helper.log, ok: true };
    } catch (e) {
      add((e as Error).message);
      helper = { running: false, log: helper.log, ok: false };
    }
    cache = undefined;
  }

  async function revealDevMode() {
    const ph = await iphone();
    if (!ph.udid) throw new Error("Plug in the iPhone first.");
    const { revealDevMode: reveal } = await import("@agentphone/iphone-adapter");
    await reveal(ph.udid);
  }

  async function installHelper() {
    if (helper.running) return;
    if (APP) {
      const ph = await iphone();
      if (!ph.udid || ph.devMode !== "enabled") throw new Error("Finish the steps above first.");
      void installAppHelper(ph.udid); // also the retry after a failed automatic install
      return;
    }
    const tm = await team();
    const ph = await iphone();
    if (!tm.id || !ph.udid) throw new Error("Finish the steps above first.");
    helper = { running: true, log: "" };
    const p = spawn("/bin/sh", [join(REPO, "scripts/wda.sh"), "setup", ph.udid], {
      env: { ...process.env, AGENTPHONE_TEAM_ID: tm.id, AGENTPHONE_BUNDLE: `com.fonino.${tm.id.toLowerCase()}.helper` },
    });
    const add = (c: Buffer) => (helper.log = (helper.log + c.toString()).slice(-20_000));
    p.stdout.on("data", add);
    p.stderr.on("data", add);
    p.on("close", (code) => {
      helper = { running: false, log: helper.log, ok: code === 0 };
      writePrivate(setupPath(), { ...readJson<object>(setupPath()), team: tm.id, helperBuiltAt: new Date().toISOString() });
      cache = undefined;
    });
  }

  async function goLive() {
    const svc = await import("./service.ts");
    await svc.install(APP ? ["wda", "mcp"] : ["wda", "mcp", "resign"]); // Fonino-signed helpers don't expire weekly
    cache = undefined;
  }

  function confirmSettings() {
    settings.settingsConfirmed = true;
    if (APP) settings.autoLockSet = true; // "I've done it" on the Auto-Lock step
    writePrivate(setupPath(), { ...readJson<object>(setupPath()), settingsConfirmed: true, ...(APP ? { autoLockSet: true } : {}) });
    cache = undefined;
  }

  return {
    steps,
    startSignin,
    signinPending: () => !!signin && signin.exp > Date.now(),
    signinError: () => signin?.error,
    installHelper,
    revealDevMode,
    helperState: () => ({ ...helper }),
    confirmSettings,
    goLive,
    invalidate: () => void (cache = undefined),
  };
}

export async function runSetup(opts: { open?: boolean } = {}) {
  const key = randomBytes(18).toString("base64url");
  const engine = await createEngine({ openBrowser: true, autopilot: APP });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const hostOk = /^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? "");
    const send = (s: number, type: string, b: string) =>
      res.writeHead(s, { "content-type": type, "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'" }).end(b);
    if (!hostOk) return send(403, "text/plain", "forbidden");
    if (url.pathname === "/" && url.searchParams.get("k") === key) return send(200, "text/html; charset=utf-8", PAGE);
    if (url.pathname === "/app.js") return send(200, "text/javascript; charset=utf-8", JS);
    const font = url.pathname.match(/^\/fonts\/(Geist-Variable|GeistMono-Variable)\.woff2$/)?.[1]; // the website's typeface (SIL OFL)
    if (font) {
      const f = join(REPO, "assets/fonts", `${font}.woff2`);
      if (!existsSync(f)) return send(404, "text/plain", "");
      res.writeHead(200, { "content-type": "font/woff2", "cache-control": "max-age=86400" }).end(readFileSync(f));
      return;
    }
    if (req.headers["x-setup-key"] !== key) return send(403, "application/json", '{"error":"forbidden"}');
    try {
      if (url.pathname === "/api/steps") return send(200, "application/json", JSON.stringify({ steps: await engine.steps(), helperLog: engine.helperState().log.split("\n").slice(-6).join("\n") }));
      if (req.method === "POST" && url.pathname === "/api/signin") await engine.startSignin();
      else if (req.method === "POST" && url.pathname === "/api/helper") await engine.installHelper();
      else if (req.method === "POST" && url.pathname === "/api/devmode") await engine.revealDevMode();
      else if (req.method === "POST" && url.pathname === "/api/settings") engine.confirmSettings();
      else if (req.method === "POST" && url.pathname === "/api/live") await engine.goLive();
      else return send(404, "application/json", "{}");
      engine.invalidate();
      return send(200, "application/json", JSON.stringify({ steps: await engine.steps(true) }));
    } catch (e) {
      return send(409, "application/json", JSON.stringify({ error: (e as Error).message }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = `http://127.0.0.1:${(server.address() as { port: number }).port}/?k=${key}`;
  console.log(`Fonino setup: ${addr}\n(keep this window open until setup is done; Ctrl+C to quit)`);
  if (opts.open !== false) open(addr);
  return { server, url: addr };
}

function open(u: string) {
  spawn("open", [u], { stdio: "ignore", detached: true }).unref();
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fonino setup</title><style>
@font-face{font-family:Geist;src:url(/fonts/Geist-Variable.woff2) format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Geist Mono";src:url(/fonts/GeistMono-Variable.woff2) format("woff2");font-weight:100 900;font-display:swap}
:root{--bg:#f8f7f2;--surface:#fffefa;--ink:#272b23;--ink-2:#62665b;--mute:#74796c;--line:#dedfd3;--accent:#bd3c2b;--ok:#557646;--warn:#b7791f;color-scheme:light}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 Geist,-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
::selection{background:#edc7b7}.wrap{max-width:680px;margin:0 auto;padding:22px 24px 56px}
.nav{display:flex;align-items:center;justify-content:space-between;padding-bottom:18px;border-bottom:1px solid var(--line)}
.brand{font-size:30px;letter-spacing:-2px;font-weight:750;color:var(--accent);display:inline-flex;gap:4px;line-height:1}.brand span{font-size:22px;align-self:flex-start;line-height:.8}
.nav small{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--mute);display:flex;align-items:center;gap:8px}.dot{width:7px;height:7px;border-radius:50%;background:var(--ok)}
.kicker{text-transform:uppercase;font-size:10px;font-weight:550;letter-spacing:.14em;color:var(--accent);margin:34px 0 12px}
h1{font-weight:500;font-size:44px;line-height:1.05;letter-spacing:-.055em;margin:0 0 12px}h1 em{font-family:Georgia,"Times New Roman",serif;font-weight:400;letter-spacing:-.05em}
.lede{color:var(--ink-2);margin:0 0 26px;max-width:470px}
.step{display:grid;grid-template-columns:40px 1fr;gap:14px;background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:10px 0}
.num{font:500 11px "Geist Mono",ui-monospace,Menlo,monospace;color:var(--mute);width:30px;height:30px;border:1px solid var(--line);border-radius:50%;display:grid;place-items:center}
.done .num{background:var(--ok);border-color:var(--ok);color:#fffdf5;font-size:14px}.working .num{border-color:var(--accent);color:var(--accent)}.blocked{opacity:.5}.todo{border-color:#cfd1c4}
h3{margin:3px 0 4px;font-size:16px;font-weight:550;letter-spacing:-.02em}.detail{color:var(--ink-2);font-size:13.5px}
button,a.btn{font:inherit;font-size:13px;font-weight:600;border:1px solid var(--ink);background:transparent;color:var(--ink);border-radius:6px;min-height:40px;padding:8px 16px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;margin:12px 8px 0 0;transition:background .2s}
button{background:var(--accent);border-color:var(--accent);color:#fffdf5}button:hover{background:#a62f20}a.btn:hover{background:#eaeade}button:disabled{opacity:.6;cursor:wait}
pre{font:12px/1.5 "Geist Mono",ui-monospace,Menlo,monospace;white-space:pre-wrap;color:var(--mute);margin:10px 0 0}.code{font:600 24px "Geist Mono",ui-monospace,Menlo,monospace;letter-spacing:.12em;color:var(--accent);margin-top:6px}
.working{border-color:var(--accent)}.watch{display:inline-flex;gap:8px;align-items:center;font-size:10px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin-top:10px}
.watch i{width:7px;height:7px;border-radius:50%;background:var(--accent);animation:pulse 1.1s ease-in-out infinite}@keyframes pulse{50%{opacity:.25;transform:scale(.7)}}
@media(prefers-reduced-motion:reduce){.watch i{animation:none}}
.howto{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0 2px;padding:0;list-style:none}
.howto li{font-size:11.5px;line-height:1.35;color:var(--ink-2);animation:focus 8s infinite;animation-delay:calc(var(--i) * 2s - 8s)}
.howto b{display:block;font:500 10px "Geist Mono",ui-monospace,Menlo,monospace;color:var(--mute);margin-top:7px}
.mini{aspect-ratio:9/16;border:1.5px solid var(--ink);border-radius:14px;background:#f1f0ea;padding:16px 6px 6px;display:flex;flex-direction:column;gap:4px;overflow:hidden}
.mini p{margin:0 0 2px;font-size:8.5px;font-weight:650;color:var(--ink)}.mini i{display:flex;align-items:center;justify-content:space-between;height:15px;border-radius:4px;background:#fff;font-size:7.5px;font-style:normal;padding:0 5px;color:var(--ink-2)}
.mini i.hi{outline:1.5px solid var(--accent);color:var(--ink);font-weight:650}.mini u{width:16px;height:9px;border-radius:9px;background:var(--ok);display:inline-block}
.mini .dlg{margin:auto 2px;background:#fff;border-radius:8px;padding:6px;font-size:7.5px;text-align:center;color:var(--ink)}.mini .dlg span{display:block;margin-top:5px;color:var(--accent);font-weight:700}
@keyframes focus{0%,22%{opacity:1}26%,96%{opacity:.45}}
@media(prefers-reduced-motion:reduce){.howto li{animation:none}}
@media(max-width:520px){.howto{grid-template-columns:repeat(2,1fr)}}
.foot{margin-top:30px;font-size:11px;color:var(--mute)}.foot a{color:inherit}
</style></head><body><div class="wrap"><div class="nav"><div class="brand">fonino<span>✳</span></div><small><i class="dot"></i>Setup</small></div>
<p class="kicker">Your bot. Its own phone.</p><h1>Set up <em>your</em> Fonino</h1><p class="lede">${APP ? "Sit back: Fonino does most of this for you. When it needs a tap on your iPhone, it'll say so. Your iPhone restarts once along the way: that's normal." : "Each step checks itself. Keep your iPhone plugged in and unlocked."}</p><div id="steps"></div>
<p class="foot">Stuck? Email <a href="mailto:hello@fonino.app">hello@fonino.app</a> with a screenshot.</p></div><script src="/app.js"></script></body></html>`;

const JS = `
const key = new URLSearchParams(location.search).get('k');
const el = (t, p, ...k) => { const e = document.createElement(t); Object.assign(e, p || {}); for (const c of k) e.append(c && c.nodeType ? c : document.createTextNode(c == null ? '' : String(c))); return e; };
async function call(path, method) { const r = await fetch(path, { method: method || 'GET', headers: { 'x-setup-key': key } }); const j = await r.json().catch(() => ({})); if (!r.ok) alert(j.error || 'Something went wrong'); return j; }
const labels = { signin: 'Sign in to Fonino', devmode: 'Show the switch on my iPhone', helper: 'Install the helper', settings: "I've done these", live: 'Go live' };
function render(s) {
  document.getElementById('steps').replaceChildren(...s.steps.map((st, i) => {
    const body = el('div', {}, el('h3', {}, st.title), el('div', { className: 'detail' }, st.detail));
    const m = st.detail.match(/Code: ([A-Z0-9-]+)/); if (m) body.append(el('div', { className: 'code' }, m[1]));
    if (st.link && st.state !== 'blocked') body.append(el('a', { className: 'btn', href: st.link, target: '_blank', rel: 'noopener' }, st.id === 'signin' ? 'Open approval page' : st.id === 'live' ? 'Connect your assistant' : 'Open'));
    if (st.action && st.state === 'todo') { const b = el('button', {}, st.label || labels[st.action]); b.onclick = async () => { b.disabled = true; const j = await call('/api/' + st.action, 'POST'); if (j.steps) render({ steps: j.steps, helperLog: '' }); }; body.append(b); }
    if (st.id === 'devmode' && st.state === 'todo') body.append(devmodeHowto());
    if (st.watch) body.append(el('div', { className: 'watch' }, el('i'), st.state === 'working' ? 'Watch the magic on your iPhone' : 'Your turn, on the iPhone'));
    if (st.id === 'helper' && st.state === 'working' && s.helperLog) body.append(el('pre', {}, s.helperLog));
    return el('div', { className: 'step ' + st.state }, el('div', { className: 'num' }, st.state === 'done' ? '✓' : String(i + 1).padStart(2, '0')), body);
  }));
}
// The four taps for Developer Mode, drawn as little iPhone screens (highlight moves 1 → 4).
function devmodeHowto() {
  const row = (t, hi, toggle) => el('i', { className: hi ? 'hi' : '' }, t, toggle ? el('u') : '');
  const screen = (title, ...rows) => el('div', { className: 'mini' }, el('p', {}, title), ...rows);
  const shots = [
    [screen('Settings', row('Wi-Fi'), row('Bluetooth'), row('Privacy & Security', true), row('Battery')), 'Open Settings → Privacy & Security'],
    [screen('Privacy & Security', row('Location Services'), row('Tracking'), row('…'), row('Developer Mode', true)), 'Scroll to the bottom, tap Developer Mode'],
    [screen('Developer Mode', row('Developer Mode', true, true), el('div', { className: 'dlg' }, 'Restart to turn on Developer Mode?', el('span', {}, 'Restart'))), 'Switch it on, tap Restart'],
    [screen('', el('div', { className: 'dlg' }, 'Turn on Developer Mode?', el('span', {}, 'Turn On'))), 'After the restart: unlock, tap Turn On, enter your passcode'],
  ];
  return el('ol', { className: 'howto' }, ...shots.map(([m, c], i) => { const li = el('li', {}, m, el('b', {}, String(i + 1)), c); li.style.setProperty('--i', i); return li; }));
}
async function tick() { const s = await call('/api/steps'); if (s.steps) render(s); }
tick(); setInterval(tick, 3000);
`;

/**
 * `fonino setup <step>`: the same setup, one command per step, for AI agents (Claude Code etc.)
 * or people who prefer the terminal. Every command prints what happened and what's next.
 */
export async function runSetupCommand(step: string, json: boolean): Promise<number> {
  const engine = await createEngine({ openBrowser: step === "signin" });
  const print = (steps: Awaited<ReturnType<SetupEngine["steps"]>>) => {
    if (json) return console.log(JSON.stringify({ steps, next: steps.find((s) => s.state !== "done")?.id ?? null }, null, 2));
    for (const s of steps) console.log(`${s.state === "done" ? "✓" : s.state === "working" ? "…" : s.state === "blocked" ? "·" : "→"} ${s.title}: ${s.detail}`);
    const next = steps.find((s) => s.state !== "done");
    console.log(next ? `\nNext: ${next.title}${next.action ? ` (run: fonino setup ${next.action === "settings" ? "settings-done" : next.action})` : " (needs the person at the Mac/iPhone; then run: fonino setup status)"}` : "\nAll done. Connect an assistant at https://app.fonino.app");
  };
  if (step === "status") {
    print(await engine.steps(true));
    return 0;
  }
  if (step === "signin") {
    const c = await engine.startSignin();
    console.log(`Approve this Mac at: ${c.url}\nCode shown there: ${c.userCode}\n(Waiting up to 15 minutes…)`);
    while (engine.signinPending()) await new Promise((r) => setTimeout(r, 2000));
    const done = (await engine.steps(true)).find((s) => s.id === "signin")?.state === "done";
    console.log(done ? "✓ This Mac is connected to the Fonino account." : `✗ ${engine.signinError() ?? "Sign-in didn't complete."}`);
    return done ? 0 : 1;
  }
  if (step === "helper") {
    await engine.installHelper();
    process.stdout.write("Building and installing the Fonino helper (a few minutes the first time)");
    while (engine.helperState().running) {
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, 3000));
    }
    const h = engine.helperState();
    console.log(h.ok ? "\n✓ Installed. On the iPhone: Settings → General → VPN & Device Management → your Apple ID → Trust." : `\n✗ Install failed. Last output:\n${h.log.split("\n").slice(-15).join("\n")}`);
    return h.ok ? 0 : 1;
  }
  if (step === "settings-done") {
    engine.confirmSettings();
    console.log("✓ Noted: Auto-Lock Never, previews hidden, no Face ID on Messages, 80% charge limit.");
    return 0;
  }
  if (step === "live") {
    await engine.goLive();
    console.log("✓ Fonino is running in the background and connecting to the cloud. Check with: fonino setup status");
    return 0;
  }
  console.log("usage: fonino setup [status|signin|helper|settings-done|live] [--json]   (no step: opens the setup page)");
  return 1;
}
