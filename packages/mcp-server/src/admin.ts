// Owner dashboard at /admin/ on the MCP service: phones, pending approvals (approve/deny in
// the browser), usage per customer, API keys and recent activity.
//
// Local only. The service is reachable through the HTTPS tunnel, so every request must
// come from this Mac directly: loopback socket, a localhost Host header (blocks DNS
// rebinding) and no proxy headers (cloudflared/ngrok also connect from loopback but add
// them). State-changing POSTs also need the X-AgentPhone header, which a cross-site form
// or image can't send.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type http from "node:http";
import type { DeviceRegistry } from "@agentphone/device-core";
import type { ApprovalQueue } from "./approval-queue.ts";
import type { KeyStore } from "./keys.ts";
import type { RemoteAgentPhone } from "./remote.ts";

type AdminDeps = { core: RemoteAgentPhone; approvals: ApprovalQueue; keys?: KeyStore; registry: DeviceRegistry; ownerToken: string };

// Login: `fonino dashboard` (which can read the owner token) opens /admin/login?t=<ts>.<hmac>.
// Valid 60 s, single use; it becomes a 12-hour HttpOnly cookie. Other local programs and users
// can reach the port but not approve texts or open live views without the token.
const sessions = new Map<string, number>(); // session id → expiry
const usedLogins = new Set<string>();

/** The login link token for a given time (also used by the CLI). */
export function adminLoginToken(ownerToken: string, ts = Date.now()): string {
  return `${ts}.${createHmac("sha256", ownerToken).update(`admin-login:${ts}`).digest("base64url")}`;
}

function loginValid(ownerToken: string, t: string): boolean {
  const [ts, mac] = t.split(".");
  const n = Number(ts);
  if (!Number.isFinite(n) || Math.abs(Date.now() - n) > 60_000 || usedLogins.has(t)) return false;
  const want = Buffer.from(adminLoginToken(ownerToken, n).split(".")[1]);
  const got = Buffer.from(mac ?? "");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  usedLogins.add(t);
  if (usedLogins.size > 1000) usedLogins.clear();
  return true;
}

function sessionOk(req: http.IncomingMessage): boolean {
  const m = /(?:^|;\s*)ap_admin=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? "");
  const exp = m ? sessions.get(m[1]) : undefined;
  return !!exp && exp > Date.now();
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const PROXY_HEADERS = ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded", "ngrok-trace-id"];

export function isLocalRequest(req: http.IncomingMessage): boolean {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return false;
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host ?? "")) return false;
  return !PROXY_HEADERS.some((h) => h in req.headers);
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

export async function handleAdmin(req: http.IncomingMessage, res: http.ServerResponse, url: URL, d: AdminDeps): Promise<void> {
  if (!isLocalRequest(req)) {
    res.writeHead(404).end();
    return;
  }
  const path = url.pathname;
  if (req.method === "GET" && path === "/admin/login") {
    if (!loginValid(d.ownerToken, url.searchParams.get("t") ?? "")) {
      res.writeHead(403, { "content-type": "text/plain" }).end("Login link invalid or expired. Run `fonino dashboard` again.");
      return;
    }
    const sid = randomBytes(32).toString("base64url");
    sessions.set(sid, Date.now() + 12 * 3_600_000);
    for (const [k, v] of sessions) if (v < Date.now()) sessions.delete(k);
    res.writeHead(302, { location: "/admin/", "set-cookie": `ap_admin=${sid}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=43200`, "cache-control": "no-store" }).end();
    return;
  }
  if (!sessionOk(req)) {
    res.writeHead(401, { "content-type": "text/plain" }).end("Open the dashboard with `fonino dashboard`.");
    return;
  }
  if (req.method === "GET" && (path === "/admin" || path === "/admin/")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" }).end(ADMIN_HTML);
    return;
  }
  if (req.method === "GET" && path === "/admin/api/state") {
    const [devices, leases] = await Promise.all([d.registry.listDevices(), Promise.resolve(d.registry.leases?.list() ?? [])]);
    const usage = d.core.usage;
    json(res, 200, {
      devices: devices
        .filter((x) => !x.id.endsWith(":error"))
        .map((x) => {
          const l = leases.find((y) => y.deviceId === x.id);
          return { id: x.id, name: x.name, status: x.status, adapter: x.adapter, detail: x.detail, lease: l ? { holder: l.holder, task: l.task, until: l.expiresAt } : null };
        }),
      approvals: d.approvals.list("pending").map((r) => ({ id: r.id, deviceId: r.deviceId, holder: r.holder, risk: r.risk, spec: r.spec, createdAt: r.createdAt, hasScreen: !!r.screenshotPath, code: r.code })),
      usage: usage.summary(),
      recent: usage.events().slice(-25).reverse(),
      keys: (d.keys?.list() ?? []).map(({ hash: _hash, ...k }) => k),
      publicUrl: (() => {
        try {
          return readFileSync(join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "public-url"), "utf8").trim() || null;
        } catch {
          return null;
        }
      })(),
      limits: d.core.limiter.limits,
    });
    return;
  }
  const shot = path.match(/^\/admin\/api\/approvals\/([a-f0-9-]{36})\/screen$/);
  if (req.method === "GET" && shot) {
    const p = d.approvals.get(shot[1])?.screenshotPath;
    if (!p || !p.endsWith(".png")) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }).end(readFileSync(p));
    return;
  }
  if (req.method === "POST" && req.headers["x-agentphone"] !== "1") return json(res, 403, { error: "missing X-AgentPhone header" });
  const decide = path.match(/^\/admin\/api\/approvals\/([a-f0-9-]{36})\/(approve|approve_task|deny)$/);
  if (req.method === "POST" && decide) {
    try {
      const r = d.approvals.decide(decide[1], decide[2] !== "deny", decide[2] === "approve_task" ? "task" : "once");
      return json(res, 200, { ok: true, status: r.status });
    } catch (e) {
      return json(res, 409, { ok: false, error: (e as Error).message });
    }
  }
  const watch = path.match(/^\/admin\/api\/live\/([\w:.-]+)$/);
  if (req.method === "POST" && watch) {
    const base = `http://${req.headers.host}`;
    const l = d.core.live.link(base, watch[1], { kind: "owner", principal: "owner" });
    return json(res, 200, { url: l.url });
  }
  res.writeHead(404).end();
}

