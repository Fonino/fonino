// Live phone viewer with human takeover, served by the remote MCP service (same port,
// same tunnel). A remote agent posts a short-lived link (phone_live_view /
// phone_request_help); the owner opens it, watches the phone live, and can "Take over"
// (the agent's actions are then refused) and "Give back".
//
// Security: links carry a random 256-bit, single-use token, scoped to one device, valid
// 30 minutes. Opening one exchanges it for an HttpOnly (+Secure over HTTPS) SameSite=Strict
// cookie and redirects to a token-free URL. A link belongs to whoever minted it and, for a
// customer, to their lease: it dies when the lease ends or the key is revoked, so it never
// shows the next tenant's screen. What it may do depends on its kind:
//   owner  — watch, take over (even an idle phone), act. Only the owner's channels mint these.
//   help   — a customer's phone_request_help link: act only while that help request is open.
//   watch  — a customer's phone_live_view link: view only (a model can't use it to tap past
//            approvals, allowlists or rate limits). State-changing requests also need an
// "X-AgentPhone: 1" header (CSRF guard). Tokens and sessions live in memory only;
// restarting the service revokes them all. Screens are never stored at public URLs.

import { randomBytes } from "node:crypto";
import type http from "node:http";
import type { PhoneDevice } from "@agentphone/device-core";
import { DeviceError } from "@agentphone/shared";

export type ControlMode = "idle" | "agent" | "human";

export type LiveControl = {
  device(id: string): Promise<PhoneDevice>;
  /** Is this link's owner still entitled to it (key not revoked, lease still held)? */
  grantActive(g: Grant): boolean;
  /** Is the customer's help request (phone_request_help) on this lease still open? */
  helpActive(leaseId: string): boolean;
  state(id: string): { mode: ControlMode; holder?: string; task?: string; helpReason?: string };
  takeover(id: string): Promise<void>;
  giveback(id: string): Promise<void>;
  humanAction(id: string, what: string): void;
};

export type LinkKind = "owner" | "help" | "watch";
export type Grant = { deviceId: string; expiresAt: number; kind: LinkKind; principal: string; leaseId?: string };

const LINK_TTL_MS = 30 * 60_000;
const MAX_FPS = 3;
const IDLE_STOP_MS = 20_000;
const MAX_VIEWERS_PER_PHONE = 8;
const MAX_BUFFERED = 1_000_000; // skip frames for viewers that don't read (slow or stalled)

/** One upstream MJPEG connection per phone, fanned out to viewers at ≤ MAX_FPS. */
class Broadcaster {
  private latest?: Buffer;
  private seq = 0;
  private upstream?: NodeJS.ReadableStream;
  private readonly clients = new Set<http.ServerResponse>();
  private timer?: NodeJS.Timeout;
  private idleSince = 0;
  private starting?: Promise<void>;
  error?: string;
  private readonly open: () => Promise<NodeJS.ReadableStream>;

  constructor(open: () => Promise<NodeJS.ReadableStream>) {
    this.open = open;
  }

  private async start() {
    this.error = undefined;
    const up = await this.open();
    this.upstream = up;
    let buf = Buffer.alloc(0);
    up.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      // Parse "--boundary\r\nheaders\r\n\r\n<Content-Length bytes>" repeatedly.
      for (;;) {
        const headEnd = buf.indexOf("\r\n\r\n");
        if (headEnd < 0) break;
        const m = /content-length:\s*(\d+)/i.exec(buf.subarray(0, headEnd).toString("latin1"));
        if (!m) {
          buf = buf.subarray(headEnd + 4);
          continue;
        }
        const len = Number(m[1]);
        if (buf.length < headEnd + 4 + len) break;
        this.latest = Buffer.from(buf.subarray(headEnd + 4, headEnd + 4 + len));
        this.seq++;
        buf = buf.subarray(headEnd + 4 + len);
      }
      if (buf.length > 5_000_000) buf = Buffer.alloc(0); // never grow unbounded
    });
    const stop = (why: string) => {
      this.error = why;
      this.upstream = undefined;
    };
    up.on("end", () => stop("stream ended"));
    up.on("error", (e: Error) => stop(e.message));
  }

  async attach(res: http.ServerResponse) {
    if (this.clients.size >= MAX_VIEWERS_PER_PHONE) {
      res.writeHead(429, { "content-type": "text/plain" }).end("Too many viewers for this phone.");
      return;
    }
    if (!this.upstream) {
      this.starting ??= this.start().finally(() => (this.starting = undefined));
      await this.starting;
    }
    res.writeHead(200, {
      "content-type": "multipart/x-mixed-replace; boundary=apframe",
      "cache-control": "no-store",
      connection: "close",
    });
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
    this.timer ??= setInterval(() => this.tick(), 1000 / MAX_FPS);
  }

  private sent = new WeakMap<http.ServerResponse, number>();
  private tick() {
    if (!this.clients.size) {
      this.idleSince ||= Date.now();
      if (Date.now() - this.idleSince > IDLE_STOP_MS) this.shutdown();
      return;
    }
    this.idleSince = 0;
    if (!this.upstream && !this.starting) {
      this.starting = this.start().catch((e) => void (this.error = (e as Error).message)).finally(() => (this.starting = undefined));
    }
    if (!this.latest) return;
    for (const res of this.clients) {
      if (this.sent.get(res) === this.seq) continue;
      if (res.writableLength > MAX_BUFFERED) continue; // backpressure: don't queue frames forever
      this.sent.set(res, this.seq);
      res.write(`--apframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${this.latest.length}\r\n\r\n`);
      res.write(this.latest);
      res.write("\r\n");
    }
  }

  shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    (this.upstream as unknown as { destroy?: () => void } | undefined)?.destroy?.();
    this.upstream = undefined;
    for (const c of this.clients) c.end();
    this.clients.clear();
  }
}

