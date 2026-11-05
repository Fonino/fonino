#!/usr/bin/env node
// agentphone CLI. Every command goes through device-core's registry, the same one
// the MCP server and web bridge use.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  AnthropicModel,
  ApprovalUnavailableError,
  ScriptedModel,
  defaultRunsDir,
  describeAction,
  runAgent,
  type AgentAction,
  type ApprovalHandler,
  type RunResult,
} from "@agentphone/agent-runtime";
import type { PhoneDevice } from "@agentphone/device-core";
import { createDefaultRegistry } from "@agentphone/iphone-adapter";
import { DeviceError, type SpecialKey } from "@agentphone/shared";
import { runDoctor } from "./doctor.ts";
import { writeReplay } from "./replay.ts";

const USAGE = `fonino — let an AI agent operate a real iPhone

Usage:
  fonino devices                          list phones
  fonino status <device>                  device + setup status
  fonino screen <device> [--out f.png] [--open]
  fonino tap <device> <x> <y>
  fonino swipe <device> <x1> <y1> <x2> <y2> [--duration ms]
  fonino type <device> "text" [--submit]
  fonino key <device> <return|delete|escape|tab|space|up|down|left|right>
  fonino home <device>
  fonino app-switcher <device>
  fonino agent <device> [--goal "..."] [--max-steps 40] [--model id] [--yes-to-all-risky]
  fonino runs [--limit 20]                recent agent runs + metrics
  fonino replay <run-id|dir> [--open]     build an HTML replay of a run
  fonino doctor [--input]                 diagnose setup (--input also tests tapping)
  fonino wda up [udid…]                   keep WebDriverAgent running on USB phones (watchdog)
  fonino mcp                              run the MCP server on stdio (local, trusted clients)
  fonino mcp-http [--port 3001] [--show-token] [--rotate-token]
                                              authenticated Streamable HTTP MCP for cloud agents (Grok Bot)
  fonino approvals | approve <id> [--for-task] | deny <id>   owner decisions for agents' risky actions
  fonino keys create <name> [--devices iphone-001,iphone-002] [--no-approval] [--allow +1628…,a@b.com]
  fonino keys allow <id|name> <+1628…,a@b.com | anyone>   who a key may text
  fonino keys devices <id|name> <iphone-002,browser-001 | *>   which phones / the browser a key may use
  fonino keys signin <id|name>            new sign-in code (for "Connect" in Muse/Grok/Claude via OAuth)
  fonino keys list | keys revoke <id|name>      customer API keys for the hosted service
  fonino usage [--month 2026-09] [--csv]  usage per customer (calls, texts, phone minutes); --csv for billing
  fonino dashboard [--port 3001]          open the owner dashboard (needs mcp-http running)
  fonino service install [--tunnel] | uninstall | restart [name] | status | logs [name]
                                              run wda + mcp-http + tunnel as login services that auto-restart
  fonino setup                            guided setup in your browser (Fonino for Mac / BYOF)
  fonino setup status|signin|helper|settings-done|live [--json]   the same, step by step (for AI agents)
  fonino relay connect <host-token> [--url wss://api.fonino.app/host] | relay status | relay disconnect
                                              serve your phones through the Fonino cloud (no tunnel needed)
  fonino lease list | lease release <device>    exclusive phone leases
  fonino vault add <site> [username|password] | vault list | vault remove <site> [kind]
                                              website logins for the agent browser (macOS Keychain)
  fonino recipes list | show <id> | review | approve <id> | reject <id> | delete <id>
  fonino recipes export <id> | import <file> --task "…" | run <id> [--param name=value …]
                                              browser recipes: tasks an agent did once, replayed without AI
  fonino browser open <url>               check the agent browser and print what an agent sees
  fonino serve [--port 7333]              local HTTP bridge for the web UI

Coordinates are screenshot pixels of \`fonino screen\` (origin top-left).
Env: ANTHROPIC_API_KEY, AGENTPHONE_MODEL, AGENTPHONE_EFFORT, AGENTPHONE_MOCK=1,
     AGENTPHONE_ADAPTERS=mirroring,wda  AGENTPHONE_RESTORE_FOCUS=0
     AGENTPHONE_BROWSER=0 (no browser tools)  AGENTPHONE_BROWSER_ENGINE=chrome|lightpanda  AGENTPHONE_CHROME`;

// Everything this tool writes (tokens, keys, approvals with message text, screenshots, logs)
// is private to this macOS user: files 0600, directories 0700.
process.umask(0o077);

