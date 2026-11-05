// MCP server exposing AgentPhone devices as tools, so any MCP-capable agent
// (Claude Code, Claude Desktop, other runtimes) can observe and operate the phone.
// It uses the exact same DeviceRegistry/PhoneDevice as the CLI — no separate control logic.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { DeviceRegistry } from "@agentphone/device-core";
import type { SpecialKey } from "@agentphone/shared";

const deviceId = z.string().describe('Device id from phone_list_devices, e.g. "iphone-001"');
const after = z
  .boolean()
  .optional()
  .describe("Return a screenshot taken ~0.8s after the action (saves a phone_get_screen round trip).");

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export function createMcpServer(registry: DeviceRegistry): McpServer {
  const server = new McpServer({ name: "agentphone", version: "0.1.0" });

  const screenContent = async (id: string, note?: string): Promise<Content[]> => {
    const dev = await registry.getDevice(id);
    const s = await dev.getScreen({ includeBase64: true });
    return [
      { type: "image", data: s.screenshotBase64!, mimeType: "image/png" },
      {
        type: "text",
        text: `${note ? note + "\n" : ""}Screenshot of ${s.deviceId}: ${s.width}x${s.height} px (tap coordinates use these pixels, origin top-left), taken ${s.timestamp}.`,
      },
    ];
  };

  /** Wrap a device action: errors become tool errors with the fix hint, optional after-screenshot. */
  const act =
    <A extends { device_id: string; screenshot_after?: boolean }>(label: (a: A) => string, fn: (a: A) => Promise<void>) =>
    async (a: A) => {
      try {
        await fn(a);
        if (a.screenshot_after) {
          await new Promise((r) => setTimeout(r, 800));
          return { content: await screenContent(a.device_id, `ok: ${label(a)}`) };
        }
        return { content: [{ type: "text" as const, text: `ok: ${label(a)}` }] };
      } catch (e) {
        const err = e as Error & { fix?: string };
        return { isError: true, content: [{ type: "text" as const, text: `${err.message}${err.fix ? `\nFix: ${err.fix}` : ""}` }] };
      }
    };

  server.registerTool(
    "phone_list_devices",
    { description: "List phones AgentPhone can see, with connection status.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: JSON.stringify(await registry.listDevices(), null, 2) }] }),
  );

  server.registerTool(
    "phone_get_status",
    { description: "Detailed status, capabilities and setup checks for one phone.", inputSchema: { device_id: deviceId } },
    async ({ device_id }) => ({
      content: [{ type: "text", text: JSON.stringify(await (await registry.getDevice(device_id)).getStatus(), null, 2) }],
    }),
  );

  server.registerTool(
    "phone_get_screen",
    { description: "Capture the phone's current screen as a PNG image.", inputSchema: { device_id: deviceId } },
    async ({ device_id }) => {
      try {
        return { content: await screenContent(device_id) };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
      }
    },
  );

  server.registerTool(
    "phone_tap",
    {
      description: "Tap at (x, y) in screenshot pixel coordinates.",
      inputSchema: { device_id: deviceId, x: z.number(), y: z.number(), screenshot_after: after },
    },
    act((a) => `tap (${a.x}, ${a.y})`, async (a) => (await registry.getDevice(a.device_id)).tap(a.x, a.y)),
  );

  server.registerTool(
    "phone_swipe",
    {
      description: "Swipe/drag from (x1,y1) to (x2,y2). To scroll content down, swipe upward (y1 > y2).",
      inputSchema: {
        device_id: deviceId,
        x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
        duration_ms: z.number().optional().describe("Default 300"),
        screenshot_after: after,
      },
    },
    act(
      (a) => `swipe (${a.x1}, ${a.y1}) → (${a.x2}, ${a.y2})`,
      async (a) => (await registry.getDevice(a.device_id)).swipe(a.x1, a.y1, a.x2, a.y2, a.duration_ms),
    ),
  );

  server.registerTool(
    "phone_type",
    {
      description: "Type text into the focused field. submit=true presses Return afterwards.",
      inputSchema: { device_id: deviceId, text: z.string(), submit: z.boolean().optional(), screenshot_after: after },
    },
    act(
      (a) => `typed ${JSON.stringify(a.text)}`,
      async (a) => {
        const d = await registry.getDevice(a.device_id);
        await d.type(a.text);
        if (a.submit) await d.key("return");
      },
    ),
  );

  server.registerTool(
    "phone_key",
    {
      description: "Press a special key.",
      inputSchema: {
        device_id: deviceId,
        key: z.enum(["return", "delete", "escape", "tab", "space", "up", "down", "left", "right"]),
        screenshot_after: after,
      },
    },
    act((a) => `key ${a.key}`, async (a) => (await registry.getDevice(a.device_id)).key(a.key as SpecialKey)),
  );

  server.registerTool(
    "phone_home",
    { description: "Go to the Home Screen.", inputSchema: { device_id: deviceId, screenshot_after: after } },
    act(() => "home", async (a) => (await registry.getDevice(a.device_id)).home()),
  );

  server.registerTool(
    "phone_app_switcher",
    { description: "Open the app switcher.", inputSchema: { device_id: deviceId, screenshot_after: after } },
    act(() => "app switcher", async (a) => (await registry.getDevice(a.device_id)).appSwitcher()),
  );

  server.registerTool(
    "phone_wait",
    { description: "Wait for a number of milliseconds (max 10000).", inputSchema: { device_id: deviceId, ms: z.number(), screenshot_after: after } },
    act((a) => `waited ${a.ms}ms`, async (a) => (await registry.getDevice(a.device_id)).wait(Math.min(10000, a.ms))),
  );

  return server;
}

export async function startMcpServer(registry: DeviceRegistry): Promise<void> {
  const server = createMcpServer(registry);
  await server.connect(new StdioServerTransport());
}

export { RemoteAgentPhone, startRemoteMcp, newToken, readToken, type RemoteMcpOptions } from "./remote.ts";
export { ApprovalQueue, type ApprovalRecord, type ApprovalRule } from "./approval-queue.ts";
export { KeyStore, OWNER, canMessage, canUseDevice, type ApiKeyRecord, type Principal } from "./keys.ts";
export { UsageLog, type UsageEvent, type TenantUsage } from "./usage.ts";
export { isLocalRequest, adminLoginToken } from "./admin.ts";
export { pruneData, RETENTION } from "./retention.ts";
export { OAuthServer } from "./oauth.ts";
export { REVIEW_OP, requestReview, reviewText, syncReviews } from "./recipe-reviews.ts";
export { BROWSER_TOOL_META } from "./browser-tools.ts";
export { SendLimiter, DEFAULT_LIMITS, limitsFromEnv, type Limits } from "./ratelimit.ts";