export class LiveViewHub {
  private readonly links = new Map<string, Grant>();
  private readonly sessions = new Map<string, Grant>();
  private readonly casts = new Map<string, Broadcaster>();
  private readonly control: LiveControl;

  constructor(control: LiveControl) {
    this.control = control;
  }

  /** Mint a 30-minute, single-use link for one device. */
  link(baseUrl: string, deviceId: string, who: { kind: LinkKind; principal: string; leaseId?: string }): { url: string; expiresAt: string } {
    this.sweep();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + LINK_TTL_MS;
    this.links.set(token, { deviceId, expiresAt, ...who });
    return { url: `${baseUrl}/view/${encodeURIComponent(deviceId)}?t=${token}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** End every link and viewer session tied to a lease (release, expiry). */
  revokeLease(leaseId: string) {
    for (const m of [this.links, this.sessions]) for (const [k, g] of m) if (g.leaseId === leaseId) m.delete(k);
  }

  /** Drop expired links/sessions (they're otherwise only rejected, never removed). */
  private sweep() {
    const now = Date.now();
    for (const m of [this.links, this.sessions]) for (const [k, g] of m) if (g.expiresAt <= now) m.delete(k);
  }

  private valid(g: Grant | undefined, deviceId: string): g is Grant {
    return !!g && g.deviceId === deviceId && g.expiresAt > Date.now() && this.control.grantActive(g);
  }

  private cookieSession(req: http.IncomingMessage, deviceId: string): Grant | undefined {
    const m = /(?:^|;\s*)ap_view=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? "");
    const g = m ? this.sessions.get(m[1]) : undefined;
    return this.valid(g, deviceId) ? g : undefined;
  }

  /** May this session act on the phone right now? */
  private canAct(g: Grant): boolean {
    if (g.kind === "owner") return true;
    return g.kind === "help" && !!g.leaseId && this.control.helpActive(g.leaseId);
  }

  shutdown() {
    for (const c of this.casts.values()) c.shutdown();
  }

  /** Handles /view/... requests. Returns false for other paths. */
  /** `prefix`: the path the browser sees in front of /view (e.g. "/h/<hostId>" behind the cloud relay). */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, prefix = ""): Promise<boolean> {
    const m = /^\/view\/([^/]+)(\/[a-z.]+)?$/.exec(url.pathname);
    if (!m) return false;
    const deviceId = decodeURIComponent(m[1]);
    const sub = m[2] ?? "";
    const secure = req.headers["x-forwarded-proto"] === "https";
    const send = (code: number, body: string, type = "application/json", extra: Record<string, string> = {}) => {
      res.writeHead(code, {
        "content-type": type,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'none'; img-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        ...extra,
      });
      res.end(body);
    };

    // Token exchange: ?t=... → cookie → redirect to a token-free URL.
    const t = url.searchParams.get("t");
    if (t && sub === "") {
      const g = this.links.get(t);
      this.links.delete(t); // single use: a link pasted into a chat log can't be replayed
      if (!this.valid(g, deviceId)) return send(403, "This live-view link is invalid, expired or already used. Ask for a new one.", "text/plain"), true;
      const sid = randomBytes(32).toString("base64url");
      this.sessions.set(sid, { ...g });
      const cookie = `ap_view=${sid}; HttpOnly; SameSite=Strict; Path=${prefix}/view/${encodeURIComponent(deviceId)}; Max-Age=${Math.floor(LINK_TTL_MS / 1000)}${secure ? "; Secure" : ""}`;
      res.writeHead(302, { location: `${prefix}/view/${encodeURIComponent(deviceId)}`, "set-cookie": cookie, "referrer-policy": "no-referrer", "cache-control": "no-store" });
      res.end();
      return true;
    }
    const grant = this.cookieSession(req, deviceId);
    if (!grant) return send(401, "Not authorized, or this session ended. Open a new live-view link.", "text/plain"), true;

    try {
      if (req.method === "GET") {
        if (sub === "") return send(200, page(deviceId, prefix), "text/html; charset=utf-8"), true;
        if (sub === "/app.js") return send(200, APP_JS, "text/javascript; charset=utf-8"), true;
        if (sub === "/state") {
          const dev = await this.control.device(deviceId);
          const st = await dev.getStatus();
          return send(200, JSON.stringify({ deviceId, name: dev.name, width: st.width, height: st.height, status: st.status, stream: this.casts.get(deviceId)?.error ?? "ok", canAct: this.canAct(grant), ...this.control.state(deviceId) })), true;
        }
        if (sub === "/stream") {
          const dev = await this.control.device(deviceId);
          if (!dev.openLiveStream) return send(501, JSON.stringify({ error: `${dev.adapter} has no live stream` })), true;
          let cast = this.casts.get(deviceId);
          if (!cast) {
            cast = new Broadcaster(() => dev.openLiveStream!({ scalePct: 35, fps: 5 }));
            this.casts.set(deviceId, cast);
          }
          await cast.attach(res);
          return true;
        }
      }
      if (req.method === "POST") {
        if (req.headers["x-agentphone"] !== "1") return send(403, JSON.stringify({ error: "missing X-AgentPhone header" })), true;
        let raw = "";
        for await (const c of req) {
          raw += c;
          if (raw.length > 10_000) return send(413, "{}"), true;
        }
        let body: Record<string, unknown>;
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return send(400, "{}"), true;
        }
        if (!this.canAct(grant)) {
          return send(403, JSON.stringify({ ok: false, code: "view_only", error: grant.kind === "watch" ? "This link is view-only." : "The help request has ended." })), true;
        }
        // Help links may only take over the phone of their own lease, never an idle phone.
        if (grant.kind !== "owner" && this.control.state(deviceId).mode === "idle") {
          return send(403, JSON.stringify({ ok: false, code: "view_only", error: "Nothing to take over." })), true;
        }
        const dev = await this.control.device(deviceId);
        const human = () => {
          if (this.control.state(deviceId).mode !== "human") throw new DeviceError("not_in_control", "Press Take over first.");
        };
        const num = (v: unknown) => {
          if (typeof v !== "number" || !Number.isFinite(v)) throw new DeviceError("bad_args", "coordinates must be numbers");
          return v;
        };
        switch (sub) {
          case "/takeover":
            await this.control.takeover(deviceId);
            break;
          case "/giveback":
            await this.control.giveback(deviceId);
            break;
          case "/tap":
            human();
            await dev.tap(num(body.x), num(body.y));
            this.control.humanAction(deviceId, `tap (${Math.round(body.x as number)}, ${Math.round(body.y as number)})`);
            break;
          case "/swipe":
            human();
            await dev.swipe(num(body.x1), num(body.y1), num(body.x2), num(body.y2), Math.max(80, Math.min(3000, Number(body.ms) || 300)));
            this.control.humanAction(deviceId, "swipe");
            break;
          case "/home":
            human();
            await dev.home();
            this.control.humanAction(deviceId, "home");
            break;
          case "/type":
            human();
            if (typeof body.text !== "string" || !body.text || body.text.length > 500) throw new DeviceError("bad_args", "text must be 1–500 chars");
            await dev.type(body.text);
            this.control.humanAction(deviceId, `type (${body.text.length} chars)`); // never log the text itself
            break;
          default:
            return send(404, "{}"), true;
        }
        return send(200, JSON.stringify({ ok: true, ...this.control.state(deviceId) })), true;
      }
      return send(405, "{}"), true;
    } catch (e) {
      const err = e as DeviceError;
      return send(409, JSON.stringify({ ok: false, code: err.code ?? "error", error: err.message, fix: err.fix })), true;
    }
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function page(deviceId: string, prefix = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentPhone · ${esc(deviceId)}</title>
<style>
body{margin:0;background:#111;color:#eee;font:14px -apple-system,system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;padding:12px}
#bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:center;margin-bottom:8px;max-width:520px}
button{background:#333;color:#eee;border:1px solid #555;border-radius:8px;padding:8px 12px;font:inherit;cursor:pointer}
button.primary{background:#0a84ff;border-color:#0a84ff}button:disabled{opacity:.4}
#screen{max-height:78vh;max-width:95vw;border-radius:24px;border:2px solid #333;touch-action:none;user-select:none;-webkit-user-drag:none}
#screen.human{border-color:#ff9f0a;cursor:crosshair}
#status{margin:6px 0;color:#aaa;text-align:center;max-width:520px}
#typebox{display:none;gap:6px;margin-top:8px}#typebox input{background:#222;color:#eee;border:1px solid #555;border-radius:8px;padding:8px;width:220px}
</style></head><body>
<div id="bar"><b>${esc(deviceId)}</b>
<button id="take" class="primary">Take over</button><button id="give">I'm done — give back</button>
<button id="home">Home</button></div>
<div id="status">connecting…</div>
<img id="screen" src="${esc(prefix)}/view/${encodeURIComponent(deviceId)}/stream" alt="live phone screen" draggable="false">
<div id="typebox"><input id="text" placeholder="type into the focused field" autocomplete="off"><button id="send">Type</button></div>
<script src="${esc(prefix)}/view/${encodeURIComponent(deviceId)}/app.js"></script></body></html>`;
}

/** Served to browsers as /view/<device>/app.js (exported for syntax checks). */
export const APP_JS = `
const base = location.pathname;
const img = document.getElementById('screen');
const statusEl = document.getElementById('status');
let st = {};
async function post(path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentphone': '1' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) statusEl.textContent = (j.error || 'error') + (j.fix ? ' — ' + j.fix : '');
  await refresh();
  return j;
}
async function refresh() {
  try {
    st = await (await fetch(base + '/state')).json();
    const human = st.mode === 'human';
    img.classList.toggle('human', human);
    document.getElementById('take').style.display = st.canAct ? '' : 'none';
    document.getElementById('give').style.display = st.canAct ? '' : 'none';
    document.getElementById('home').style.display = st.canAct ? '' : 'none';
    document.getElementById('take').disabled = human;
    document.getElementById('give').disabled = !human;
    document.getElementById('home').disabled = !human;
    document.getElementById('typebox').style.display = human ? 'flex' : 'none';
    statusEl.textContent = human
      ? (st.helpReason ? 'The agent asks for help: ' + st.helpReason + '. ' : '') + 'YOU are in control — click to tap, drag to swipe. Press “I’m done” when finished.'
      : st.mode === 'agent' ? 'Watching ' + (st.holder || 'agent') + ': ' + (st.task || '')
      : 'Idle (no agent holds this phone).';
    if (!st.canAct) statusEl.textContent += ' (view only)';
    if (st.stream && st.stream !== 'ok') statusEl.textContent += ' · stream: ' + st.stream;
  } catch (e) { statusEl.textContent = 'disconnected'; }
}
function toPoints(ev) {
  const r = img.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / r.width * st.width, y: (ev.clientY - r.top) / r.height * st.height };
}
let down = null;
img.addEventListener('pointerdown', (ev) => { if (st.mode !== 'human') return; down = { p: toPoints(ev), t: Date.now() }; ev.preventDefault(); });
img.addEventListener('pointerup', (ev) => {
  if (!down) return;
  const p = toPoints(ev), d = down; down = null;
  if (Math.hypot(p.x - d.p.x, p.y - d.p.y) < 8) post('/tap', d.p);
  else post('/swipe', { x1: d.p.x, y1: d.p.y, x2: p.x, y2: p.y, ms: Date.now() - d.t });
});
document.getElementById('take').onclick = () => post('/takeover');
document.getElementById('give').onclick = async () => {
  const j = await post('/giveback');
  if (j && j.ok) statusEl.textContent = 'Done — the agent has been notified and continues from the current screen.';
};
document.getElementById('home').onclick = () => post('/home');
document.getElementById('send').onclick = async () => { const t = document.getElementById('text'); if (t.value) { await post('/type', { text: t.value }); t.value = ''; } };
img.onerror = () => { statusEl.textContent = 'live stream unavailable — retrying'; setTimeout(() => { img.src = base + '/stream?' + Date.now(); }, 3000); };
refresh(); setInterval(refresh, 2000);
`;