// Load <repo>/.env if present (ANTHROPIC_API_KEY etc.). Real env vars win.
const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    out: { type: "string" },
    open: { type: "boolean" },
    json: { type: "boolean" },
    submit: { type: "boolean" },
    duration: { type: "string" },
    goal: { type: "string" },
    "max-steps": { type: "string" },
    model: { type: "string" },
    limit: { type: "string" },
    port: { type: "string" },
    input: { type: "boolean" },
    script: { type: "string" },
    "yes-to-all-risky": { type: "boolean" },
    "show-token": { type: "boolean" },
    "rotate-token": { type: "boolean" },
    devices: { type: "string" },
    "no-approval": { type: "boolean" },
    "no-tunnel": { type: "boolean" },
    "no-open": { type: "boolean" },
    tunnel: { type: "boolean" },
    allow: { type: "string" },
    url: { type: "string" },
    month: { type: "string" },
    day: { type: "string" },
    csv: { type: "boolean" },
    param: { type: "string", multiple: true },
    task: { type: "string" },
    version: { type: "string" },
    "for-task": { type: "boolean" },
    always: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

const [cmd, ...args] = positionals;
const registry = createDefaultRegistry();

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function need(n: number, what: string) {
  if (args.length < n) throw new DeviceError("bad_args", `usage: fonino ${cmd} ${what}`);
}
function nums(from: number, count: number): number[] {
  return args.slice(from, from + count).map((v, i) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new DeviceError("bad_args", `argument ${from + i + 1} must be a number, got "${v}"`);
    return n;
  });
}
async function device(): Promise<PhoneDevice> {
  if (!args[0]) throw new DeviceError("bad_args", `usage: fonino ${cmd} <device> ...  (see \`fonino devices\`)`);
  return registry.getDevice(args[0]);
}
function ok(msg: string) {
  if (flags.json) console.log(JSON.stringify({ ok: true, message: msg }));
  else console.log(green("✓ ") + msg);
}

