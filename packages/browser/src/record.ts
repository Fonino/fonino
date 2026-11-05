// Turn what the agent just did (the session's trace) into a recipe. The agent's own tool calls are
// the recording: no extra AI is needed to create a recipe.
import { DeviceError } from "@agentphone/shared";
import type { BrowserAi } from "./ai.ts";
import { recipeId, TASK_RE } from "./recipes.ts";
import { classifyRisk } from "./risk.ts";
import type { BrowserSession } from "./session.ts";
import { placeholders, tpl, tplStep, type Params } from "./templating.ts";
import type { Recipe } from "./types.ts";

export interface SaveRequest {
  task: string;
  /** The user's values used in this run, by name: they become {name} placeholders. */
  params: Params;
  /** Text the final page shows when the task succeeded (e.g. "Thank you for your order"). */
  endCheck: string;
  /** Steps the calling agent says commit the user (1-based, with a reason). Can only add risk. */
  riskySteps?: { step: number; reason: string }[];
}

export async function recipeFromTrace(session: BrowserSession, req: SaveRequest, ai: BrowserAi | null): Promise<Recipe> {
  if (!TASK_RE.test(req.task)) throw new DeviceError("bad_task_name", `Task names are lowercase words joined by dashes, e.g. "buy-product" (got "${req.task}").`);
  if (!session.startUrl || session.trace.length === 0) throw new DeviceError("nothing_recorded", "Nothing to save: open a page with browser_open and do the task first.");
  if (session.traceLeftSite) throw new DeviceError("recording_left_site", "This recording left the site it started on, so it can't become a recipe.", "Start again with browser_open on the site and stay on it.");
  const site = new URL(session.startUrl).origin;
  if (session.origin() !== site) throw new DeviceError("recording_left_site", `The page is now on ${session.origin()}, not ${site}.`);
  for (const [k, v] of Object.entries(req.params)) {
    if (!/^[a-z][a-z0-9_]{0,30}$/i.test(k)) throw new DeviceError("bad_param", `Parameter names are letters, digits and _ (got "${k}").`);
    if (v.length < 2) throw new DeviceError("bad_param", `The value of "${k}" is too short to template safely (2+ characters).`);
  }
  const body = await session.bodyText();
  if (!req.endCheck.trim() || !body.includes(req.endCheck)) {
    throw new DeviceError("end_check_not_on_page", `The current page doesn't show "${req.endCheck}".`, "Save the recipe on the page that confirms the task is done, and pass text visible there.");
  }
  const steps = session.trace.map((s) => tplStep(s, req.params));
  const endCheck = tpl(req.endCheck, req.params);
  const used = placeholders(steps, [endCheck]);
  const unused = Object.keys(req.params).filter((k) => !used.includes(k));
  if (unused.length) throw new DeviceError("unused_param", `These values don't appear in any step: ${unused.join(", ")}.`, "Pass only values you actually typed or clicked.");
  const recipe: Recipe = {
    id: recipeId(site, req.task),
    site,
    start: tpl(session.startUrl, req.params),
    task: req.task,
    version: 0,
    status: "approved",
    endCheck,
    params: used,
    steps,
    source: "recorded",
    riskReview: "rules",
    createdAt: new Date().toISOString(),
  };
  // A recorded recipe runs right away: its risky steps still need the owner's approval on every run.
  // Free rules always apply; the calling agent's own review adds to them (it can't remove a flag).
  await classifyRisk(recipe, ai);
  for (const { step, reason } of req.riskySteps ?? []) {
    const st = recipe.steps[step - 1];
    if (!st) continue;
    st.target.sensitiveAction = true;
    st.target.riskReasons = [...new Set([...(st.target.riskReasons ?? []), `agent review: ${reason}`.slice(0, 300)])];
  }
  if (req.riskySteps?.length) recipe.riskReview = "agent";
  return recipe;
}
