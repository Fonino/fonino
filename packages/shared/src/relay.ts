// Relay wire protocol between the cloud (api.fonino.app) and each host Mac, over one
// WebSocket per host that the host opens (outbound, so it works behind any home router).
// JSON text frames; bodies are base64. Responses may stream (live-view MJPEG).

export type Req = {
  t: "req";
  id: string;
  method: string;
  /** Path on the host, e.g. "/mcp" or "/view/iphone-002/stream". Only /mcp and /view/* are allowed. */
  path: string;
  headers: Record<string, string>;
  body?: string; // base64
};
export type Head = { t: "head"; id: string; status: number; headers: Record<string, string> };
export type Chunk = { t: "chunk"; id: string; data: string }; // base64
export type End = { t: "end"; id: string };
export type Fail = { t: "fail"; id: string; error: string };
export type Abort = { t: "abort"; id: string };
export type Hello = { t: "hello"; version: string; devices?: string[] };

/** What each host reports to the fleet dashboard (every few seconds). */
export type HostStatus = {
  version: string;
  uptimeS: number;
  devices: Array<{ id: string; name: string; status: string; detail?: string; lease?: { holder: string; task: string; until: string } | null }>;
  approvals: Array<{ id: string; deviceId: string; holder: string; risk: string; createdAt: string; spec: { app: string; operation: string; recipient?: string; payload?: string; summary: string }; code?: string }>;
  usage: Array<{ tenant: string; tenantName: string; calls: number; errors: number; messagesSent: number; leases: number; heldMinutes: number; devices: string[]; lastSeen: string }>;
  /** Standing "Always allow" rules the owner made (older hosts don't send it). */
  rules?: Array<{ id: string; holder: string; app: string; kind: string; perDay: number; createdAt: string }>;
};
export type Status = { t: "status"; status: HostStatus };

/** Fleet-dashboard commands the cloud may send a host (and nothing else). */
export type CmdOp = "approve" | "deny" | "approval_screen" | "live_link" | "rule_remove";
export type Cmd = { t: "cmd"; id: string; op: CmdOp; args: Record<string, string> };
export type CmdResult = { t: "cmd_result"; id: string; ok: boolean; result?: unknown; error?: string };

export type ToHost = Req | Abort | Cmd;
export type FromHost = Head | Chunk | End | Fail | Hello | Status | CmdResult;

/** Headers the cloud sets and the host trusts only on relay traffic (with the shared secret). */
export const H = {
  relay: "x-fonino-relay",
  principal: "x-fonino-principal", // base64url(JSON Principal)
  base: "x-fonino-base", // public base URL for links, e.g. https://api.fonino.app/h/<hostId>
  prefix: "x-fonino-prefix", // path prefix the browser sees for /view, e.g. /h/<hostId>
} as const;

/** Paths the host will serve for the relay; everything else (admin, oauth, …) stays local. */
export function relayablePath(p: string): boolean {
  return p === "/mcp" || /^\/view\/[^/]+(\/[a-z.]+)?(\?.*)?$/.test(p) || /^\/media\/[A-Za-z0-9_-]{20,64}\.(png|jpg|gif|webp|heic)$/.test(p);
}