function relayConfigPath() {
  return join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "relay.json");
}
function readRelayConfig(): { url: string; hostToken: string } | undefined {
  try {
    const c = JSON.parse(readFileSync(relayConfigPath(), "utf8"));
    return typeof c.url === "string" && typeof c.hostToken === "string" ? c : undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  switch (cmd) {
    case undefined:
    case "help":
      console.log(USAGE);
      return;

    case "devices": {
      const list = await registry.listDevices();
      if (flags.json) return console.log(JSON.stringify(list, null, 2));
      if (!list.length) return console.log("No devices. Run `fonino doctor`.");
      const rows = [["ID", "NAME", "STATUS", "ADAPTER", "DETAIL"], ...list.map((d) => [d.id, d.name, d.status, d.adapter, d.detail ?? ""])];
      const w = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
      for (const [i, r] of rows.entries()) {
        const line = r.map((cell, c) => cell.padEnd(w[c])).join("  ").trimEnd();
        console.log(i === 0 ? dim(line) : line);
      }
      return;
    }

    case "status": {
      const s = await (await device()).getStatus();
      if (flags.json) return console.log(JSON.stringify(s, null, 2));
      console.log(`${s.id}  ${s.name}  [${s.adapter}]  ${s.status === "connected" ? green(s.status) : red(s.status)}`);
      if (s.width) console.log(`screen: ${s.width}x${s.height} points`);
      for (const c of s.checks) console.log(`${c.ok ? green("✓") : red("✗")} ${c.name}${c.detail ? dim(` (${c.detail})`) : ""}${c.ok || !c.fix ? "" : `\n    → ${c.fix}`}`);
      return;
    }

    case "screen": {
      const d = await device();
      const s = await d.getScreen();
      let path = s.screenshotPath!;
      if (flags.out) {
        copyFileSync(path, flags.out as string);
        path = resolve(flags.out as string);
      }
      if (flags.json) console.log(JSON.stringify({ ...s, screenshotPath: path }, null, 2));
      else console.log(`${path}  (${s.width}x${s.height}, ${s.timestamp})`);
      if (flags.open) spawn("open", [path], { stdio: "ignore", detached: true }).unref();
      return;
    }

    case "tap": {
      need(3, "<device> <x> <y>");
      const [x, y] = nums(1, 2);
      await (await device()).tap(x, y);
      return ok(`tapped (${x}, ${y})`);
    }

    case "swipe": {
      need(5, "<device> <x1> <y1> <x2> <y2> [--duration ms]");
      const [x1, y1, x2, y2] = nums(1, 4);
      await (await device()).swipe(x1, y1, x2, y2, flags.duration ? Number(flags.duration) : undefined);
      return ok(`swiped (${x1}, ${y1}) → (${x2}, ${y2})`);
    }

    case "type": {
      need(2, '<device> "text" [--submit]');
      const d = await device();
      await d.type(args[1]);
      if (flags.submit) await d.key("return");
      return ok(`typed ${JSON.stringify(args[1])}${flags.submit ? " + return" : ""}`);
    }

    case "key": {
      need(2, "<device> <key>");
      await (await device()).key(args[1] as SpecialKey);
      return ok(`pressed ${args[1]}`);
    }

    case "home":
      await (await device()).home();
      return ok("home");

    case "app-switcher":
      await (await device()).appSwitcher();
      return ok("app switcher");

    case "agent":
      return agentCommand();

    case "runs":
      return listRuns(Number(flags.limit ?? 20));

    case "replay": {
      need(1, "<run-id|dir>");
      const dir = existsSync(args[0]) ? args[0] : resolve(defaultRunsDir(), args[0]);
      const out = writeReplay(dir);
      console.log(out);
      if (flags.open) spawn("open", [out], { stdio: "ignore", detached: true }).unref();
      return;
    }

    case "doctor": {
      const good = await runDoctor(registry, { input: !!flags.input });
      process.exitCode = good ? 0 : 1;
      return;
    }

    case "wda": {
      if (args[0] === "resign") {
        // Renew the helper's signature (free Apple IDs: 7 days) for every USB iPhone, then restart WDA.
        const cfg = JSON.parse(readFileSync(join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "setup.json"), "utf8")) as { team?: string; bundle?: string };
        if (!cfg.team) throw new DeviceError("not_configured", "No signing team recorded", "Run fonino setup first.");
        const { listMuxDevices } = await import("@agentphone/iphone-adapter");
        const connected = (await listMuxDevices()).filter((d) => d.connectionType === "USB").map((d) => d.udid);
        // --if-stale (the hourly service): only phones not renewed in the last 3 days, so a phone plugged
        // back in after a while is renewed within the hour instead of waiting for the next fixed run.
        const stampFile = join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "resign.json");
        const stamps: Record<string, string> = existsSync(stampFile) ? JSON.parse(readFileSync(stampFile, "utf8")) : {};
        const udids = flags["if-stale"] ? connected.filter((u) => !stamps[u] || Date.now() - Date.parse(stamps[u]) > 3 * 86_400_000) : connected;
        if (!udids.length) return ok(connected.length ? "all connected iPhones were renewed recently" : "no iPhone connected");
        const repo = fileURLToPath(new URL("../../..", import.meta.url));
        const code = await new Promise<number>((r) =>
          spawn("/bin/sh", [join(repo, "scripts/wda.sh"), "setup", ...udids], {
            stdio: "inherit",
            env: { ...process.env, AGENTPHONE_TEAM_ID: cfg.team, AGENTPHONE_BUNDLE: cfg.bundle ?? `com.fonino.${cfg.team!.toLowerCase()}.helper` },
          }).on("exit", (c) => r(c ?? 1)),
        );
        if (code !== 0) throw new DeviceError("resign_failed", "Couldn't renew the helper's signature", "Open Xcode → Settings → Accounts and check your Apple ID is still signed in.");
        for (const u of udids) stamps[u] = new Date().toISOString();
        writeFileSync(stampFile, JSON.stringify(stamps, null, 2));
        const svc = await import("./service.ts");
        await svc.restart(["wda"]).catch(() => undefined);
        return ok(`renewed the helper for ${udids.length} iPhone(s)`);
      }
      if (args[0] !== "up") throw new DeviceError("bad_args", "usage: fonino wda up [udid…] | wda resign");
      const { WdaSupervisor } = await import("@agentphone/iphone-adapter");
      const sup = new WdaSupervisor({ udids: args.slice(1) });
      const color = { healthy: green, starting: yellow, down: red, needs_human: red, untrusted: red } as const;
      const { HealthAlerter } = await import("./alerts.ts");
      const alerts = new HealthAlerter();
      const names = new Map((await registry.listDevices().catch(() => [])).map((d) => [d.nativeId ?? d.id, `${d.id} (${d.name})`]));
      sup.onChange = (_all, p) => {
        console.log(
          `${new Date().toLocaleTimeString()}  ${p.udid}  ${color[p.health](p.health.padEnd(11))}` +
            `${p.restarts ? dim(` restarts=${p.restarts}`) : ""}${p.detail ? dim(`  ${p.detail}`) : ""}`,
        );
        alerts.update(names.get(p.udid) ?? p.udid, p.health, p.detail);
      };
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.on(sig, () => {
          sup.stop(); // kill the xcodebuild children we own, don't orphan them
          process.exit(0);
        });
      }
      console.log(dim("Supervising WebDriverAgent (Ctrl+C to stop; logs in ~/.agentphone/wda/)"));
      await sup.start();
      return;
    }

    case "mcp-http": {
      const { startRemoteMcp, newToken, readToken, KeyStore } = await import("@agentphone/mcp-server");
      const home = process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone");
      const tokenPath = join(home, "mcp-token");
      let token = flags["rotate-token"] ? undefined : readToken(tokenPath);
      if (!token) {
        token = newToken();
        mkdirSync(home, { recursive: true });
        writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
        console.log(yellow(`New bearer token written to ${tokenPath}`));
      }
      const port = Number(flags.port ?? 3001);
      const keys = new KeyStore();
      const relayCfg = readRelayConfig();
      const relaySecret = relayCfg ? randomBytes(32).toString("base64url") : undefined; // in-process only
      const { core } = await startRemoteMcp({ registry, token, port, keys, relaySecret, log: (l) => console.log(l) });
      if (relayCfg && relaySecret) {
        const { startRelayClient } = await import("@agentphone/relay");
        startRelayClient({
          url: relayCfg.url,
          hostToken: relayCfg.hostToken,
          localPort: port,
          secret: relaySecret,
          devices: async () => (await registry.listDevices()).filter((d) => d.status === "connected").map((d) => d.id),
          status: async () => {
            const leases = registry.leases?.list() ?? [];
            return {
              version: "1",
              uptimeS: Math.round(process.uptime()),
              devices: (await registry.listDevices())
                .filter((d) => !d.id.endsWith(":error"))
                .map((d) => {
                  const l = leases.find((x) => x.deviceId === d.id);
                  return { id: d.id, name: d.name, status: d.status, detail: d.detail, lease: l ? { holder: l.holder, task: l.task, until: l.expiresAt } : null };
                }),
              approvals: core.approvals.list("pending").map((r) => ({ id: r.id, deviceId: r.deviceId, holder: r.holder, risk: r.risk, createdAt: r.createdAt, spec: r.spec, code: r.code })),
              usage: core.usage.summary(),
              rules: core.approvals.rules().map(({ id, holder, app, kind, perDay, createdAt }) => ({ id, holder, app, kind, perDay, createdAt })),
            };
          },
          // Only these fleet-dashboard commands exist; the cloud can't run anything else here.
          command: async (op, a) => {
            if (op === "approve" || op === "deny") {
              const r = core.approvals.decide(a.id, op === "approve", a.scope === "task" || a.scope === "always" ? a.scope : "once");
              console.log(`approval ${r.id} ${r.status}${r.scope === "always" ? " (always allow)" : ""} from the fleet dashboard`);
              return { status: r.status };
            }
            if (op === "rule_remove") {
              const removed = core.approvals.removeRule(a.id);
              if (removed) console.log(`approval rule ${a.id} removed from the fleet dashboard`);
              return { removed };
            }
            if (op === "approval_screen") {
              const p = core.approvals.get(a.id)?.screenshotPath;
              return p && p.endsWith(".png") && existsSync(p) ? { png: readFileSync(p).toString("base64") } : {};
            }
            if (op === "live_link") {
              const cloud = relayCfg.url.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/host$/, "");
              const hostId = relayCfg.hostToken.split("_")[1];
              return core.live.link(`${cloud}/h/${hostId}`, a.device, { kind: "owner", principal: "owner" });
            }
            throw new Error("unsupported");
          },
          log: (l) => console.log(l),
        });
        console.log(green(`Fonino cloud: ${relayCfg.url.replace(/^wss:/, "https:").replace(/\/host$/, "")}/mcp`));
      }
      // Keep the Mac awake while serving (idle + system sleep on AC), for as long as we run.
      spawn("caffeinate", ["-i", "-s", "-w", String(process.pid)], { stdio: "ignore", detached: true }).unref();
      console.log(green(`AgentPhone MCP (Streamable HTTP) on http://127.0.0.1:${port}/mcp`));
      console.log(dim(`Auth: header "Authorization: Bearer <token>" — token in ${tokenPath}${flags["show-token"] ? "" : " (--show-token to print)"}`));
      if (flags["show-token"]) console.log(`Token: ${token}`);
      console.log(dim("Expose it with an HTTPS tunnel: scripts/tunnel.sh (keep this Mac awake, on power, phones plugged in)."));
      console.log(dim(`Customer keys: ${keys.list().filter((k) => !k.revokedAt).length} active (fonino keys list).`));
      console.log(dim(`Dashboard (this Mac only): http://127.0.0.1:${port}/admin/ — approve texts there or with \`fonino approve|deny <id>\`.`));
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.on(sig, () => {
          core.releaseAll();
          process.exit(0);
        });
      }
      return;
    }

    case "approvals":
    case "approve":
    case "deny": {
      const { ApprovalQueue } = await import("@agentphone/mcp-server");
      const q = new ApprovalQueue();
      if (cmd === "approvals" && args[0] === "rules") {
        // fonino approvals rules [remove <id>]: the owner's "Always allow" rules
        if (args[1] === "remove") {
          need(3, "rules remove <rule-id>");
          if (!q.removeRule(args[2])) throw new DeviceError("not_found", `No rule ${args[2]}`);
          return ok("Removed. Those actions need your approval again.");
        }
        const rules = q.rules();
        if (!rules.length) return console.log("No always-allow rules.");
        for (const r of rules) console.log(`${r.id}  ${r.kind.replace(/_/g, " ")} in ${r.app}  (${r.holder}, up to ${r.perDay}/day${r.used ? `, ${r.used.n} on ${r.used.day}` : ""})`);
        return;
      }
      if (cmd === "approvals") {
        const pending = q.list("pending");
        if (!pending.length) return console.log("No pending approval requests.");
        for (const r of pending) {
          console.log(yellow(`${r.id}  ${r.risk}  ${r.deviceId}  (${r.holder}, ${r.createdAt})`) + (r.code ? `  code ${r.code}` : ""));
          console.log(`  ${r.spec.summary}\n  app: ${r.spec.app}${r.spec.account ? ` (${r.spec.account})` : ""} · operation: ${r.spec.operation}` +
            `${r.spec.recipient !== undefined ? ` · recipient: ${r.spec.recipient}` : ""}${r.spec.payload !== undefined ? ` · payload: ${JSON.stringify(r.spec.payload)}` : ""}`);
          if (r.screenshotPath) console.log(dim(`  screen: ${r.screenshotPath}`));
        }
        return;
      }
      need(1, "<approval-id>");
      const r = q.decide(args[0], cmd === "approve", flags.always ? "always" : flags["for-task"] ? "task" : "once");
      return ok(`${r.status}${r.scope === "always" ? " (always allowed from now on)" : ""}: ${r.spec.summary}`);
    }

    case "keys": {
      const { KeyStore } = await import("@agentphone/mcp-server");
      const store = new KeyStore();
      if (args[0] === "create") {
        need(2, "create <name> [--devices a,b] [--no-approval]");
        const devices = typeof flags.devices === "string" ? flags.devices.split(",").map((x) => x.trim()).filter(Boolean) : "*";
        const allowRecipients = typeof flags.allow === "string" ? flags.allow.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
        const { key, signinCode, record } = store.create(args[1], { devices, requireApproval: !flags["no-approval"], allowRecipients });
        ok(`key for "${record.name}" (phones: ${devices === "*" ? "all" : devices.join(", ")}; ${record.requireApproval ? "texts need your approval" : "no approval"}; can text ${allowRecipients ? allowRecipients.join(", ") : "anyone"})`);
        console.log(`\n  API key:      ${key}\n  Sign-in code: ${signinCode}\n`);
        console.log(dim("Shown once. Assistants with \"Connect\" (OAuth: Muse, Grok, Claude…) ask for the sign-in code;"));
        console.log(dim("code/clients that take a header use the API key (Authorization: Bearer <key>)."));
        return;
      }
      if (args[0] === "signin") {
        need(2, "signin <id|name>");
        const { signinCode, record } = store.resetSignin(args[1]);
        ok(`new sign-in code for ${record.name}: ${signinCode} (the old one no longer works)`);
        return;
      }
      if (args[0] === "allow") {
        need(3, "allow <id|name> <+1628…,a@b.com | anyone>");
        const list = args[2] === "anyone" ? undefined : args[2].split(",").map((x) => x.trim()).filter(Boolean);
        const k = store.setAllowlist(args[1], list);
        return ok(`${k.name} can text ${k.allowRecipients ? k.allowRecipients.join(", ") : "anyone"}`);
      }
      if (args[0] === "devices") {
        need(3, "devices <id|name> <iphone-002,browser-001 | *>");
        const k = store.setDevices(args[1], args[2] === "*" ? "*" : args[2].split(",").map((x) => x.trim()).filter(Boolean));
        return ok(`${k.name} can use ${k.devices === "*" ? "all devices" : k.devices.join(", ")}`);
      }
      if (args[0] === "revoke") {
        need(2, "revoke <id|name>");
        return ok(`revoked ${store.revoke(args[1]).name}`);
      }
      const all = store.list();
      if (!all.length) return console.log("No API keys. Create one: fonino keys create <customer-name>");
      for (const k of all) {
        const phones = k.devices === "*" ? "all phones" : k.devices.join(", ");
        const who = k.allowRecipients ? `texts only ${k.allowRecipients.join(", ")}` : "texts anyone";
        console.log(`${k.revokedAt ? dim("revoked") : green("active ")}  apk_${k.id}_…  ${k.name}  (${phones}; ${k.requireApproval ? "approval" : "no approval"}; ${who})  created ${k.createdAt.slice(0, 10)}`);
      }
      return;
    }

    case "usage": {
      const { UsageLog } = await import("@agentphone/mcp-server");
      const month = typeof flags.month === "string" ? flags.month : new Date().toISOString().slice(0, 7);
      const rows = new UsageLog().summary(month);
      if (flags.json) return console.log(JSON.stringify(rows, null, 2));
      if (flags.csv) {
        const cell = (v: unknown) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
        console.log("month,customer,key_id,tool_calls,errors,texts_sent,sessions,phone_minutes,phones,last_seen");
        for (const u of rows) console.log([month, u.tenantName, u.tenant, u.calls, u.errors, u.messagesSent, u.leases, u.heldMinutes, u.devices.join(" "), u.lastSeen].map(cell).join(","));
        return;
      }
      if (!rows.length) return console.log(`No usage in ${month}.`);
      console.log(dim(`Usage ${month}`));
      for (const u of rows) {
        console.log(`${u.tenantName.padEnd(20)} ${String(u.calls).padStart(6)} calls  ${String(u.errors).padStart(4)} errors  ${String(u.messagesSent).padStart(4)} texts  ${String(u.leases).padStart(4)} sessions  ${String(u.heldMinutes).padStart(7)} phone-min  [${u.devices.join(", ")}]`);
      }
      return;
    }

    case "service": {
      const svc = await import("./service.ts");
      const sub = args[0] ?? "status";
      const pick = (n?: string) => {
        if (!n) return svc.SERVICES;
        if (!(svc.SERVICES as string[]).includes(n)) throw new DeviceError("bad_args", `unknown service "${n}" (wda, mcp, tunnel)`);
        return [n as (typeof svc.SERVICES)[number]];
      };
      const port = Number(flags.port ?? 3001);
      if (sub === "install") {
        // With the Fonino cloud relay configured, no public tunnel is needed (or wanted).
        const wantTunnel = flags.tunnel === true || (!flags["no-tunnel"] && !readRelayConfig());
        const hasSetup = existsSync(join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "setup.json"));
        const which = svc.SERVICES.filter((s) => (s !== "tunnel" || wantTunnel) && (s !== "resign" || hasSetup));
        // Hand over from copies started by hand, so there's one supervisor and one listener.
        await new Promise((r) => spawn("pkill", ["-f", "apps/cli/src/main.ts (wda up|mcp-http)"], { stdio: "ignore" }).on("exit", r));
        await svc.install(which, port);
        ok(`installed and started: ${which.join(", ")} (start at login, restart on crash; logs in ~/.agentphone/logs/)`);
        console.log(dim("Services start when this user logs in. With FileVault on (recommended: screenshots and messages stay encrypted at rest), macOS can't log in by itself after a power cut. Use `sudo fdesetup authrestart` for planned reboots and an external uptime check to learn of outages."));
        return;
      }
      if (sub === "uninstall") {
        await svc.uninstall(pick(args[1]));
        return ok("removed");
      }
      if (sub === "restart") {
        await svc.restart(pick(args[1]));
        return ok("restarted");
      }
      if (sub === "logs") {
        const s = pick(args[1] ?? "mcp")[0];
        const child = spawn("tail", ["-n", "60", "-f", join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "logs", `${s}.log`)], { stdio: "inherit" });
        await new Promise((r) => child.on("exit", r));
        return;
      }
      if (sub !== "status") throw new DeviceError("bad_args", "usage: fonino service install|uninstall|restart|status|logs");
      const all = await svc.status();
      if (flags.json) return console.log(JSON.stringify({ services: all, publicUrl: svc.publicUrl() }, null, 2));
      for (const s of all) {
        const state = !s.installed ? dim("not installed") : s.running ? green(`running (pid ${s.pid})`) : red(`stopped (last exit ${s.lastExit ?? "?"})`);
        console.log(`${s.name.padEnd(7)} ${state}${s.runs && s.runs > 1 ? dim(`  restarted ${s.runs - 1}×`) : ""}`);
      }
      const url = svc.publicUrl();
      if (url) console.log(`\nPublic MCP URL: ${url}/mcp`);
      return;
    }

    case "setup": {
      if (args[0]) {
        const { runSetupCommand } = await import("./setup.ts");
        process.exitCode = await runSetupCommand(args[0], !!flags.json);
        return;
      }
      const { runSetup } = await import("./setup.ts");
      await runSetup({ open: !flags["no-open"] });
      await new Promise(() => {}); // serve until Ctrl+C
      return;
    }

    case "relay": {
      const path = relayConfigPath();
      if (args[0] === "connect") {
        need(2, "connect <host-token> [--url wss://api.fonino.app/host]");
        if (!/^hst_h[0-9a-f]{10}_[A-Za-z0-9_-]+$/.test(args[1])) throw new DeviceError("bad_args", "That doesn't look like a host token (hst_…)");
        const url = typeof flags.url === "string" ? flags.url : "wss://api.fonino.app/host";
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ url, hostToken: args[1] }, null, 2), { mode: 0o600 });
        ok(`saved; restart the phone service to connect: fonino service restart mcp`);
        return;
      }
      if (args[0] === "disconnect") {
        if (existsSync(path)) writeFileSync(path, "{}", { mode: 0o600 });
        return ok("relay disabled; restart the phone service: fonino service restart mcp");
      }
      const cfg = readRelayConfig();
      console.log(cfg ? `relay: ${cfg.url} (host ${cfg.hostToken.slice(4, 15)})` : "relay: not configured (fonino relay connect <host-token>)");
      return;
    }

    case "dashboard": {
      const { adminLoginToken, readToken } = await import("@agentphone/mcp-server");
      const base = `http://127.0.0.1:${Number(flags.port ?? 3001)}`;
      const up = await fetch(`${base}/admin/`).then(() => true).catch(() => false);
      if (!up) throw new DeviceError("not_running", `Nothing answering at ${base}`, "Start it first: fonino service install (or fonino mcp-http)");
      const token = readToken(join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "mcp-token"));
      if (!token) throw new DeviceError("not_configured", "No owner token yet", "Start fonino mcp-http once to create it.");
      spawn("open", [`${base}/admin/login?t=${adminLoginToken(token)}`], { stdio: "ignore", detached: true }).unref();
      return ok(`opened the dashboard (${base}/admin/); the login link works once, within 60 s`);
    }

    case "vault":
      return (await import("./browser.ts")).vaultCommand(args);
    case "recipes":
      return (await import("./browser.ts")).recipesCommand(args, flags);
    case "browser":
      return (await import("./browser.ts")).browserCommand(args);

    case "lease": {
      const leases = registry.leases!;
      if (args[0] === "release") {
        need(2, "release <device>");
        const d = await registry.getDevice(args[1]);
        const done = leases.release(registry.leaseKeyOf(d.id));
        return done ? ok(`released ${d.id}`) : console.log(`${d.id} had no active lease.`);
      }
      const all = leases.list();
      if (!all.length) return console.log("No active leases.");
      for (const l of all) console.log(`${l.deviceId}  ${l.holder}  "${l.task}"  until ${l.expiresAt}  (pid ${l.pid})`);
      return;
    }

    case "mcp": {
      const { startMcpServer } = await import("@agentphone/mcp-server");
      await startMcpServer(registry);
      return;
    }

    case "serve": {
      const { startBridge } = await import("./serve.ts");
      await startBridge(registry, Number(flags.port ?? 7333));
      return;
    }

    default:
      console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

