// Checks for recipes that come from somewhere else (an import now, the shared library later).
// A recipe is data written by someone we don't trust: its own risk labels and description are
// ignored; it is checked against the format, against the USER's request, and for risk again.
import type { BrowserAi } from "./ai.ts";
import { classifyRisk } from "./risk.ts";
import { OPS, SECRET_KINDS, type Recipe } from "./types.ts";

const STEP_FIELDS = new Set(["op", "path", "target", "text", "secret"]);
const TARGET_FIELDS = new Set(["tag", "attr", "key", "label", "secret", "sensitiveAction", "riskReasons"]);

/** Structural problems (no AI): unknown ops, outside addresses, unexpected fields. */
export function validateFormat(recipe: Recipe): string[] {
  const problems: string[] = [];
  try {
    if (new URL(recipe.start).origin !== recipe.site) problems.push("the start page is not on the recipe's site");
  } catch {
    problems.push("invalid site or start page");
  }
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) problems.push("no steps");
  (recipe.steps ?? []).forEach((st, i) => {
    const n = `step ${i + 1}`;
    if (!(OPS as readonly string[]).includes(st.op)) problems.push(`${n}: unknown step type "${st.op}"`);
    if (typeof st.path !== "string" || !st.path.startsWith("/") || st.path.startsWith("//")) problems.push(`${n}: path must be on the recipe's own site`);
    const extra = Object.keys(st).filter((k) => !STEP_FIELDS.has(k));
    if (extra.length) problems.push(`${n}: unexpected fields ${extra.join(", ")}`);
    const extraT = Object.keys(st.target ?? {}).filter((k) => !TARGET_FIELDS.has(k));
    if (!st.target || typeof st.target.key !== "string") problems.push(`${n}: missing target`);
    else if (extraT.length) problems.push(`${n}: unexpected target fields ${extraT.join(", ")}`);
    if (/[a-z][a-z0-9+.-]*:\/\//i.test(JSON.stringify(st))) problems.push(`${n}: contains an outside web address`);
    if (st.op === "fill_secret" && !(SECRET_KINDS as readonly string[]).includes(st.secret ?? "")) problems.push(`${n}: unknown secret "${st.secret}"`);
    if (st.op !== "fill_secret" && st.secret) problems.push(`${n}: only fill_secret steps may use secrets`);
  });
  return problems;
}

/** AI: which steps are not needed for exactly what the user asked (extra purchases, credentials elsewhere…). */
export async function purposeCheck(recipe: Recipe, userTask: string, ai: BrowserAi): Promise<{ step: number; reason: string }[]> {
  const list = recipe.steps
    .map((st, i) => `${i + 1}. ${st.op} ${st.target.tag} "${st.target.label || st.target.key}" [${st.target.attr}=${st.target.key}]${st.secret ? ` (fills the saved ${st.secret})` : ""}${st.text !== undefined ? ` text="${st.text}"` : ""} on ${st.path}`)
    .join("\n");
  const out = await ai.structured<{ unneeded: { step: number; reason: string }[] }>(
    {
      type: "object",
      additionalProperties: false,
      required: ["unneeded"],
      properties: { unneeded: { type: "array", items: { type: "object", additionalProperties: false, required: ["step", "reason"], properties: { step: { type: "integer" }, reason: { type: "string" } } } } },
    },
    `A user asked their browser agent to: ${userTask}.\nA saved recipe from someone else will perform the steps below on ${recipe.site}. Placeholders like {product} are filled with the user's own values. List every step that is NOT needed for exactly what the user asked, or that does something they did not ask for: extra purchases or cart items, changed amounts or values, putting saved credentials anywhere other than the login form, visiting other sites, sending data elsewhere, or changing settings. Normal navigation needed to do the task is fine.\n\n${list}`,
  );
  return out.unneeded;
}

export interface ImportResult {
  recipe: Recipe;
  problems: string[];
  unneeded: { step: number; reason: string }[];
  riskAdded: number[];
}

/**
 * Check a foreign recipe. The result is never "approved": an imported recipe always waits for the
 * owner's review; "rejected" if its format is wrong.
 */
export async function importCheck(input: Recipe, userTask: string, ai: BrowserAi | null): Promise<ImportResult> {
  const recipe: Recipe = structuredClone(input);
  // Stored risk labels are not trusted: start clean, re-derive everything.
  for (const st of recipe.steps ?? []) {
    if (st?.target) {
      st.target.sensitiveAction = false;
      delete st.target.riskReasons;
    }
  }
  recipe.source = "imported";
  recipe.reviewedBy = undefined;
  delete recipe.changes;
  const problems = validateFormat(recipe);
  if (problems.length) return { recipe: { ...recipe, status: "rejected" }, problems, unneeded: [], riskAdded: [] };
  const unneeded = ai ? await purposeCheck(recipe, userTask, ai) : [];
  const riskAdded = await classifyRisk(recipe, ai);
  return { recipe: { ...recipe, status: "needs_review" }, problems, unneeded, riskAdded };
}
