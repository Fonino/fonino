// Replays a recipe without an AI. Resumable: it pauses (instead of failing or restarting) when a
// risky step needs the owner's approval or a step needs repair, and continues where it stopped.
import type { Risk } from "@agentphone/shared";
import { DeviceError, sleep } from "@agentphone/shared";
import { riskOf } from "./risk.ts";
import { locator, type BrowserSession } from "./session.ts";
import { fill, tplStep, type Params } from "./templating.ts";
import type { Recipe, RecipeChange, Step } from "./types.ts";

export const MAX_REPAIRS_PER_STEP = 3;

export type Advance =
  | { kind: "done"; ok: boolean; ms: number; next?: Recipe }
  | { kind: "needs_approval"; stepIndex: number; step: Step; label: string; risk: Risk; summary: string }
  | { kind: "needs_repair"; stepIndex: number; step: Step; want: string }
  | { kind: "failed"; stepIndex: number; error: DeviceError };

export function describeWant(s: Step, params: Params): string {
  const label = fill(s.target.label || s.target.key, params);
  return `${s.op} ${s.target.tag} "${label}" [${s.target.attr}=${fill(s.target.key, params)}]${s.secret ? ` (the saved ${s.secret})` : ""}${s.text !== undefined ? ` with text "${fill(s.text, params)}"` : ""} on page ${fill(s.path, params)}`;
}

export class ReplayRun {
  readonly recipe: Recipe;
  readonly params: Params;
  readonly session: BrowserSession;
  readonly steps: Step[];
  readonly changes: RecipeChange[] = [];
  private i = 0;
  private repairs = 0;
  private approvedStep = -1;
  private started = false;
  private t0 = 0;
  done?: Extract<Advance, { kind: "done" }>;
  /** Set while waiting for the agent's repair action (MCP flow). */
  pending?: "repair";

  constructor(session: BrowserSession, recipe: Recipe, params: Params) {
    if (recipe.status !== "approved") {
      throw new DeviceError("recipe_not_approved", `Recipe ${recipe.id} v${recipe.version} is "${recipe.status}" and can't run until the owner reviews it.`, "Ask the owner to review it (agentphone recipes review).");
    }
    const missingParams = recipe.params.filter((p) => !Object.hasOwn(params, p));
    if (missingParams.length) throw new DeviceError("missing_params", `Recipe ${recipe.id} needs values for: ${missingParams.join(", ")}.`);
    this.session = session;
    this.recipe = recipe;
    this.params = params;
    this.steps = recipe.steps.map((s) => structuredClone(s));
  }

  /** Same recipe version and same values: a repeated browser_run_recipe call resumes this run. */
  matches(recipe: Recipe, params: Params): boolean {
    return recipe.id === this.recipe.id && recipe.version === this.recipe.version && JSON.stringify(params) === JSON.stringify(this.params);
  }

  get stepIndex() {
    return this.i;
  }

