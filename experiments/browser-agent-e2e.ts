// Manual end-to-end check (real network, real AI): Claude plays the remote agent (as Grok or Muse
// would) and uses ONLY the MCP browser tools. Conversation 1 does a purchase and saves a recipe;
// conversation 2 repeats it for other values via the recipe. Approvals are answered by a scripted
// "owner". Logins come from a throwaway keychain. Costs a few cents of API usage.
//
// Usage: node experiments/browser-agent-e2e.ts   (SITE=saucedemo; ENGINE=chrome|lightpanda)
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) for (const l of readFileSync(envFile, "utf8").split("\n")) {
  const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
}
const home = mkdtempSync(join(tmpdir(), "agentphone-e2e-"));
process.env.AGENTPHONE_HOME = home;
process.env.AGENTPHONE_RUNS_DIR = join(home, "runs");
const { DeviceRegistry, LeaseStore } = await import("@agentphone/device-core");
const { startRemoteMcp } = await import("@agentphone/mcp-server");
const { BrowserService, KeychainVault } = await import("@agentphone/browser");

const ORIGIN = "https://www.saucedemo.com";
const PASSWORD = "secret_sauce"; // saucedemo's public test login
// Throwaway keychain (deleted at the end); the user's keychain search list is left as it was.
const kc = join(home, "e2e.keychain-db");
const kcPass = Math.random().toString(36).slice(2);
const searchList = execFileSync("security", ["list-keychains", "-d", "user"]).toString().split("\n").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
execFileSync("security", ["create-keychain", "-p", kcPass, kc]);
execFileSync("security", ["list-keychains", "-d", "user", "-s", ...searchList]);
execFileSync("security", ["unlock-keychain", "-p", kcPass, kc]);
const vault = new KeychainVault({ keychain: kc, indexPath: join(home, "vault.json") });
vault.addValueForTesting(ORIGIN, "username", "standard_user");
vault.addValueForTesting(ORIGIN, "password", PASSWORD);

const browser = new BrowserService({ vault, ai: null, engine: { kind: process.env.ENGINE === "lightpanda" ? "lightpanda" : "chrome" } });
const registry = new DeviceRegistry({ aliases: false, leases: new LeaseStore() }); // no phones
const { server, core } = await startRemoteMcp({ registry, token: "ap_e2e", port: 0, browser, log: () => {} });
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// Scripted owner: approves every request after a moment, and logs what it was asked.
const approvals: string[] = [];
const owner = setInterval(() => {
  for (const a of core.approvals.list("pending")) {
    approvals.push(`${a.spec.summary} | ${a.spec.payload?.replace(/\n/g, " | ").slice(0, 160)}`);
    core.approvals.decide(a.id, true);
  }
}, 700);

const mcp = new Client({ name: "e2e-agent", version: "1" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: "Bearer ap_e2e" } } }));
const tools = (await mcp.listTools()).tools
  .filter((t) => t.name.startsWith("browser_"))
  .map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema as Anthropic.Tool.InputSchema }));

const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
const ai = new Anthropic(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {});
const outputs: string[] = [];

async function conversation(title: string, userRequest: string) {
  console.log(`\n=== ${title} ===\nUser: ${userRequest}`);
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: userRequest }];
  const t0 = Date.now();
  let calls = 0, toolCalls = 0, inTok = 0, outTok = 0;
  for (let turn = 0; turn < 40; turn++) {
    const resp = await ai.beta.messages.create({
      model: "claude-opus-5-5", max_tokens: 4000, tools, messages,
      system: "You are an AI assistant with a web browser (the browser_* tools). Act for the user. If something needs the owner's approval, wait for it with the await tool and continue; the owner is available.",
      output_config: { effort: "low" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming);
    calls++;
    inTok += resp.usage.input_tokens; outTok += resp.usage.output_tokens;
    messages.push({ role: "assistant", content: resp.content });
    const uses = resp.content.filter((b) => b.type === "tool_use");
    if (!uses.length) {
      const text = resp.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join(" ");
      console.log(`Agent: ${text.slice(0, 500)}`);
      break;
    }
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const u of uses) {
      if (u.type !== "tool_use") continue;
      toolCalls++;
      const r = (await mcp.callTool({ name: u.name, arguments: u.input as Record<string, unknown> })) as { content: Array<{ text?: string }>; isError?: boolean };
      const text = r.content.map((c) => c.text ?? "").join("\n");
      outputs.push(text);
      const head = text.split("\n\nPAGE")[0].replace(/\s+/g, " ").slice(0, 150);
      console.log(`  → ${u.name} ${JSON.stringify(u.input).slice(0, 110)}\n     ${r.isError ? "ERROR " : ""}${head}`);
      results.push({ type: "tool_result", tool_use_id: u.id, content: text, is_error: !!r.isError });
    }
    messages.push({ role: "user", content: results });
  }
  const s = { seconds: +((Date.now() - t0) / 1000).toFixed(1), model_calls: calls, tool_calls: toolCalls, input_tokens: inTok, output_tokens: outTok };
  console.log(`[${title}] ${JSON.stringify(s)}`);
  return s;
}

try {
  const first = await conversation(
    "1. First time: do it and save a recipe",
    `On ${ORIGIN} (my login is saved), buy the "Sauce Labs Backpack" for Ada Lovelace, zip 94016. When the order is confirmed, save what you did as a recipe called "buy-product" so you can repeat it for any product and buyer.`,
  );
  const second = await conversation(
    "2. Next time: use the recipe",
    `On ${ORIGIN}, buy the "Sauce Labs Bike Light" for Grace Hopper, zip 10001. Use a saved recipe if there is one.`,
  );
  console.log("\nOwner was asked to approve:\n- " + approvals.join("\n- "));
  for (const r of browser.recipes.list()) console.log(`\nrecipe ${r.id} v${r.version} params=${r.params} risky=${r.steps.filter((s) => s.target.sensitiveAction).map((s) => s.target.label).join(", ")}`);
  console.log(`\npassword in anything the agent saw: ${outputs.some((o) => o.includes(PASSWORD)) ? "LEAKED" : "no"}`);
  console.log(`speed-up of the repeat: ${(first.seconds / second.seconds).toFixed(1)}x time, ${(first.model_calls / second.model_calls).toFixed(1)}x fewer model calls`);
} finally {
  clearInterval(owner);
  await mcp.close();
  core.releaseAll();
  await browser.closeAll();
  server.closeAllConnections();
  server.close();
  execFileSync("security", ["delete-keychain", kc]);
  execFileSync("security", ["list-keychains", "-d", "user", "-s", ...searchList]);
}
