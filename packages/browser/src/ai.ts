// Optional local AI (the owner's Anthropic key), OFF by default (AGENTPHONE_BROWSER_AI=1).
// Over MCP the calling agent is the AI: it records, repairs and flags risky steps itself, so the
// service has no per-run AI cost. Local AI is only for CLI-driven runs and testing.
//
// Env: ANTHROPIC_API_KEY, ANTHROPIC_WORKSPACE_ID (keys not scoped to a workspace),
// AGENTPHONE_MODEL (default claude-opus-5-5).
import Anthropic from "@anthropic-ai/sdk";

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface BrowserAi {
  /** One structured-output call that returns JSON matching `schema`. */
  structured<T>(schema: Record<string, unknown>, prompt: string): Promise<T>;
  /** One call that must choose exactly one of `tools`. */
  oneAction(tools: Anthropic.Beta.BetaTool[], prompt: string): Promise<ToolCall | null>;
  calls: number;
}

export function makeAi(): BrowserAi | null {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  const client = new Anthropic(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {});
  const model = process.env.AGENTPHONE_MODEL ?? "claude-opus-5-5";
  // Server-side fallback: if the model declines, the API re-runs the request on a fallback model.
  const base = { model, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } as const;

  const ai: BrowserAi = {
    calls: 0,
    async structured<T>(schema: Record<string, unknown>, prompt: string): Promise<T> {
      ai.calls++;
      const resp = await client.beta.messages.create({
        ...base,
        max_tokens: 4000,
        output_config: { effort: "low", format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: prompt }],
      } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming);
      if (resp.stop_reason === "refusal") throw new Error("the model declined this request");
      const text = resp.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") throw new Error("no structured output returned");
      return JSON.parse(text.text) as T;
    },
    async oneAction(tools, prompt) {
      ai.calls++;
      const resp = await client.beta.messages.create({
        ...base,
        max_tokens: 4000,
        tools,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: prompt }],
      } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming);
      if (resp.stop_reason === "refusal") throw new Error("the model declined this request");
      const call = resp.content.find((b) => b.type === "tool_use");
      return call && call.type === "tool_use" ? { name: call.name, input: call.input as Record<string, unknown> } : null;
    },
  };
  return ai;
}
