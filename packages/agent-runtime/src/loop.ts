// The observe → decide → act loop, with an approval gate and full run recording.

import type { PhoneDevice } from "@agentphone/device-core";
import { screenChange, UNCHANGED_THRESHOLD, type ScreenState } from "@agentphone/shared";
import { ApprovalUnavailableError, describeSpec, findGrant, newGrant, type ApprovalGrant, type ApprovalSpec } from "./approvals.ts";
import { RunRecorder } from "./recorder.ts";
import { describeAction } from "./tools.ts";
import type { AgentAction, AgentContext, AgentModel, ApprovalHandler, ModelUsage, StepOutcome, StepRecord } from "./types.ts";

export type RunOptions = {
  device: PhoneDevice;
  model: AgentModel;
  goal: string;
  approve: ApprovalHandler;
  maxSteps?: number;
  /** Pause after each action before the next screenshot (animations). */
  settleMs?: number;
  sessionNotes?: string[];
  runsDir?: string;
  signal?: AbortSignal;
  /** Live progress (CLI activity feed, web UI). */
  onEvent?: (e: AgentEvent) => void;
};

export type AgentEvent =
  | { kind: "start"; runId: string; dir: string }
  | { kind: "screen"; step: number; screen: string; path: string }
  | { kind: "decision"; step: number; action: AgentAction; modelMs: number }
  | { kind: "approval"; step: number; description: string; allowed: boolean; coveredByStep?: number }
  | { kind: "step"; step: number; record: StepRecord; durationMs: number }
  | { kind: "error"; step: number; message: string }
  | { kind: "done"; result: RunResult };

export type RunMetrics = {
  steps: number;
  actions: number;
  screenshots: number;
  durationMs: number;
  modelMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  approvalsRequested: number;
  approvalsDenied: number;
  humanInterventions: number;
  deviceErrors: number;
  invalidModelOutputs: number;
  unchangedScreens: number;
};

export type RunResult = {
  runId: string;
  dir: string;
  goal: string;
  deviceId: string;
  model: string;
  status: "success" | "failed" | "blocked" | "step_limit" | "error" | "aborted";
  summary: string;
  answer?: string;
  metrics: RunMetrics;
};

const MAX_CONSECUTIVE_INVALID = 3;
/** Re-observe before acting if an approval took longer than this. */
export const STALE_AFTER_MS = 5000;
/** Fraction of the screen that must change for the old decision to be considered stale. */
const STALE_DRIFT = 0.02;