// ---------------- agent ----------------

/**
 * Line reader that buffers input, so piped answers (`printf 'y\n' | fonino agent ...`)
 * aren't lost before the question is asked. Resolves null once stdin is closed.
 */
function lineReader(rl: Interface) {
  const buffered: string[] = [];
  const waiting: Array<(l: string | null) => void> = [];
  let closed = false;
  rl.on("line", (l) => (waiting.length ? waiting.shift()!(l) : buffered.push(l)));
  rl.on("close", () => {
    closed = true;
    while (waiting.length) waiting.shift()!(null);
  });
  return (prompt: string): Promise<string | null> => {
    process.stdout.write(prompt);
    if (buffered.length) {
      const l = buffered.shift()!;
      if (!process.stdin.isTTY) process.stdout.write(l + "\n");
      return Promise.resolve(l);
    }
    if (closed) {
      process.stdout.write("\n");
      return Promise.resolve(null);
    }
    return new Promise((r) => waiting.push(r));
  };
}

function cliApprover(ask: ReturnType<typeof lineReader>): ApprovalHandler {
  return async (req) => {
    if (flags["yes-to-all-risky"]) {
      console.log(yellow(`  ⚠ auto-approved (${req.risk}): ${req.description}`));
      return true;
    }
    console.log("");
    console.log(yellow(`  ⚠ Agent wants to perform an action classed as ${req.risk.replace("_", " ")}:`));
    console.log("");
    console.log(`    ${req.description}`);
    console.log(dim(`    (${describeAction(req.action)}; screen: ${req.screenshotPath})`));
    console.log("");
    const line = await ask("  Allow? [y/N] ");
    if (line === null) throw new ApprovalUnavailableError("stdin closed before an answer");
    const answer = line.trim().toLowerCase();
    return answer === "y" || answer === "yes";
  };
}

