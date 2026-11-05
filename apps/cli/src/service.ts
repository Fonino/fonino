// `agentphone service install|uninstall|status|restart|logs`: run the host as macOS
// LaunchAgents so it starts at login and restarts itself if anything crashes.
//
//   dev.agentphone.wda     agentphone wda up      (keeps WebDriverAgent alive on every phone)
//   dev.agentphone.mcp     agentphone mcp-http    (the API + /admin dashboard)
//   dev.agentphone.tunnel  scripts/tunnel.sh      (public HTTPS URL → ~/.agentphone/public-url)
//
// LaunchAgents (not daemons): WDA needs the logged-in user's session, Xcode and keychain.
// After a reboot they start when the user logs in, so the Mac should log in automatically.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const REPO = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");
const HOME = process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone");
const LOGS = join(HOME, "logs");
const AGENTS = join(homedir(), "Library", "LaunchAgents");
const uid = process.getuid!();

export type ServiceName = "wda" | "mcp" | "tunnel" | "resign";
export const SERVICES: ServiceName[] = ["wda", "mcp", "tunnel", "resign"];
const label = (s: ServiceName) => `dev.agentphone.${s}`;
const plistPath = (s: ServiceName) => join(AGENTS, `${label(s)}.plist`);

function programArgs(s: ServiceName, port: number): string[] {
  const cli = [process.execPath, "--disable-warning=ExperimentalWarning", join(REPO, "apps/cli/src/main.ts")];
  if (s === "wda") return [...cli, "wda", "up"];
  if (s === "mcp") return [...cli, "mcp-http", "--port", String(port)];
  if (s === "resign") return [...cli, "wda", "resign", "--if-stale"];
  return ["/bin/sh", join(REPO, "scripts/tunnel.sh"), String(port)];
}

const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plist(s: ServiceName, port = 3001): string {
  const env: Record<string, string> = {
    PATH: `${dirname(process.execPath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: homedir(),
    ...(process.env.AGENTPHONE_HOME ? { AGENTPHONE_HOME: process.env.AGENTPHONE_HOME } : {}),
    ...(process.env.AGENTPHONE_LIMITS ? { AGENTPHONE_LIMITS: process.env.AGENTPHONE_LIMITS } : {}),
    ...(process.env.AGENTPHONE_WDA_BUILD ? { AGENTPHONE_WDA_BUILD: process.env.AGENTPHONE_WDA_BUILD } : {}),
    ...(process.env.AGENTPHONE_ADAPTERS ? { AGENTPHONE_ADAPTERS: process.env.AGENTPHONE_ADAPTERS } : {}),
    ...(process.env.FONINO_APP === "1" ? { FONINO_APP: "1", AGENTPHONE_RUNNER: "goios" } : {}), // Fonino for Mac: no Xcode
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label(s)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs(s, port).map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${esc(REPO)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${esc(v)}</string>`).join("\n")}
  </dict>
${s === "resign"
  ? `  <key>StartInterval</key><integer>3600</integer>` // hourly check; renews phones not renewed in 3 days (free Apple ID signatures last 7)
  : `  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>`}
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${esc(join(LOGS, `${s}.log`))}</string>
  <key>StandardErrorPath</key><string>${esc(join(LOGS, `${s}.log`))}</string>
</dict>
</plist>
`;
}

async function launchctl(...args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await pexec("launchctl", args);
    return { ok: true, out: stdout + stderr };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: (x.stdout ?? "") + (x.stderr ?? x.message) };
  }
}

export async function install(which: ServiceName[], port = 3001) {
  mkdirSync(AGENTS, { recursive: true });
  mkdirSync(LOGS, { recursive: true });
  for (const s of which) {
    writeFileSync(plistPath(s), plist(s, port));
    await launchctl("bootout", `gui/${uid}/${label(s)}`); // replace a previous version
    const r = await launchctl("bootstrap", `gui/${uid}`, plistPath(s));
    if (!r.ok) throw new Error(`launchctl bootstrap ${label(s)}: ${r.out.trim()}`);
  }
}

export async function uninstall(which: ServiceName[]) {
  for (const s of which) {
    await launchctl("bootout", `gui/${uid}/${label(s)}`);
    if (existsSync(plistPath(s))) unlinkSync(plistPath(s));
  }
}

export async function restart(which: ServiceName[]) {
  for (const s of which) {
    const r = await launchctl("kickstart", "-k", `gui/${uid}/${label(s)}`);
    if (!r.ok) throw new Error(`${label(s)} is not installed (agentphone service install)`);
  }
}

export type ServiceStatus = { name: ServiceName; installed: boolean; running: boolean; pid?: number; lastExit?: string; runs?: number; log: string };

export async function status(): Promise<ServiceStatus[]> {
  return Promise.all(
    SERVICES.map(async (s) => {
      const r = await launchctl("print", `gui/${uid}/${label(s)}`);
      const pid = r.out.match(/\n\s*pid = (\d+)/)?.[1];
      return {
        name: s,
        installed: r.ok,
        running: r.ok && /\n\s*state = running/.test(r.out),
        pid: pid ? Number(pid) : undefined,
        lastExit: r.out.match(/last exit code = ([^\n]+)/)?.[1],
        runs: Number(r.out.match(/\n\s*runs = (\d+)/)?.[1] ?? 0) || undefined,
        log: join(LOGS, `${s}.log`),
      };
    }),
  );
}

export function publicUrl(): string | undefined {
  try {
    return readFileSync(join(HOME, "public-url"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
