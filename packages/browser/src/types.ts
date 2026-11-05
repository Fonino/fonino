// Agent browser: recipes are recorded browser tasks that replay without an AI.
// A recipe never contains secret values or the user's data: secrets are vault references
// (fill_secret) and user data is templated as {param}.

export type Op = "type" | "select" | "fill_secret" | "click";
export const OPS: readonly Op[] = ["type", "select", "fill_secret", "click"];
export type SecretKind = "username" | "password";
export const SECRET_KINDS: readonly SecretKind[] = ["username", "password"];

/** How a step finds its element again: the most stable attribute available. */
export interface Target {
  tag: string;
  attr: "data-test" | "id" | "name" | "text";
  key: string;
  label: string;
  /** The vault secret this field holds, as detected by the browser (never the value). */
  secret: SecretKind | null;
  /** A click that commits the user (pay, order, send…): always needs the owner's approval. */
  sensitiveAction: boolean;
  riskReasons?: string[];
}

export interface Step {
  op: Op;
  /** Page path (no origin, no session ids) the step runs on. */
  path: string;
  target: Target;
  /** Typed text or option label; may contain {param} placeholders. */
  text?: string;
  /** For fill_secret: which vault secret to fill. */
  secret?: SecretKind;
}

export type RecipeStatus = "approved" | "needs_review" | "broken" | "rejected";

export interface RecipeChange {
  kind: "inserted" | "replaced";
  /** 1-based position in the new version. */
  at: number;
  from?: Step;
  step: Step;
}

export interface Recipe {
  /** "<host>/<task>", e.g. "www.saucedemo.com/buy-product". */
  id: string;
  /** Origin the recipe runs on; secrets and links are bound to it. */
  site: string;
  /** Page the replay starts from. */
  start: string;
  task: string;
  version: number;
  status: RecipeStatus;
  /** Text the final page must show for the run to count as done (may contain {param}). */
  endCheck: string;
  params: string[];
  steps: Step[];
  changes?: RecipeChange[];
  source: "recorded" | "repaired" | "imported";
  /** Who reviewed risky steps besides the rules: the calling agent, our optional AI, or rules only. */
  riskReview: "agent" | "ai" | "rules";
  createdAt: string;
  reviewedBy?: string;
}

/** What the agent sees of a page: compact text, indexes valid for this snapshot only. */
export interface Snapshot {
  gen: number;
  url: string;
  path: string;
  title: string;
  text: string;
}
