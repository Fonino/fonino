// Records every agent run to runs/{run-id}/ so failures can be replayed and understood:
//   goal.json  events.jsonl  screens/001.png ...  result.json

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function defaultRunsDir(): string {
  return process.env.AGENTPHONE_RUNS_DIR ?? fileURLToPath(new URL("../../../runs", import.meta.url));
}

export class RunRecorder {
  readonly runId: string;
  readonly dir: string;
  private screenCount = 0;

  constructor(deviceId: string, runsDir = defaultRunsDir()) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    this.runId = `${stamp}_${deviceId}_${Math.random().toString(36).slice(2, 6)}`;
    this.dir = join(runsDir, this.runId);
    mkdirSync(join(this.dir, "screens"), { recursive: true });
  }

  /** Reserve the next screenshot file; returns [relative name, absolute path]. */
  nextScreen(): [string, string] {
    this.screenCount++;
    const name = `${String(this.screenCount).padStart(3, "0")}.png`;
    return [name, join(this.dir, "screens", name)];
  }

  get screenshots(): number {
    return this.screenCount;
  }

  writeGoal(goal: object) {
    writeFileSync(join(this.dir, "goal.json"), JSON.stringify(goal, null, 2));
  }

  event(e: object) {
    appendFileSync(join(this.dir, "events.jsonl"), JSON.stringify({ timestamp: new Date().toISOString(), ...e }) + "\n");
  }

  writeResult(result: object) {
    writeFileSync(join(this.dir, "result.json"), JSON.stringify(result, null, 2));
  }
}