export async function executeAction(device: PhoneDevice, a: AgentAction): Promise<void> {
  switch (a.type) {
    case "tap": return device.tap(a.x, a.y);
    case "swipe": return device.swipe(a.x1, a.y1, a.x2, a.y2, a.durationMs);
    case "type":
      await device.type(a.text);
      if (a.submit) await device.key("return");
      return;
    case "key": return device.key(a.key);
    case "home": return device.home();
    case "app_switcher": return device.appSwitcher();
    case "wait": return device.wait(a.ms);
    case "screen":
    case "finish":
      return;
  }
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const { device, model, goal, approve } = opts;
  const maxSteps = opts.maxSteps ?? 40;
  const settleMs = opts.settleMs ?? 900;
  const emit = opts.onEvent ?? (() => {});
  const rec = new RunRecorder(device.id, opts.runsDir);
  const started = Date.now();
  const history: StepRecord[] = [];
  const notes: string[] = [];
  const grants: ApprovalGrant[] = [];
  const m: RunMetrics = {
    steps: 0, actions: 0, screenshots: 0, durationMs: 0, modelMs: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, costUsd: 0, approvalsRequested: 0, approvalsDenied: 0, humanInterventions: 0,
    deviceErrors: 0, invalidModelOutputs: 0, unchangedScreens: 0,
  };

  rec.writeGoal({
    runId: rec.runId, goal, deviceId: device.id, deviceName: device.name, adapter: device.adapter,
    model: model.name, maxSteps, startedAt: new Date(started).toISOString(),
  });
  emit({ kind: "start", runId: rec.runId, dir: rec.dir });

  const finish = (status: RunResult["status"], summary: string, answer?: string): RunResult => {
    m.durationMs = Date.now() - started;
    m.screenshots = rec.screenshots;
    const result: RunResult = { runId: rec.runId, dir: rec.dir, goal, deviceId: device.id, model: model.name, status, summary, answer, metrics: m };
    rec.writeResult(result);
    emit({ kind: "done", result });
    return result;
  };

  const observe = async (step: number): Promise<[ScreenState, string]> => {
    const [name, path] = rec.nextScreen();
    const s = await device.getScreen({ outPath: path, includeBase64: true });
    emit({ kind: "screen", step, screen: name, path });
    return [s, name];
  };

  const addUsage = (u?: ModelUsage) => {
    if (!u) return;
    m.inputTokens += u.inputTokens + u.cacheWriteTokens;
    m.outputTokens += u.outputTokens;
    m.cacheReadTokens += u.cacheReadTokens;
    m.costUsd += u.costUsd ?? 0;
  };

  let screen: ScreenState;
  let screenName: string;
  try {
    [screen, screenName] = await observe(0);
  } catch (e) {
    m.deviceErrors++;
    return finish("error", `Could not capture the screen: ${(e as Error).message}`);
  }

  let consecutiveInvalid = 0;
  for (let step = 1; step <= maxSteps; step++) {
    if (opts.signal?.aborted) return finish("aborted", "Run aborted by the user.");
    m.steps = step;
    const stepStart = Date.now();
    const decisionScreen = screenName; // the screenshot the model is deciding from
    let approval: object | undefined;

    const ctx: AgentContext = {
      goal, deviceId: device.id, deviceName: device.name, step, maxSteps, screen, history, notes,
      approvals: grants
        .filter((g) => step <= g.expiresStep)
        .map((g) => `Step ${g.step}: owner approved ${JSON.stringify(g.spec)} (risk ${g.risk}) — valid through step ${g.expiresStep}, ${g.retriesLeft} retr${g.retriesLeft === 1 ? "y" : "ies"} left.`),
      sessionNotes: opts.sessionNotes ?? [], preauthorized: [],
    };

    let decision;
    const t0 = Date.now();
    try {
      decision = await model.nextAction(ctx);
    } catch (e) {
      // API / network failure: one retry, then give up.
      emit({ kind: "error", step, message: `model error: ${(e as Error).message}` });
      try {
        decision = await model.nextAction(ctx);
      } catch (e2) {
        return finish("error", `Model call failed: ${(e2 as Error).message}`);
      }
    }
    const modelMs = Date.now() - t0;
    m.modelMs += modelMs;
    addUsage(decision.usage);
    const action = decision.action;
    if (action.memory) notes.push(`(step ${step}) ${action.memory}`);
    emit({ kind: "decision", step, action, modelMs });

    const record = (outcome: StepOutcome, extra: Partial<StepRecord> & { approval?: object; resultScreen?: string; actionMs?: number } = {}) => {
      const { approval, resultScreen, actionMs, ...rest } = extra;
      const r: StepRecord = { step, action, outcome, ...rest };
      history.push(r);
      rec.event({
        step,
        screen: decisionScreen,
        reasoning_summary: action.rationale,
        action: { ...action, rationale: undefined },
        outcome,
        detail: r.detail,
        screen_changed: r.screenChanged,
        change_ratio: r.changeRatio,
        result_screen: resultScreen,
        approval,
        model: decision.model,
        usage: decision.usage,
        model_ms: modelMs,
        action_ms: actionMs,
        duration_ms: Date.now() - stepStart,
      });
      emit({ kind: "step", step, record: r, durationMs: Date.now() - stepStart });
    };

    if (decision.error) {
      m.invalidModelOutputs++;
      record("invalid", { detail: decision.error });
      if (++consecutiveInvalid >= MAX_CONSECUTIVE_INVALID) return finish("error", `Model produced ${consecutiveInvalid} unusable responses in a row: ${decision.error}`);
      continue;
    }
    consecutiveInvalid = 0;

    if (action.type === "finish") {
      record("ok");
      return finish(action.status, action.summary, action.answer);
    }

    // --- Approval gate: any action the model marks as consequential needs the owner. ---
    if (action.risk !== "normal") {
      const spec: ApprovalSpec = action.approval ?? {
        app: "unknown", operation: action.type, summary: `${describeAction(action)} — ${action.rationale}`,
      };
      const description = describeSpec(spec);
      const grant = findGrant(grants, step, device.id, action.risk, spec);
      if (grant) {
        // Retry of an already-approved intent (e.g. the first tap didn't take effect).
        grant.retriesLeft--;
        emit({ kind: "approval", step, description, allowed: true, coveredByStep: grant.step });
        approval = { risk: action.risk, spec, description, allowed: true, covered_by_step: grant.step };
      } else {
        m.approvalsRequested++;
        m.humanInterventions++;
        let allowed: boolean;
        const askedAt = Date.now();
        try {
          allowed = await approve({ deviceId: device.id, risk: action.risk, action, description, spec, screenshotPath: screen.screenshotPath });
        } catch (e) {
          if (!(e instanceof ApprovalUnavailableError)) throw e;
          record("denied", { detail: `No one could answer the approval request (${e.message}).`, approval: { risk: action.risk, spec, description, allowed: false } });
          return finish("aborted", `Stopped: approval was needed for ${JSON.stringify(spec.summary)} but the approval channel is closed. Nothing was done.`);
        }
        emit({ kind: "approval", step, description, allowed });
        if (!allowed) {
          m.approvalsDenied++;
          record("denied", { detail: "The owner declined this action. Do not retry it.", approval: { risk: action.risk, spec, description, allowed } });
          continue;
        }
        grants.push(newGrant(step, device.id, action.risk, spec));
        approval = { risk: action.risk, spec, description, allowed };

        // A long wait means the screen may have moved on (notification, timeout, the owner
        // touched the phone). Never fire old coordinates at a changed screen: re-observe,
        // and if it changed, let the model re-decide — the grant still covers the intent.
        if (Date.now() - askedAt > STALE_AFTER_MS) {
          try {
            const [fresh, freshName] = await observe(step);
            const drift = screenChange(screen, fresh);
            if (drift >= STALE_DRIFT) {
              screen = fresh;
              screenName = freshName;
              record("error", {
                detail: `The screen changed (${Math.round(drift * 100)}%) while waiting for approval; the action was NOT executed. Re-check the screen; your approval still covers this exact intent.`,
                approval,
              });
              continue;
            }
          } catch (e) {
            m.deviceErrors++;
            record("error", { detail: `Couldn't re-check the screen after approval: ${(e as Error).message}. Not executed.`, approval });
            continue;
          }
        }
      }
    }

    // --- Act ---
    let outcome: StepOutcome = "ok";
    let detail: string | undefined;
    const ta = Date.now();
    try {
      await executeAction(device, action);
      if (action.type !== "screen") m.actions++;
    } catch (e) {
      m.deviceErrors++;
      outcome = "error";
      detail = `device error: ${(e as Error).message}`;
    }
    const actionMs = Date.now() - ta;
    if (action.type !== "wait" && action.type !== "screen") await device.wait(settleMs);

    // --- Observe the result ---
    const prev = screen;
    try {
      [screen, screenName] = await observe(step);
    } catch (e) {
      m.deviceErrors++;
      record("error", { detail: `screenshot failed: ${(e as Error).message}`, approval, actionMs });
      return finish("error", `Lost the screen: ${(e as Error).message}`);
    }
    const passive = action.type === "screen" || action.type === "wait";
    const changeRatio = passive ? undefined : Number(screenChange(prev, screen).toFixed(4));
    const screenChanged = changeRatio === undefined ? undefined : changeRatio >= UNCHANGED_THRESHOLD;
    if (screenChanged === false) m.unchangedScreens++;
    record(outcome, { detail, screenChanged, changeRatio, approval, resultScreen: screenName, actionMs });
  }
  return finish("step_limit", `Stopped after ${maxSteps} steps without finishing.`);
}
