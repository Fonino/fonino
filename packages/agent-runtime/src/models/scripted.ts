// A deterministic AgentModel that replays a fixed list of actions. Used to test the
// loop, approval gate and recorder without an API key, and to drive
// device-control experiments (e.g. the 20+ action reliability test).

import type { AgentAction, AgentContext, AgentDecision, AgentModel } from "../types.ts";

export class ScriptedModel implements AgentModel {
  readonly name = "scripted";
  private i = 0;
  private readonly actions: AgentAction[];
  constructor(actions: AgentAction[]) {
    this.actions = actions;
  }
  async nextAction(_ctx: AgentContext): Promise<AgentDecision> {
    const action = this.actions[this.i++] ?? {
      type: "finish", status: "success", summary: "script complete", rationale: "end of script", risk: "normal",
    };
    return { action };
  }
}