function printEvent(e: Parameters<NonNullable<Parameters<typeof runAgent>[0]["onEvent"]>>[0]) {
  switch (e.kind) {
    case "start":
      console.log(dim(`  run ${e.runId}`));
      break;
    case "approval":
      if (e.coveredByStep !== undefined) console.log(green(`    ✓ covered by your approval at step ${e.coveredByStep}: ${e.description}`));
      break;
    case "decision":
      if (e.action.type !== "finish") console.log(`  → ${e.action.rationale || describeAction(e.action)} ${dim(`[${describeAction(e.action)}, ${(e.modelMs / 1000).toFixed(1)}s]`)}`);
      break;
    case "step":
      if (e.record.outcome === "error" || e.record.outcome === "invalid") console.log(red(`    ✗ ${e.record.outcome}: ${e.record.detail}`));
      else if (e.record.outcome === "denied") console.log(yellow("    ✗ declined by owner"));
      else if (e.record.screenChanged === false) console.log(dim("    (screen unchanged)"));
      break;
    case "error":
      console.log(red(`    ! ${e.message}`));
      break;
  }
}

function printResult(r: RunResult) {
  const color = r.status === "success" ? green : r.status === "blocked" ? yellow : red;
  console.log("");
  console.log(color(`Agent (${r.status}): `) + r.summary);
  if (r.answer) console.log(`Answer: ${r.answer}`);
  const m = r.metrics;
  console.log(
    dim(
      `  ${m.actions} actions · ${m.screenshots} screenshots · ${(m.durationMs / 1000).toFixed(1)}s · ` +
        `${m.inputTokens + m.cacheReadTokens} in / ${m.outputTokens} out tokens · $${m.costUsd.toFixed(3)} · ` +
        `${m.humanInterventions} approvals · ${m.deviceErrors} device errors`,
    ),
  );
  console.log(dim(`  replay: fonino replay ${r.runId} --open`));
}