  /**
   * The page address to expect for step i, or null when it depends on the user's values: right
   * after picking an item by its {param} text (a product page /p/sauce-labs-bike-light…).
   */
  private expectedPath(i: number): string | null {
    const prev = this.steps[i - 1];
    if (prev?.op === "click" && locator(prev, this.params).attr === "text" && /\{[a-z]/i.test(prev.target.label) && !/\{[a-z]/i.test(this.steps[i].path)) return null;
    return fill(this.steps[i].path, this.params);
  }

  /** Wait for the step's page and element. Gives up early once the page has finished loading. */
  private async ready(s: Step, timeout = 3000): Promise<boolean> {
    const t0 = Date.now();
    const i = this.steps.indexOf(s);
    const path = i >= 0 ? this.expectedPath(i) : fill(s.path, this.params);
    while (Date.now() - t0 < timeout) {
      if ((path === null || this.session.path() === path) && (await this.session.locate(s, this.params))) return true;
      if (Date.now() - t0 > 800 && (await this.session.loaded())) return false;
      await sleep(15);
    }
    return false;
  }

  /** Run until done, or until the next approval / repair is needed. */
  async advance(): Promise<Advance> {
    if (this.done) return this.done;
    if (!this.started) {
      this.started = true;
      this.t0 = Date.now();
      await this.session.goto(this.recipe.start);
    }
    while (this.i < this.steps.length) {
      const s = this.steps[this.i];
      if (!(await this.ready(s))) {
        if (this.repairs >= MAX_REPAIRS_PER_STEP) {
          return { kind: "failed", stepIndex: this.i, error: new DeviceError("repair_failed", `Step ${this.i + 1} still doesn't match after ${MAX_REPAIRS_PER_STEP} repairs: ${describeWant(s, this.params)}`) };
        }
        return { kind: "needs_repair", stepIndex: this.i, step: s, want: describeWant(s, this.params) };
      }
      if (s.op === "click" && s.target.sensitiveAction && this.approvedStep !== this.i) {
        const label = fill(s.target.label || s.target.key, this.params);
        return { kind: "needs_approval", stepIndex: this.i, step: s, label, risk: riskOf(label), summary: await this.session.summary(label) };
      }
      try {
        await this.session.perform(s, this.params, { recipeOrigin: this.recipe.site });
      } catch (e) {
        return { kind: "failed", stepIndex: this.i, error: e instanceof DeviceError ? e : new DeviceError("step_failed", (e as Error).message) };
      }
      this.i++;
      this.repairs = 0;
    }
    return (this.done = await this.finish());
  }

  /** The owner approved the risky step the run is paused on. */
  approveCurrent() {
    this.approvedStep = this.i;
  }

  /**
   * Turn the agent's repair action into a recipe step: keeps the recorded typed value, refuses a
   * secret of a different kind, and carries the original step's risk over to a replacement.
   */
  prepareFix(fix: Step): Step {
    const s = this.steps[this.i];
    const out = structuredClone(fix);
    if (s.op === "fill_secret" && out.op === "fill_secret" && out.secret !== s.secret) {
      throw new DeviceError("repair_rejected", `This step needs the saved ${s.secret}, not the ${out.secret}.`, `Pick the field for the ${s.secret}.`);
    }
    const samePage = out.path === fill(s.path, this.params);
    if ((s.op === "type" || s.op === "select") && out.op === s.op) out.text = s.text; // the AI only finds the field
    if (s.target.sensitiveAction && out.op === s.op && samePage && !out.target.sensitiveAction) {
      out.target.sensitiveAction = true;
      out.target.riskReasons = [...(s.target.riskReasons ?? []), "inherited from the risky step it replaces"];
    }
    return out;
  }

  /**
   * Perform a prepared fix (on the element the agent picked) and record it as inserted or replaced.
   * `kind` is the agent's own statement: "replace" = this IS the step on its new element,
   * "extra_step" = something that had to happen first (a cookie banner…). A replacement must be the
   * same kind of action on the same page; otherwise it is recorded as an extra step.
   */
  async applyFix(fix: Step, agentId?: string, kind?: "replace" | "extra_step"): Promise<"inserted" | "replaced"> {
    const s = this.steps[this.i];
    this.repairs++;
    const samePage = fix.path === fill(s.path, this.params);
    const canReplace = fix.op === s.op && samePage;
    await this.session.perform(fix, this.params, { agentId, recipeOrigin: this.recipe.site });
    const step = tplStep(fix, this.params);
    const extra = kind === "extra_step" || !canReplace || (kind === undefined && (await this.ready(s, 1500)));
    if (extra) {
      this.steps.splice(this.i, 0, step);
      this.changes.push({ kind: "inserted", at: this.i + 1, step });
      this.i++; // the inserted step is done; the original step is retried next
      return "inserted";
    }
    this.steps[this.i] = step;
    this.changes.push({ kind: "replaced", at: this.i + 1, from: s, step });
    this.i++; // the replacement already ran
    this.repairs = 0;
    return "replaced";
  }

  private async finish(): Promise<Extract<Advance, { kind: "done" }>> {
    const want = fill(this.recipe.endCheck, this.params);
    let ok = false;
    const t0 = Date.now();
    while (!ok && Date.now() - t0 < 3000) {
      ok = (await this.session.bodyText()).includes(want);
      if (!ok) await sleep(15);
    }
    const ms = Date.now() - this.t0;
    if (!this.changes.length) return { kind: "done", ok, ms };
    const touches = (st?: Step) => !!st && (st.op === "fill_secret" || !!st.target.secret || st.target.sensitiveAction);
    const sensitive = this.changes.some((c) => touches(c.step) || touches(c.from));
    const next: Recipe = {
      ...this.recipe,
      steps: this.steps,
      changes: this.changes,
      source: "repaired",
      createdAt: new Date().toISOString(),
      reviewedBy: undefined,
      status: !ok ? "broken" : sensitive ? "needs_review" : "approved",
    };
    return { kind: "done", ok, ms, next };
  }
}