export const ADMIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentPhone Fleet</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--mute:#667085;--line:#e4e7ec;--ok:#12b76a;--warn:#f79009;--bad:#f04438;--accent:#2e6be6}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--ink:#e8eaee;--mute:#98a2b3;--line:#2a2f3a;--accent:#6c9cff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{display:flex;justify-content:space-between;align-items:baseline;padding:20px 24px 4px}h1{font-size:20px;margin:0}
main{padding:8px 24px 40px;max-width:1200px;margin:0 auto;display:grid;gap:20px}
section h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);margin:0 0 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.row{display:flex;justify-content:space-between;gap:8px;align-items:center}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.mute{color:var(--mute)}.small{font-size:12px}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:7px;padding:5px 12px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--bad)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:13px;vertical-align:top}th{color:var(--mute);font-weight:500}
tr:last-child td{border-bottom:0}.wrap{overflow-x:auto}
.appr{display:grid;grid-template-columns:1fr auto;gap:12px}.appr img{max-height:220px;border-radius:8px;border:1px solid var(--line)}
code{font-family:ui-monospace,Menlo,monospace;font-size:12px}.empty{color:var(--mute);padding:6px 0}
@media (max-width:600px){header,main{padding-left:16px;padding-right:16px}.appr{grid-template-columns:1fr}}
</style></head><body>
<header><h1>AgentPhone Fleet</h1><span class="mute small" id="upd"></span></header>
<div class="small mute" style="padding:0 24px" id="pub"></div>
<main>
<section><h2>Waiting for your approval</h2><div id="approvals"></div></section>
<section><h2>Phones</h2><div class="grid" id="devices"></div></section>
<section><h2>Usage this month</h2><div class="wrap" id="usage"></div></section>
<section><h2>API keys</h2><div class="wrap" id="keys"></div></section>
<section><h2>Recent activity</h2><div class="wrap" id="recent"></div></section>
</main>
<script>
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const color = { connected: "var(--ok)", locked: "var(--warn)" };
const post = (u) => fetch(u, { method: "POST", headers: { "X-AgentPhone": "1" } }).then((r) => r.json());
function table(cols, rows) {
  if (!rows.length) return '<div class="empty">Nothing yet.</div>';
  return "<table><tr>" + cols.map((c) => "<th>" + c[0] + "</th>").join("") + "</tr>" +
    rows.map((r) => "<tr>" + cols.map((c) => "<td>" + c[1](r) + "</td>").join("") + "</tr>").join("") + "</table>";
}
async function refresh() {
  let s;
  try { s = await (await fetch("/admin/api/state")).json(); } catch { return; }
  document.getElementById("upd").textContent = "updated " + new Date().toLocaleTimeString();
  document.getElementById("pub").innerHTML = (s.publicUrl ? "Customer MCP URL: <code>" + esc(s.publicUrl) + "/mcp</code>" : "No public tunnel running") +
    " · Sending limits per phone: " + s.limits.perPhoneHour + "/hour, " + s.limits.perPhoneDay + "/day, " + s.limits.perRecipientHour + " per recipient/hour";
  document.getElementById("approvals").innerHTML = s.approvals.length ? s.approvals.map((a) =>
    '<div class="card appr"><div><b>' + esc(a.spec.summary) + '</b><div class="small mute">' + esc(a.holder) + " on " + esc(a.deviceId) + " · " + esc(a.risk) + "</div>" +
    '<div class="small" style="margin:8px 0">' + (a.spec.recipient ? "To: <b>" + esc(a.spec.recipient) + "</b><br>" : "") + (a.spec.payload ? "Text: <code>" + esc(a.spec.payload) + "</code>" : "") + (a.code ? '<br>Approval code (or tell it to your assistant): <b>' + esc(a.code) + "</b>" : "") + "</div>" +
    '<div class="row" style="justify-content:flex-start"><button class="primary" data-a="' + a.id + '/approve">Allow once</button><button data-a="' + a.id + '/approve_task">Allow for this task</button><button class="danger" data-a="' + a.id + '/deny">Don&#39;t allow</button></div></div>' +
    (a.hasScreen ? '<img alt="phone screen" src="/admin/api/approvals/' + a.id + '/screen">' : "<span></span>") + "</div>").join("") : '<div class="empty">Nothing waiting.</div>';
  document.getElementById("devices").innerHTML = s.devices.map((d) =>
    '<div class="card"><div class="row"><b>' + esc(d.name) + '</b><code class="mute">' + esc(d.id) + "</code></div>" +
    '<div class="small" style="margin:6px 0"><span class="dot" style="background:' + (color[d.status] || "var(--bad)") + '"></span>' + esc(d.status) + (d.detail ? ' <span class="mute">· ' + esc(d.detail) + "</span>" : "") + "</div>" +
    '<div class="small mute">' + (d.lease ? "In use by <b>" + esc(d.lease.holder) + "</b>: " + esc(d.lease.task) : "Free") + "</div>" +
    (d.status === "connected" ? '<div style="margin-top:8px"><button data-w="' + esc(d.id) + '">Watch live</button></div>' : "") + "</div>").join("") || '<div class="empty">No phones found.</div>';
  document.getElementById("usage").innerHTML = table([
    ["Customer", (u) => esc(u.tenantName)], ["Tool calls", (u) => u.calls], ["Errors", (u) => u.errors], ["Texts sent", (u) => u.messagesSent],
    ["Sessions", (u) => u.leases], ["Phone minutes", (u) => u.heldMinutes], ["Phones", (u) => esc(u.devices.join(", "))], ["Last seen", (u) => new Date(u.lastSeen).toLocaleString()],
  ], s.usage);
  document.getElementById("keys").innerHTML = table([
    ["Name", (k) => esc(k.name)], ["Key id", (k) => "<code>apk_" + esc(k.id) + "_…</code>"], ["Phones", (k) => esc(k.devices === "*" ? "all" : k.devices.join(", "))],
    ["Approval", (k) => (k.requireApproval ? "owner approves texts" : "none")], ["Can text", (k) => esc(k.allowRecipients ? k.allowRecipients.map((r) => r.replace(/^(tel|mailto):/, "")).join(", ") : "anyone")], ["Created", (k) => new Date(k.createdAt).toLocaleDateString()], ["Status", (k) => (k.revokedAt ? "revoked" : "active")],
  ], s.keys);
  document.getElementById("recent").innerHTML = table([
    ["Time", (e) => new Date(e.ts).toLocaleTimeString()], ["Customer", (e) => esc(e.tenantName)], ["Tool", (e) => "<code>" + esc(e.tool) + "</code>"],
    ["Phone", (e) => esc(e.device)], ["Result", (e) => (e.ok ? "ok" : '<span style="color:var(--bad)">' + esc(e.code || "error") + "</span>")], ["ms", (e) => e.ms],
  ], s.recent);
}
document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-a]"), w = e.target.closest("[data-w]");
  if (a) { a.disabled = true; await post("/admin/api/approvals/" + a.dataset.a); refresh(); }
  if (w) { const r = await post("/admin/api/live/" + encodeURIComponent(w.dataset.w)); if (r.url) window.open(r.url, "_blank"); }
});
refresh(); setInterval(refresh, 3000);
</script></body></html>`;