async function agentCommand() {
  const d = await device();
  const model = flags.script
    ? new ScriptedModel(JSON.parse(readFileSync(flags.script as string, "utf8")) as AgentAction[])
    : new AnthropicModel({ model: flags.model as string | undefined });
  const maxSteps = Number(flags["max-steps"] ?? 40);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  const ask = lineReader(rl);
  const notes: string[] = [];
  let controller: AbortController | undefined;
  rl.on("SIGINT", () => {
    if (controller && !controller.signal.aborted) {
      console.log(yellow("\n  stopping after the current step… (Ctrl+C again to quit)"));
      controller.abort();
    } else {
      rl.close();
      process.exit(130);
    }
  });

  const runGoal = async (goal: string) => {
    controller = new AbortController();
    const r = await runAgent({
      device: d, model, goal, maxSteps, approve: cliApprover(ask), sessionNotes: notes,
      signal: controller.signal, onEvent: printEvent,
    });
    controller = undefined;
    notes.push(`Goal "${goal}" → ${r.status}: ${r.summary}${r.answer ? ` Answer: ${r.answer}` : ""}`);
    printResult(r);
    return r;
  };

  if (flags.goal) {
    const r = await runGoal(flags.goal as string);
    rl.close();
    process.exitCode = r.status === "success" ? 0 : 1;
    return;
  }

  console.log(`AgentPhone agent on ${d.id} (${d.name}) using ${model.name}. Type a goal, or "exit".`);
  for (;;) {
    const line = await ask("\n> ");
    if (line === null) break; // stdin closed
    const goal = line.trim();
    if (!goal) continue;
    if (goal === "exit" || goal === "quit") break;
    try {
      await runGoal(goal);
    } catch (e) {
      console.log(red(`error: ${(e as Error).message}`));
    }
  }
  rl.close();
}

