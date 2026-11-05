// Builds runs/<id>/replay.html: every step's screenshot with a marker where the
// agent acted, its rationale, outcome and timing. Self-contained, opens offline.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function writeReplay(dir: string): string {
  const goal = JSON.parse(readFileSync(join(dir, "goal.json"), "utf8"));
  const events = existsSync(join(dir, "events.jsonl"))
    ? readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const result = existsSync(join(dir, "result.json")) ? JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) : undefined;

  const marker = (a: any) => {
    if (a?.type === "tap") return `<div class="dot" style="left:${a.x}px;top:${a.y}px"></div>`;
    if (a?.type === "swipe") {
      const len = Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
      const ang = (Math.atan2(a.y2 - a.y1, a.x2 - a.x1) * 180) / Math.PI;
      return `<div class="dot" style="left:${a.x1}px;top:${a.y1}px"></div><div class="line" style="left:${a.x1}px;top:${a.y1}px;width:${len}px;transform:rotate(${ang}deg)"></div>`;
    }
    return "";
  };

  const cards = events
    .map((e) => {
      const a = e.action ?? {};
      const what = a.type === "type" ? `type "${esc(a.text)}"${a.submit ? " ⏎" : ""}` : a.type === "finish" ? `finish: ${esc(a.status)}` : esc(a.type) + (a.type === "tap" ? ` (${a.x}, ${a.y})` : "");
      return `<div class="card ${esc(e.outcome)}">
  <div class="shot"><img src="screens/${esc(e.screen)}">${marker(a)}</div>
  <div class="meta"><b>${e.step}. ${what}</b>
    <p>${esc(e.reasoning_summary)}</p>
    <p class="small">${esc(e.outcome)}${e.screen_changed === false ? " · screen unchanged" : ""}${e.detail ? ` · ${esc(e.detail)}` : ""}</p>
    ${a.risk && a.risk !== "normal" ? `<p class="risk">${esc(a.risk)}: ${esc(e.approval?.spec?.summary ?? e.approval?.description ?? a.approval?.summary)} → ${e.approval?.allowed ? "approved" : "declined"}</p>` : ""}
    <p class="small">model ${((e.model_ms ?? 0) / 1000).toFixed(1)}s · action ${e.action_ms ?? 0}ms · step ${((e.duration_ms ?? 0) / 1000).toFixed(1)}s</p>
  </div></div>`;
    })
    .join("\n");

  const m = result?.metrics;
  const html = `<!doctype html><meta charset="utf-8"><title>Replay ${esc(goal.runId)}</title>
<style>
body{font:14px -apple-system,system-ui,sans-serif;margin:24px;background:#f5f5f7;color:#111}
h1{font-size:18px}.card{display:flex;gap:16px;background:#fff;border-radius:12px;padding:12px;margin:12px 0;box-shadow:0 1px 3px #0001}
.card.error,.card.invalid{outline:2px solid #e33}.card.denied{outline:2px solid #e90}
.shot{position:relative;flex:none}.shot img{display:block;border-radius:8px}
.dot{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:#f03a;border:2px solid #fff}
.line{position:absolute;height:3px;background:#f03a;transform-origin:0 50%}
.small{color:#666;font-size:12px}.risk{color:#b60;font-weight:600}pre{white-space:pre-wrap}
</style>
<h1>${esc(goal.goal)}</h1>
<p>${esc(goal.deviceName)} (${esc(goal.deviceId)}, ${esc(goal.adapter)}) · model ${esc(goal.model)} · ${esc(goal.startedAt)}</p>
${result ? `<p><b>${esc(result.status)}</b>: ${esc(result.summary)}${result.answer ? `<br>Answer: ${esc(result.answer)}` : ""}</p>
<p class="small">${m.actions} actions · ${m.screenshots} screenshots · ${(m.durationMs / 1000).toFixed(1)}s · ${m.inputTokens + m.cacheReadTokens} in / ${m.outputTokens} out tokens · $${m.costUsd.toFixed(3)} · ${m.humanInterventions} approvals · ${m.deviceErrors} device errors · ${m.unchangedScreens} unchanged screens</p>` : "<p>(no result — run incomplete)</p>"}
${cards}`;
  const out = join(dir, "replay.html");
  writeFileSync(out, html);
  return out;
}
