// Provider-neutral tool definitions for the phone agent, plus parsing of a tool
// call back into an AgentAction. Model adapters translate these into their
// provider's tool format.

import { RISKS, type Risk, type SpecialKey } from "@agentphone/shared";
import type { ApprovalSpec } from "./approvals.ts";
import type { AgentAction } from "./types.ts";

export type ToolSpec = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
};

const common = {
  rationale: { type: "string", description: "One short sentence: what you expect this action to do. Shown to the owner." },
  risk: {
    type: "string",
    enum: RISKS,
    description:
      "Consequence class of THIS action. Use a non-normal value for the single action that commits something: sending a message/email/post or placing a call (external_communication), paying or buying (purchase), entering or submitting passwords/codes/sensitive personal data or changing credentials (authentication), deleting or irreversibly changing significant data (destructive). Everything else is normal.",
  },
  memory: {
    type: "string",
    description:
      "Optional. Facts visible NOW that you will need later (numbers, names, answers). You only ever see the current screenshot, so anything not saved here is forgotten once the screen changes.",
  },
  approval: {
    type: "object",
    description:
      'Required when risk is not "normal": exactly what the owner is authorizing. Every field is matched exactly when deciding whether an earlier approval covers a retry.',
    properties: {
      app: { type: "string", description: 'App performing it, e.g. "Messages".' },
      account: { type: "string", description: "Sending account/identity if visible (optional)." },
      operation: { type: "string", description: "send_message | place_call | purchase | delete | submit_credentials | change_settings | other" },
      recipient: { type: "string", description: "Phone number, email, or exact contact name as shown (if any)." },
      payload: { type: "string", description: "Exact content: the message text, amount, item, or what is deleted (if any)." },
      summary: { type: "string", description: 'One line for the owner, e.g. Send "Running 10 minutes late." to Marco.' },
    },
    required: ["app", "operation", "summary"],
    additionalProperties: false,
  },
} as const;

const KEYS: SpecialKey[] = ["return", "delete", "escape", "tab", "space", "up", "down", "left", "right"];

function tool(name: string, description: string, props: Record<string, unknown>, required: string[]): ToolSpec {
  return {
    name,
    description,
    input_schema: {
      type: "object",
      properties: { ...props, ...common },
      required: [...required, "rationale", "risk"],
      additionalProperties: false,
    },
  };
}

export const PHONE_TOOLS: ToolSpec[] = [
  tool("phone_screen", "Take a fresh screenshot without acting (e.g. after an animation or when unsure of state).", {}, []),
  tool(
    "phone_tap",
    "Tap a point. Coordinates are in screenshot pixels (origin top-left of the screenshot).",
    { x: { type: "number" }, y: { type: "number" } },
    ["x", "y"],
  ),
  tool(
    "phone_swipe",
    "Drag a finger from (x1,y1) to (x2,y2). To scroll content DOWN (reveal what is below), swipe from lower to higher on the screen (y1 > y2). Horizontal swipes change pages. Swipes starting at the very bottom edge are system gestures.",
    {
      x1: { type: "number" },
      y1: { type: "number" },
      x2: { type: "number" },
      y2: { type: "number" },
      duration_ms: { type: "number", description: "Gesture duration, default 300. Use ~800+ for slow drags." },
    },
    ["x1", "y1", "x2", "y2"],
  ),
  tool(
    "phone_type",
    "Type text into the currently focused text field (tap the field first). Set submit=true to press Return afterwards (search, go, send-on-return fields).",
    { text: { type: "string" }, submit: { type: "boolean" } },
    ["text"],
  ),
  tool("phone_key", "Press a special key on the hardware keyboard.", { key: { type: "string", enum: KEYS } }, ["key"]),
  tool("phone_home", "Go to the Home Screen.", {}, []),
  tool("phone_app_switcher", "Open the app switcher.", {}, []),
  tool(
    "phone_wait",
    "Wait for loading/animations, then observe again.",
    { ms: { type: "number", description: "Milliseconds, max 10000." } },
    ["ms"],
  ),
  tool(
    "phone_finish",
    "End the task. Call when the goal is achieved, impossible, or blocked (e.g. needs the owner's approval or information you don't have).",
    {
      status: { type: "string", enum: ["success", "failed", "blocked"] },
      summary: { type: "string", description: "What you did and what happened, in 1-3 sentences." },
      answer: { type: "string", description: "The direct answer if the goal asked a question." },
    },
    ["status", "summary"],
  ),
];

