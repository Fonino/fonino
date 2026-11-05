// AgentModel backed by Claude via the Anthropic SDK.
//
// Each step is a single stateless request: system prompt + tools (stable, cacheable
// prefix) followed by one user message with the goal, the action log and ONLY the
// current screenshot. This keeps context and cost flat no matter how long a run gets.
//
// Env: ANTHROPIC_API_KEY (or any credential the SDK resolves), ANTHROPIC_WORKSPACE_ID
// (only for keys not scoped to a workspace), AGENTPHONE_MODEL
// (default claude-opus-5-5), AGENTPHONE_EFFORT (low|medium|high|xhigh|max).

import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "../prompt.ts";
import { PHONE_TOOLS, describeAction, toolCallToAction } from "../tools.ts";
import type { AgentContext, AgentDecision, AgentModel, ModelUsage } from "../types.ts";

// USD per million tokens [input, output]. Cache reads bill at 0.1x input, writes at 1.25x.
const PRICES: Record<string, [number, number]> = {
  "claude-fable-5-1": [10, 50],
  "claude-fable-5": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export class AnthropicModel implements AgentModel {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly effort?: Effort;

  constructor(opts: { model?: string; effort?: Effort } = {}) {
    this.name = opts.model ?? process.env.AGENTPHONE_MODEL ?? "claude-opus-5-5";
    this.effort = opts.effort ?? (process.env.AGENTPHONE_EFFORT as Effort | undefined);
    // Org-level keys that aren't scoped to a workspace must name one per request.
    const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
    this.client = new Anthropic(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {});
  }

  private buildUserContent(ctx: AgentContext): Anthropic.Beta.BetaContentBlockParam[] {
    const history = ctx.history.length
      ? ctx.history
          .map((h) => {
            const changed =
              h.changeRatio === undefined
                ? ""
                : h.changeRatio === 0
                  ? " (screen did NOT change at all)"
                  : ` (${h.changeRatio < 0.01 ? (h.changeRatio * 100).toFixed(1) : Math.round(h.changeRatio * 100)}% of screen changed)`;
            const detail = h.detail ? ` — ${h.detail}` : "";
            return `${h.step}. ${describeAction(h.action)} — "${h.action.rationale}" → ${h.outcome}${changed}${detail}`;
          })
          .join("\n")
      : "(none yet)";
    const notes = ctx.sessionNotes.length ? `\nEarlier in this session:\n${ctx.sessionNotes.map((n) => `- ${n}`).join("\n")}\n` : "";
    return [
      { type: "text", text: `GOAL: ${ctx.goal}\n${notes}\nDevice: ${ctx.deviceName}` },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: ctx.screen.screenshotBase64! },
      },
      {
        type: "text",
        text:
          `Current screenshot above: ${ctx.screen.width}x${ctx.screen.height} px, taken ${ctx.screen.timestamp}.\n` +
          (ctx.screen.notice ? `HOST NOTICE (from the computer controlling the phone, not the phone UI): ${ctx.screen.notice}\n` : "") +
          "\n" +
          `Actions so far:\n${history}\n\n` +
          (ctx.notes.length ? `Your saved notes:\n${ctx.notes.join("\n")}\n\n` : "") +
          (ctx.approvals.length
            ? `Owner approvals in force:\n${ctx.approvals.join("\n")}\nIf an approved action did NOT take effect (check the screen), you may retry it with the same risk and an identical approval object; it won't prompt again. Never repeat it once it has succeeded.\n\n`
            : "") +
          `Step ${ctx.step} of at most ${ctx.maxSteps}. Choose the next action.`,
      },
    ];
  }

  async nextAction(ctx: AgentContext): Promise<AgentDecision> {
    const response = await this.client.beta.messages.create({
      model: this.name,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      ...(this.effort ? { output_config: { effort: this.effort } } : {}),
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: PHONE_TOOLS as Anthropic.Beta.BetaTool[],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: this.buildUserContent(ctx) }],
    });

    const usage = this.usage(response);
    const fail = (error: string): AgentDecision => ({
      action: { type: "screen", rationale: "model gave no usable action", risk: "normal" },
      usage,
      model: response.model,
      error,
    });

    if (response.stop_reason === "refusal") {
      return fail(`model refused (${response.stop_details?.category ?? "unknown"})`);
    }
    const call = response.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!call) {
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .slice(0, 300);
      return fail(`no tool call (stop_reason=${response.stop_reason}): ${text}`);
    }
    try {
      return { action: toolCallToAction(call.name, call.input as Record<string, unknown>), usage, model: response.model };
    } catch (e) {
      return fail(`invalid ${call.name} call: ${(e as Error).message}`);
    }
  }

  private usage(r: Anthropic.Beta.BetaMessage): ModelUsage {
    const u = r.usage;
    const inputTokens = u.input_tokens ?? 0;
    const outputTokens = u.output_tokens ?? 0;
    const cacheReadTokens = u.cache_read_input_tokens ?? 0;
    const cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
    const price = PRICES[this.name];
    const costUsd = price
      ? (inputTokens * price[0] + cacheReadTokens * price[0] * 0.1 + cacheWriteTokens * price[0] * 1.25 + outputTokens * price[1]) / 1e6
      : undefined;
    return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd };
  }
}
