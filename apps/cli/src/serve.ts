// `agentphone serve`: a localhost HTTP bridge so a browser UI (apps/web) can watch
// and drive phones. The Mac runtime stays in control of the devices; the web app
// only ever talks to this bridge. Binds to 127.0.0.1 only.
//
//   GET  /api/devices
//   GET  /api/devices/:id/screen.png          fresh screenshot
//   POST /api/devices/:id/runs  {goal}        start an agent run → {runId}
//   GET  /api/runs/:runId                     events so far, pending approval, result
//   POST /api/runs/:runId/approval {allow}    answer a pending approval
//   GET  /api/runs/:runId/screens/:file       recorded screenshots

import { readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { AnthropicModel, describeAction, runAgent, type AgentEvent, type RunResult } from "@agentphone/agent-runtime";
import type { DeviceRegistry } from "@agentphone/device-core";

type LiveRun = {
  runId?: string;
  dir?: string;
  deviceId: string;
  goal: string;
  activity: { t: string; text: string; kind: string }[];
  latestScreen?: string;
  pending?: { description: string; risk: string; resolve: (ok: boolean) => void };
  result?: RunResult;
};

export async function startBridge(registry: DeviceRegistry, port: number): Promise<void> {
  const runs = new Map<string, LiveRun>();
  const busy = new Set<string>(); // one run per device at a time
  let seq = 0;

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage) =>
    new Promise<any>((resolve) => {
      let b = "";
      req.on("data", (c) => {
        b += c;
        if (b.length > 20_000) req.destroy(); // no unbounded bodies
      });
      req.on("end", () => {
        try {
          resolve(b ? JSON.parse(b) : {});
        } catch {
          resolve({});
        }
      });
    });

  // Only the local web UI may call this bridge. Any other website the owner visits must not be
  // able to read screenshots or start/approve runs (no CORS "*"), and DNS-rebinding names are
  // refused by the Host check.
  const allowedOrigins = new Set((process.env.AGENTPHONE_WEB_ORIGIN ?? "http://localhost:3000,http://127.0.0.1:3000").split(","));
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "") || (origin && !allowedOrigins.has(origin))) {
      return json(res, 403, { error: "forbidden" });
    }
    if (origin) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-headers", "content-type");
    }
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    // A form or <img> from another site sends no Origin but can't use JSON bodies; require it for writes.
    if (req.method === "POST" && !(req.headers["content-type"] ?? "").includes("application/json")) return json(res, 415, { error: "json only" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
    try {
      if (parts[1] === "devices" && parts.length === 2) {
        return json(res, 200, await registry.listDevices());
      }
      if (parts[1] === "devices" && parts[3] === "screen.png") {
        const s = await (await registry.getDevice(parts[2])).getScreen();
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        return res.end(readFileSync(s.screenshotPath!));
      }
      if (parts[1] === "devices" && parts[3] === "runs" && req.method === "POST") {
        const deviceId = parts[2];
        const { goal } = await readBody(req);
        if (!goal) return json(res, 400, { error: "goal required" });
        if (busy.has(deviceId)) return json(res, 409, { error: `${deviceId} is already running a task` });
        const device = await registry.getDevice(deviceId);
        const key = `live-${++seq}`;
        const live: LiveRun = { deviceId, goal, activity: [] };
        runs.set(key, live);
        busy.add(deviceId);
        const push = (kind: string, text: string) => live.activity.push({ t: new Date().toISOString(), kind, text });
        runAgent({
          device,
          model: new AnthropicModel(),
          goal,
          approve: (r) =>
            new Promise<boolean>((resolve) => {
              push("approval", `Waiting for approval: ${r.description}`);
              live.pending = { description: r.description, risk: r.risk, resolve };
            }),
          onEvent: (e: AgentEvent) => {
            if (e.kind === "start") {
              live.runId = e.runId;
              live.dir = e.dir;
            } else if (e.kind === "screen") live.latestScreen = e.screen;
            else if (e.kind === "decision" && e.action.type !== "finish") push("action", e.action.rationale || describeAction(e.action));
            else if (e.kind === "step" && e.record.outcome !== "ok") push("warn", `${e.record.outcome}${e.record.detail ? `: ${e.record.detail}` : ""}`);
            else if (e.kind === "approval") push("approval", `${e.allowed ? "Approved" : "Declined"}: ${e.description}`);
            else if (e.kind === "error") push("warn", e.message);
          },
        })
          .then((r) => {
            live.result = r;
            push("done", `${r.status}: ${r.summary}${r.answer ? ` — ${r.answer}` : ""}`);
          })
          .catch((err) => push("warn", `run crashed: ${(err as Error).message}`))
          .finally(() => busy.delete(deviceId));
        return json(res, 202, { runId: key });
      }
      if (parts[1] === "runs" && parts[2]) {
        const live = runs.get(parts[2]);
        if (!live) return json(res, 404, { error: "unknown run" });
        if (parts[3] === "approval" && req.method === "POST") {
          const { allow } = await readBody(req);
          if (!live.pending) return json(res, 409, { error: "nothing pending" });
          const p = live.pending;
          live.pending = undefined;
          p.resolve(allow === true);
          return json(res, 200, { ok: true });
        }
        if (parts[3] === "screens" && parts[4] && live.dir && /^\d+\.png$/.test(parts[4])) {
          res.writeHead(200, { "content-type": "image/png" });
          return res.end(readFileSync(join(live.dir, "screens", parts[4])));
        }
        const { pending, ...rest } = live;
        return json(res, 200, { ...rest, pending: pending && { description: pending.description, risk: pending.risk } });
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });

  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  console.log(`AgentPhone bridge on http://127.0.0.1:${port}  (web UI: cd apps/web && npm run dev)`);
}
