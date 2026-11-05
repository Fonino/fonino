// Host side of the cloud relay: keeps one outbound WebSocket to api.fonino.app open, and
// replays each request it receives against the local phone service (127.0.0.1), marked with
// an in-process secret so the service trusts the identity the cloud authenticated. Only /mcp
// and /view/* are ever forwarded: the admin dashboard, OAuth and everything else stay local.

import http from "node:http";
import WebSocket from "ws";
import { H, relayablePath, type CmdOp, type FromHost, type HostStatus, type ToHost } from "@agentphone/shared";

export type RelayClientOptions = {
  url: string; // wss://api.fonino.app/host
  hostToken: string;
  localPort: number;
  secret: string;
  devices?: () => Promise<string[]>;
  /** Fleet dashboard: what this host reports every few seconds. */
  status?: () => Promise<HostStatus>;
  /** Fleet dashboard: carry out an allowed command (approve/deny, approval screenshot, live link). */
  command?: (op: CmdOp, args: Record<string, string>) => Promise<unknown>;
  log?: (l: string) => void;
};

const OPS: readonly CmdOp[] = ["approve", "deny", "approval_screen", "live_link", "rule_remove"];
const STATUS_EVERY_MS = 5000;

export function startRelayClient(o: RelayClientOptions): { stop(): void } {
  const log = o.log ?? ((l: string) => console.log(l));
  let ws: WebSocket | undefined;
  let stopped = false;
  let backoff = 1000;
  const inflight = new Map<string, http.ClientRequest>();

  const send = (m: FromHost) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };

  function handle(m: ToHost) {
    if (m.t === "cmd") {
      if (!o.command || !OPS.includes(m.op)) return send({ t: "cmd_result", id: m.id, ok: false, error: "unsupported" });
      o.command(m.op, Object.fromEntries(Object.entries(m.args ?? {}).map(([k, v]) => [k, String(v)])))
        .then((result) => send({ t: "cmd_result", id: m.id, ok: true, result }))
        .catch((e) => send({ t: "cmd_result", id: m.id, ok: false, error: (e as Error).message }));
      return;
    }
    if (m.t === "abort") {
      inflight.get(m.id)?.destroy();
      inflight.delete(m.id);
      return;
    }
    if (m.t !== "req") return;
    if (!relayablePath(m.path) || !["GET", "POST"].includes(m.method)) {
      send({ t: "head", id: m.id, status: 404, headers: {} });
      return send({ t: "end", id: m.id });
    }
    const headers: Record<string, string> = {};
    // Only what the cloud may say, plus our own trust marker. Never forward anything that could
    // make this look like a local (admin) request.
    for (const [k, v] of Object.entries(m.headers ?? {})) {
      if (/^(content-type|accept|mcp-protocol-version|cookie|x-agentphone|user-agent|x-fonino-principal|x-fonino-base|x-fonino-prefix)$/i.test(k)) headers[k] = String(v);
    }
    headers[H.relay] = o.secret;
    headers["x-forwarded-proto"] = "https";
    const body = m.body ? Buffer.from(m.body, "base64") : undefined;
    if (body) headers["content-length"] = String(body.length);
    const req = http.request({ host: "127.0.0.1", port: o.localPort, method: m.method, path: m.path, headers }, (res) => {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h[k] = Array.isArray(v) ? v.join(", ") : String(v);
      send({ t: "head", id: m.id, status: res.statusCode ?? 502, headers: h });
      res.on("data", (c: Buffer) => send({ t: "chunk", id: m.id, data: c.toString("base64") }));
      res.on("end", () => {
        inflight.delete(m.id);
        send({ t: "end", id: m.id });
      });
      res.on("error", () => send({ t: "fail", id: m.id, error: "response error" }));
    });
    req.on("error", (e) => {
      inflight.delete(m.id);
      send({ t: "fail", id: m.id, error: e.message });
    });
    inflight.set(m.id, req);
    req.end(body);
  }

  function connect() {
    if (stopped) return;
    const sock = new WebSocket(o.url, { headers: { authorization: `Bearer ${o.hostToken}` }, handshakeTimeout: 10_000 });
    ws = sock;
    sock.on("open", async () => {
      backoff = 1000;
      log(`relay: connected to ${o.url}`);
      send({ t: "hello", version: "1", devices: (await o.devices?.().catch(() => undefined)) ?? undefined });
      const report = async () => {
        if (ws !== sock || sock.readyState !== WebSocket.OPEN || !o.status) return;
        const st = await o.status().catch(() => undefined);
        if (st) send({ t: "status", status: st });
      };
      void report();
      const timer = setInterval(report, STATUS_EVERY_MS);
      sock.once("close", () => clearInterval(timer));
    });
    sock.on("message", (d) => {
      try {
        handle(JSON.parse(d.toString()) as ToHost);
      } catch {
        /* ignore malformed frames */
      }
    });
    sock.on("unexpected-response", (_req, res) => {
      log(`relay: refused (${res.statusCode}${res.statusCode === 401 ? ": check the host token" : ""})`);
      sock.terminate(); // with this listener set, ws leaves the socket hanging: close it so we retry
    });
    sock.on("close", () => {
      for (const r of inflight.values()) r.destroy();
      inflight.clear();
      if (stopped) return;
      const wait = backoff;
      backoff = Math.min(backoff * 2, 30_000);
      log(`relay: disconnected; retrying in ${Math.round(wait / 1000)} s`);
      setTimeout(connect, wait);
    });
    sock.on("error", () => {
      /* 'close' follows and handles the retry */
    });
  }
  connect();
  return {
    stop() {
      stopped = true;
      ws?.close();
    },
  };
}
