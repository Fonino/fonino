import type { Risk, ScreenState, SpecialKey } from "@agentphone/shared";
import type { ApprovalSpec } from "./approvals.ts";

type Base = {
  /** One-sentence, user-visible reason for this action (not chain-of-thought). */
  rationale: string;
  risk: Risk;
  /** Required for risk != "normal": exactly what the owner is being asked to authorize. */
  approval?: ApprovalSpec;
  /**
   * Facts read off the screen that the model will need later (values, names).
   * The loop carries these forward: each step only sees the *current* screenshot.
   */
  memory?: string;
};

export type AgentAction = Base &
  (
    | { type: "screen" }
    | { type: "tap"; x: number; y: number }
    | { type: "swipe"; x1: number; y1: number; x2: number; y2: number; durationMs?: number }
    | { type: "type"; text: string; submit?: boolean }
    | { type: "key"; key: SpecialKey }
    | { type: "home" }
    | { type: "app_switcher" }
    | { type: "wait"; ms: number }
    | { type: "finish"; status: "success" | "failed" | "blocked"; summary: string; answer?: string }
  );

export type StepOutcome = "ok" | "error" | "denied" | "invalid";

export type StepRecord = {
  step: number;
  action: AgentAction;
  outcome: StepOutcome;
  detail?: string;
  /** Did the screenshot visibly change between before and after this action? */
  screenChanged?: boolean;
  /** Fraction of the screen that changed (0..1). */
  changeRatio?: number;
};

export type AgentContext = {
  goal: string;
  deviceId: string;
  deviceName: string;
  step: number;
  maxSteps: number;
  /** Current screen, with screenshotBase64 populated. */
  screen: ScreenState;
  history: StepRecord[];
  /** Owner approvals still in force (intent + expiry), shown so the model can retry safely. */
  approvals: string[];
  /** Facts the model saved with `memory` on earlier steps of this run. */
  notes: string[];
  /** Outcomes of earlier goals in the same interactive session. */
  sessionNotes: string[];
  /** Risk categories the owner pre-authorized for this run (rarely used). */
  preauthorized: string[];
};

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
};

export type AgentDecision = {
  action: AgentAction;
  usage?: ModelUsage;
  model?: string;
  /** Set when the model produced no usable tool call. */
  error?: string;
};

/** Any multimodal model that can pick the next phone action. */
export interface AgentModel {
  readonly name: string;
  nextAction(context: AgentContext): Promise<AgentDecision>;
}

export type ApprovalRequest = {
  deviceId: string;
  risk: AgentAction["risk"];
  action: AgentAction;
  /** Structured intent — what a grant is keyed on. */
  spec: ApprovalSpec;
  /** Human-readable rendering of spec. */
  description: string;
  screenshotPath?: string;
};

/**
 * Returns true to allow. The CLI asks on the terminal; MCP/web can plug in their own.
 * Throw ApprovalUnavailableError when nobody can answer — the run then stops.
 */
export type ApprovalHandler = (req: ApprovalRequest) => Promise<boolean>;
