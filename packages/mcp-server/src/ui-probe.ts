// MCP Apps capability probe: does a host (e.g. Grok Bot) render interactive UI returned
// by an MCP tool inside its chat? Three independent signals, all appended to
// ~/.agentphone/ui-probe.log:
//   1. client_capabilities — what the client advertises at initialize
//      (MCP Apps hosts list the "io.modelcontextprotocol/ui" extension);
//   2. resource_read — the host fetched the ui:// resource (hosts without MCP Apps never do);
//   3. button_click — the user clicked the button inside the rendered panel, which calls an
//      app-only tool the model can't see or call.
// Contract from @modelcontextprotocol/ext-apps 2.0.0 (spec 2026-01-26). Throwaway: no phone access.

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";
const PROBE_URI = "ui://agentphone/probe.html";
const MIME = "text/html;profile=mcp-app";

const logPath = join(process.env.AGENTPHONE_HOME ?? join(homedir(), ".agentphone"), "ui-probe.log");

export function probeLog(event: string, data: Record<string, unknown> = {}) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + "\n");
}

export function registerUiProbe(server: McpServer) {
  server.registerResource(
    "agentphone-ui-probe",
    PROBE_URI,
    { title: "AgentPhone UI probe", description: "Tiny interactive panel used to test MCP Apps support.", mimeType: MIME },
    async (uri) => {
      probeLog("resource_read", { uri: uri.href });
      return { contents: [{ uri: uri.href, mimeType: MIME, text: PROBE_HTML, _meta: { ui: { prefersBorder: true } } }] };
    },
  );

  server.registerTool(
    "agentphone_ui_probe",
    {
      description:
        "Diagnostic: shows a small interactive AgentPhone panel with one button inside the chat (MCP Apps). Only call when the user asks to run the UI probe.",
      inputSchema: {},
      _meta: { ui: { resourceUri: PROBE_URI }, "ui/resourceUri": PROBE_URI },
    },
    async () => {
      const probeId = randomUUID().slice(0, 8);
      probeLog("tool_called", { probeId });
      return {
        content: [{
          type: "text",
          text: `UI probe ${probeId}: if your client supports MCP Apps, an interactive panel with a button labelled "Click me" is shown with this result. Ask the user whether they see it and to click it. If no panel appears, tell the user: "No interactive panel was shown."`,
        }],
        structuredContent: { probeId },
      };
    },
  );

  // Callable only from the rendered panel (visibility "app"), never by the model.
  server.registerTool(
    "agentphone_ui_probe_click",
    {
      description: "Called by the UI probe panel when the user clicks its button. Not for the model.",
      inputSchema: { nonce: z.string().max(64) },
      _meta: { ui: { resourceUri: PROBE_URI, visibility: ["app"] } },
    },
    async ({ nonce }) => {
      probeLog("button_click", { nonce });
      return { content: [{ type: "text", text: `AgentPhone received the click (${nonce}).` }] };
    },
  );
}

