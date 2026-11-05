// A repaired recipe that touches a login or a risky step waits for the owner's review. The review
// is an ordinary approval request, so the owner answers it where they answer everything else
// (portal, Mac dashboard, `fonino approve`). Decisions are applied to the recipe store lazily.
import type { Recipe, RecipeStore } from "@agentphone/browser";
import { BROWSER_DEVICE_ID } from "@agentphone/browser";
import type { ApprovalQueue, ApprovalRecord } from "./approval-queue.ts";

export const REVIEW_OP = "approve_recipe_version";
const target = (r: Recipe) => `${r.id} v${r.version}`;

/** The diff the owner sees: what changed and why it needs a look. */
export function reviewText(r: Recipe): string {
  const lines = (r.changes ?? []).map((c) => {
    const what = (s: Recipe["steps"][number]) => `${s.op} "${s.target.label || s.target.key}" [${s.target.attr}=${s.target.key}]${s.secret ? ` (saved ${s.secret})` : ""}${s.text !== undefined ? ` text "${s.text}"` : ""}`;
    return c.kind === "replaced" ? `step ${c.at}: ${what(c.from!)}  ->  ${what(c.step)}` : `step ${c.at}: NEW ${what(c.step)}`;
  });
  const risky = r.steps.flatMap((s, i) => (s.target.sensitiveAction ? [`step ${i + 1} "${s.target.label || s.target.key}"`] : []));
  return [`Recipe ${r.id}, version ${r.version} (${r.source})`, ...lines, `Needs approval when run: ${risky.join(", ") || "nothing"}`].join("\n").slice(0, 3000);
}

/** Ask the owner to review this version (once; again after an unanswered request expires). */
export function requestReview(q: ApprovalQueue, r: Recipe, who: { principal: string; holder: string; sessionId: string }): ApprovalRecord {
  const open = q.list().find((a) => a.spec.operation === REVIEW_OP && a.spec.recipient === target(r) && (a.status === "pending" || (a.status === "approved" && !a.used)));
  if (open) return open;
  const touchesSecret = (r.changes ?? []).some((c) => c.step.op === "fill_secret" || c.from?.op === "fill_secret");
  return q.create({
    deviceId: BROWSER_DEVICE_ID,
    leaseId: who.sessionId,
    holder: who.holder,
    principal: who.principal,
    risk: touchesSecret ? "authentication" : "purchase",
    spec: { app: `Browser (${new URL(r.site).host})`, operation: REVIEW_OP, recipient: target(r), payload: reviewText(r), summary: `Review the repaired recipe ${r.id} (v${r.version})` },
  });
}

/** Apply the owner's decisions to the store; re-request reviews whose request expired. */
export function syncReviews(q: ApprovalQueue, store: RecipeStore, who?: { principal: string; holder: string; sessionId: string }): void {
  for (const a of q.list()) {
    if (a.spec.operation !== REVIEW_OP || a.used || (a.status !== "approved" && a.status !== "denied")) continue;
    const m = a.spec.recipient?.match(/^(.+) v(\d+)$/);
    if (m) {
      try {
        const r = store.get(m[1], Number(m[2]));
        if (r.status === "needs_review") store.setStatus(r.id, r.version, a.status === "approved" ? "approved" : "rejected", "owner");
      } catch {
        /* recipe deleted meanwhile */
      }
    }
    q.consume(a.id);
  }
  if (!who) return;
  for (const r of store.list()) if (r.status === "needs_review") requestReview(q, r, who);
}