// ---------------- runs ----------------

function listRuns(limit: number) {
  const dir = defaultRunsDir();
  const runs = existsSync(dir) ? readdirSync(dir).filter((f) => existsSync(resolve(dir, f, "goal.json"))).sort().reverse().slice(0, limit) : [];
  if (!runs.length) return console.log("No runs yet.");
  let done = 0, success = 0, noHuman = 0;
  for (const id of runs) {
    const goal = JSON.parse(readFileSync(resolve(dir, id, "goal.json"), "utf8"));
    const resPath = resolve(dir, id, "result.json");
    const r: RunResult | undefined = existsSync(resPath) ? JSON.parse(readFileSync(resPath, "utf8")) : undefined;
    if (r) {
      done++;
      if (r.status === "success") success++;
      if (r.status === "success" && r.metrics.humanInterventions === 0) noHuman++;
    }
    const status = r ? r.status : "running?";
    const m = r?.metrics;
    console.log(
      `${id}  ${(status === "success" ? green : status === "blocked" ? yellow : red)(status.padEnd(10))} ` +
        `${m ? dim(`${String(m.actions).padStart(3)} act ${(m.durationMs / 1000).toFixed(0).padStart(4)}s $${m.costUsd.toFixed(2)}`) : ""}  ${goal.goal.slice(0, 70)}`,
    );
  }
  if (done) console.log(dim(`\n${success}/${done} succeeded · ${noHuman}/${done} completed without human intervention`));
}

main().catch((e) => {
  const err = e as DeviceError;
  console.error(red(`error${err.code ? ` [${err.code}]` : ""}: ${err.message}`));
  if (err.fix) console.error(`  → ${err.fix}`);
  process.exitCode = 1;
});