// Vanilla JS implementation of the MCP Apps postMessage protocol (no SDK needed).
const PROBE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>
body{margin:0;font:14px -apple-system,system-ui,sans-serif;padding:14px;background:#f6f6f8;color:#111}
button{background:#0a84ff;color:#fff;border:0;border-radius:8px;padding:10px 16px;font:inherit;cursor:pointer}
#s{margin-top:10px;color:#555}
</style></head><body>
<b>📱 AgentPhone UI probe</b>
<p>If you can see this panel inside the chat, click the button.</p>
<button id="b">Click me</button>
<div id="s">connecting to host…</div>
<script>
let id = 0; const pending = new Map();
const s = document.getElementById('s');
function request(method, params) {
  const rid = ++id;
  window.parent.postMessage({ jsonrpc: '2.0', id: rid, method, params }, '*');
  return new Promise((res, rej) => { pending.set(rid, { res, rej }); setTimeout(() => rej(new Error('timeout: ' + method)), 15000); });
}
function notify(method, params) { window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*'); }
window.addEventListener('message', (ev) => {
  const m = ev.data; if (!m || m.jsonrpc !== '2.0') return;
  if (m.id !== undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  else if (m.method === 'ui/notifications/tool-result') s.textContent = 'host delivered the tool result ✓ — now click the button';
});
(async () => {
  try {
    const r = await request('ui/initialize', { appInfo: { name: 'agentphone-ui-probe', version: '1' }, appCapabilities: {}, protocolVersion: '2026-01-26' });
    notify('ui/notifications/initialized', {});
    s.textContent = 'connected to host: ' + ((r && r.hostInfo && r.hostInfo.name) || 'unknown') + ' — click the button';
  } catch (e) { s.textContent = 'host handshake failed: ' + e.message; }
})();
document.getElementById('b').onclick = async () => {
  s.textContent = 'sending…';
  try {
    const r = await request('tools/call', { name: 'agentphone_ui_probe_click', arguments: { nonce: Math.random().toString(36).slice(2, 10) } });
    s.textContent = '✓ ' + ((r && r.content && r.content[0] && r.content[0].text) || 'click delivered');
  } catch (e) { s.textContent = '✗ click could not reach AgentPhone: ' + e.message; }
};
</script></body></html>`;

/**
 * Elicitation probe: during a tool call the server asks the USER a question through the
 * client (a form with a Done / Not done choice). The answer returns to AgentPhone directly,
 * not via the model. Grok Bot's client advertises `elicitation: {form: {}}`; this checks the
 * UI actually shows it. Needs a stateful Streamable HTTP session with SSE responses (/mcp2).
 */
export function registerElicitProbe(server: McpServer) {
  server.registerTool(
    "agentphone_elicit_probe",
    {
      description:
        "Diagnostic: asks the user an in-chat question with buttons (MCP elicitation) and reports their answer. Only call when the user asks to run the elicitation probe.",
      inputSchema: {},
    },
    async (_args, extra) => {
      const probeId = randomUUID().slice(0, 8);
      probeLog("elicit_sent", { probeId });
      const t0 = Date.now();
      try {
        // Send as part of THIS tool call (rides the call's SSE response stream). The
        // standalone server.elicitInput() goes to the GET stream, which clients may never open.
        const r = await extra.sendRequest(
          {
            method: "elicitation/create",
            params: {
            mode: "form",
            message: `AgentPhone test ${probeId}: pretend you just finished something on the phone. Pick "done" and submit.`,
            requestedSchema: {
              type: "object",
              properties: {
                status: { type: "string", title: "Are you done on the phone?", enum: ["done", "not done"] },
              },
              required: ["status"],
            },
            },
          },
          ElicitResultSchema,
          { timeout: 5 * 60_000 },
        );
        probeLog("elicit_result", { probeId, action: r.action, answered: !!r.content, wait_ms: Date.now() - t0 }); // never log what the user typed
        return {
          content: [{
            type: "text",
            text: `Elicitation probe ${probeId}: the user responded with action="${r.action}"${r.content ? ` and ${JSON.stringify(r.content)}` : ""} after ${((Date.now() - t0) / 1000).toFixed(1)} s. Report exactly this to the user.`,
          }],
        };
      } catch (e) {
        probeLog("elicit_error", { probeId, error: (e as Error).message, wait_ms: Date.now() - t0 });
        return {
          isError: true,
          content: [{ type: "text", text: `Elicitation probe ${probeId} failed: ${(e as Error).message}. Tell the user no question was shown (or it couldn't be answered).` }],
        };
      }
    },
  );
}

/** Six differently-shaped elicitation requests, to find out why a client auto-declines. */
const ELICIT_VARIANTS: Array<{ id: string; what: string; params: Record<string, unknown> }> = [
  {
    id: "A", what: "baseline: mode=form + string enum (what was declined)",
    params: { mode: "form", message: "Variant A — are you done on the phone?", requestedSchema: { type: "object", properties: { status: { type: "string", title: "Status", enum: ["done", "not done"] } }, required: ["status"] } },
  },
  {
    id: "B", what: "no mode field (2025-06-18 style) + string enum",
    params: { message: "Variant B — are you done on the phone?", requestedSchema: { type: "object", properties: { status: { type: "string", title: "Status", enum: ["done", "not done"] } }, required: ["status"] } },
  },
  {
    id: "C", what: "single boolean",
    params: { message: "Variant C — tick the box if you are done.", requestedSchema: { type: "object", properties: { done: { type: "boolean", title: "I'm done" } }, required: ["done"] } },
  },
  {
    id: "D", what: "no fields (pure confirm / cancel)",
    params: { message: "Variant D — press Accept when you are done.", requestedSchema: { type: "object", properties: {} } },
  },
  {
    id: "E", what: "free-text string, optional",
    params: { message: "Variant E — type anything (optional) and submit.", requestedSchema: { type: "object", properties: { note: { type: "string", title: "Note" } } } },
  },
  {
    id: "F", what: "legacy enum with enumNames",
    params: { message: "Variant F — choose one.", requestedSchema: { type: "object", properties: { status: { type: "string", title: "Status", enum: ["done", "later"], enumNames: ["Done", "Later"] } }, required: ["status"] } },
  },
];

