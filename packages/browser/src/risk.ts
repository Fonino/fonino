// Which steps commit the user to something. Three independent signals; any one is enough, and a
// re-check can only add risk, never remove it (stored flags are not trusted).
import type { Risk } from "@agentphone/shared";
import type { BrowserAi } from "./ai.ts";
import type { Recipe, Step } from "./types.ts";

/** Words on a button that commit the user. Links are never flagged by words ("Bill Pay" menus). */
export const SENSITIVE_ACTION = /(place order|buy|pay|purchase|checkout|check out|transfer|send money|confirm order|complete order|subscribe|delete account|close account)/i;

/** Map a risky click to the approval queue's risk kinds. */
export function riskOf(label: string): Risk {
  if (/\b(delete|remove|cancel|close account|unsubscribe)\b/i.test(label)) return "destructive";
  if (/\b(send|post|publish|reply|share|submit message|message)\b/i.test(label) && !/send (money|payment)/i.test(label)) return "external_communication";
  if (/\b(authori[sz]e|allow access|grant access|connect)\b/i.test(label)) return "authentication";
  return "purchase";
}

function flag(st: Step, reason: string) {
  st.target.sensitiveAction = true;
  st.target.riskReasons = [...new Set([...(st.target.riskReasons ?? []), reason])];
}

/** Rule signals only (no AI): keyword on buttons + the last click before the confirmation. */
export function classifyRiskRules(recipe: Recipe): number[] {
  const before = recipe.steps.map((s) => s.target.sensitiveAction);
  for (const st of recipe.steps) {
    if (st.op === "click" && st.target.tag !== "a" && SENSITIVE_ACTION.test(st.target.label || st.target.key)) flag(st, "keyword match");
  }
  const lastClick = recipe.steps.map((s) => s.op).lastIndexOf("click");
  if (lastClick >= 0) flag(recipe.steps[lastClick], "final step before confirmation");
  return recipe.steps.flatMap((s, i) => (!before[i] && s.target.sensitiveAction ? [i] : []));
}

/** All signals. Returns indexes of steps that were not risky before and are now. */
export async function classifyRisk(recipe: Recipe, ai: BrowserAi | null): Promise<number[]> {
  const before = recipe.steps.map((s) => s.target.sensitiveAction);
  classifyRiskRules(recipe);
  if (ai) {
    const list = recipe.steps.map((st, i) => `${i + 1}. ${st.op} ${st.target.tag} "${st.target.label || st.target.key}" [${st.target.attr}=${st.target.key}] on ${st.path}`).join("\n");
    const out = await ai.structured<{ risky: { step: number; reason: string }[] }>(
      {
        type: "object",
        additionalProperties: false,
        required: ["risky"],
        properties: { risky: { type: "array", items: { type: "object", additionalProperties: false, required: ["step", "reason"], properties: { step: { type: "integer" }, reason: { type: "string" } } } } },
      },
      `These are the recorded steps of a browser task on ${recipe.site} that ends with the page showing "${recipe.endCheck}". List every step that commits the user to something: spending money, placing or confirming an order, sending a message, submitting a form with consequences, deleting data, or changing account settings. Navigation, search, adding to a cart, and typing are not commitments by themselves.\n\n${list}`,
    );
    for (const { step, reason } of out.risky) {
      const st = recipe.steps[step - 1];
      if (st) flag(st, `AI review: ${reason}`.slice(0, 300));
    }
    recipe.riskReview = "ai";
  } else {
    recipe.riskReview = "rules";
  }
  return recipe.steps.flatMap((s, i) => (!before[i] && s.target.sensitiveAction ? [i] : []));
}