const num = (v: unknown, name: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
  return v;
};

function parseApproval(v: unknown): ApprovalSpec | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  const app = str("app"), operation = str("operation"), summary = str("summary");
  if (!app || !operation || !summary) return undefined;
  return { app, operation, summary, account: str("account"), recipient: str("recipient"), payload: str("payload") };
}

/** Validate a tool call and convert it to an AgentAction. Throws with a model-readable message. */
export function toolCallToAction(name: string, input: Record<string, unknown>): AgentAction {
  const risk = (RISKS.includes(input.risk as Risk) ? input.risk : "normal") as Risk;
  const base = {
    rationale: typeof input.rationale === "string" ? input.rationale : "",
    risk,
    approval: parseApproval(input.approval),
    memory: typeof input.memory === "string" && input.memory.trim() ? input.memory.trim() : undefined,
  };
  if (risk !== "normal" && name !== "phone_finish" && !base.approval) {
    throw new Error(`risk "${risk}" requires an "approval" object with at least app, operation and summary (plus recipient/payload when they apply)`);
  }
  switch (name) {
    case "phone_screen":
      return { ...base, type: "screen" };
    case "phone_tap":
      return { ...base, type: "tap", x: num(input.x, "x"), y: num(input.y, "y") };
    case "phone_swipe":
      return {
        ...base,
        type: "swipe",
        x1: num(input.x1, "x1"),
        y1: num(input.y1, "y1"),
        x2: num(input.x2, "x2"),
        y2: num(input.y2, "y2"),
        durationMs: input.duration_ms === undefined ? undefined : num(input.duration_ms, "duration_ms"),
      };
    case "phone_type":
      if (typeof input.text !== "string") throw new Error("text must be a string");
      return { ...base, type: "type", text: input.text, submit: input.submit === true };
    case "phone_key":
      if (!KEYS.includes(input.key as SpecialKey)) throw new Error(`key must be one of ${KEYS.join(", ")}`);
      return { ...base, type: "key", key: input.key as SpecialKey };
    case "phone_home":
      return { ...base, type: "home" };
    case "phone_app_switcher":
      return { ...base, type: "app_switcher" };
    case "phone_wait":
      return { ...base, type: "wait", ms: Math.min(10000, Math.max(0, num(input.ms, "ms"))) };
    case "phone_finish": {
      const status = input.status;
      if (status !== "success" && status !== "failed" && status !== "blocked") throw new Error("status must be success|failed|blocked");
      return {
        ...base,
        risk: "normal",
        type: "finish",
        status,
        summary: String(input.summary ?? ""),
        answer: typeof input.answer === "string" ? input.answer : undefined,
      };
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

/** Short human-readable form, used in logs, history and the activity feed. */
export function describeAction(a: AgentAction): string {
  switch (a.type) {
    case "screen": return "observe screen";
    case "tap": return `tap (${Math.round(a.x)}, ${Math.round(a.y)})`;
    case "swipe": return `swipe (${Math.round(a.x1)}, ${Math.round(a.y1)}) → (${Math.round(a.x2)}, ${Math.round(a.y2)})`;
    case "type": return `type ${JSON.stringify(a.text)}${a.submit ? " + return" : ""}`;
    case "key": return `key ${a.key}`;
    case "home": return "home";
    case "app_switcher": return "app switcher";
    case "wait": return `wait ${a.ms}ms`;
    case "finish": return `finish (${a.status})`;
  }
}
