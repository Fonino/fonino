// WebDriverAgent stops answering after ~2,520 connections in one run, however cleanly each is
// closed (seen as WDA dying every ~50 minutes under health checks and status polling). So every
// request to a phone reuses a couple of kept-alive connections instead of opening one per request.

import http from "node:http";
import type net from "node:net";

/** WDA closes a connection idle for 30 s; drop ours well before so a reused one is never stale. */
const IDLE_MS = 15_000;

const agents = new Map<string, http.Agent>();

/**
 * One keep-alive agent per phone (and port). `connect` opens a new transport (usbmuxd tunnel) and
 * only runs when no idle connection is left. Concurrent requests (a long screenshot while a health
 * check runs) get a second connection; nothing beyond `maxSockets` is ever opened at once.
 */
export function keepAliveAgent(key: string, connect: () => Promise<net.Socket>, maxSockets = 2): http.Agent {
  let agent = agents.get(key);
  if (agent) return agent;
  agent = new http.Agent({ keepAlive: true, maxSockets, maxFreeSockets: maxSockets, timeout: IDLE_MS });
  // Node's Agent accepts an async createConnection through its callback.
  agent.createConnection = ((_opts: unknown, cb: (err: Error | null, s?: net.Socket) => void) => {
    connect().then((s) => cb(null, s), (e: Error) => cb(e));
    return undefined;
  }) as unknown as http.Agent["createConnection"];
  agents.set(key, agent);
  return agent;
}

/** Forget the connections of every agent whose key starts with `prefix` (WDA restarted, phone replugged). */
export function dropAgents(prefix: string) {
  for (const [k, a] of agents) {
    if (!k.startsWith(prefix)) continue;
    a.destroy();
    agents.delete(k);
  }
}

/** A request that failed on a reused idle connection never reached WDA: it's safe to send again. */
export function staleReuse(req: http.ClientRequest, e: NodeJS.ErrnoException, gotResponse: boolean): boolean {
  return req.reusedSocket && !gotResponse && (e.code === "ECONNRESET" || e.code === "EPIPE");
}