export function registerElicitMatrix(server: McpServer) {
  server.registerTool(
    "agentphone_elicit_matrix",
    {
      description:
        "Diagnostic: sends six differently-shaped in-chat questions (MCP elicitation) one after another and reports, for each, whether the user saw and answered it. Only call when the user asks to run the elicitation matrix.",
      inputSchema: {},
    },
    async (_args, extra) => {
      const runId = randomUUID().slice(0, 8);
      const rows: string[] = [];
      for (const v of ELICIT_VARIANTS) {
        const t0 = Date.now();
        probeLog("elicit_matrix_sent", { runId, variant: v.id, params: v.params });
        try {
          const r = await extra.sendRequest({ method: "elicitation/create", params: v.params } as never, ElicitResultSchema, { timeout: 90_000 });
          const ms = Date.now() - t0;
          probeLog("elicit_matrix_result", { runId, variant: v.id, action: r.action, content: r.content, ms });
          rows.push(`${v.id} (${v.what}): action=${r.action}${r.content ? ` ${JSON.stringify(r.content)}` : ""} after ${ms} ms${ms < 1000 && r.action !== "accept" ? " → likely auto-declined (not shown)" : ""}`);
        } catch (e) {
          const ms = Date.now() - t0;
          probeLog("elicit_matrix_error", { runId, variant: v.id, error: (e as Error).message, ms });
          rows.push(`${v.id} (${v.what}): ERROR ${(e as Error).message} after ${ms} ms`);
        }
      }
      return { content: [{ type: "text", text: `Elicitation matrix ${runId}:\n${rows.join("\n")}\nReport this table to the user verbatim.` }] };
    },
  );
}

/**
 * Standalone-stream elicitation: the question is sent on the session's GET SSE stream (not as
 * part of the tool call). Grok Bot's backend opens that stream for every session, and may
 * route it differently from in-call requests (which it auto-declines in ~100 ms).
 */
export function registerElicitStandalone(server: McpServer) {
  server.registerTool(
    "agentphone_elicit_standalone",
    {
      description:
        "Diagnostic: asks the user an in-chat question over the session's standalone stream (not inside this tool call). Only call when the user asks to run the standalone elicitation probe.",
      inputSchema: {},
    },
    async () => {
      const probeId = randomUUID().slice(0, 8);
      probeLog("elicit_standalone_sent", { probeId });
      const t0 = Date.now();
      try {
        // No related request id → the SDK sends it on the standalone GET stream.
        const r = await server.server.elicitInput(
          {
            message: `AgentPhone standalone test ${probeId}: press Accept if you can see this.`,
            requestedSchema: { type: "object", properties: {} },
          },
          { timeout: 90_000 },
        );
        const ms = Date.now() - t0;
        probeLog("elicit_standalone_result", { probeId, action: r.action, content: r.content, ms });
        return { content: [{ type: "text", text: `Standalone elicitation ${probeId}: action="${r.action}" after ${(ms / 1000).toFixed(1)} s. Report exactly this.` }] };
      } catch (e) {
        const ms = Date.now() - t0;
        probeLog("elicit_standalone_error", { probeId, error: (e as Error).message, ms });
        return { isError: true, content: [{ type: "text", text: `Standalone elicitation ${probeId} failed after ${(ms / 1000).toFixed(1)} s: ${(e as Error).message}` }] };
      }
    },
  );
}
