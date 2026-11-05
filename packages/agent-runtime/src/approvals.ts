// Approval grants: an owner's "yes" covers an *intent*, not a single tap. If the
// approved action didn't take effect (e.g. the tap raised the keyboard and moved the
// Send button), the agent may retry the SAME intent a limited number of times within
// a few steps without prompting again.
//
// Intents are structured, never prose-matched: device + app + account + operation +
// canonical recipient + exact payload must all match. (Earlier prose matching on
// quoted text and digit runs let `Send "hi" to Marco` cover `Send "hi" to Maria`.)

import type { Risk } from "@agentphone/shared";

export const GRANT_STEPS = 5;
export const GRANT_RETRIES = 2;

/** What exactly is being authorized. Supplied by the model; shown to the owner verbatim. */
export type ApprovalSpec = {
  /** App performing it, e.g. "Messages". */
  app: string;
  /** Sending account / identity if relevant, e.g. "iMessage: me@example.com". */
  account?: string;
  /** e.g. "send_message", "place_call", "purchase", "delete", "submit_credentials". */
  operation: string;
  /** Phone number, email, or exact contact name. */
  recipient?: string;
  /** Exact content: message text, amount, item, what is deleted. */
  payload?: string;
  /** One-line human summary. Display only — never used for matching. */
  summary: string;
};

export type ApprovalGrant = {
  step: number;
  deviceId: string;
  risk: Risk;
  spec: ApprovalSpec;
  key: string;
  expiresStep: number;
  retriesLeft: number;
};

/** Thrown by an ApprovalHandler when nobody can answer (stdin closed, UI gone). Ends the run. */
export class ApprovalUnavailableError extends Error {
  constructor(message = "approval channel closed") {
    super(message);
    this.name = "ApprovalUnavailableError";
  }
}

/** tel:<digits> for phone numbers, mailto:<lowercase> for emails, name:<exact, trimmed> otherwise. */
export function canonicalRecipient(r: string | undefined): string {
  if (!r) return "";
  const s = r.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return `mailto:${s.toLowerCase()}`;
  if (/^\+?[\d\s().-]{7,}$/.test(s)) {
    let d = s.replace(/\D/g, "");
    if (d.length === 11 && d.startsWith("1")) d = d.slice(1); // +1 NANP
    return `tel:${d}`;
  }
  // Names: exact match (case and whitespace-normalized only). "Marco" ≠ "Maria" ≠ "Marco R.".
  return `name:${s.replace(/\s+/g, " ").toLowerCase()}`;
}

export function intentKey(deviceId: string, risk: Risk, spec: ApprovalSpec): string {
  return JSON.stringify([
    deviceId,
    risk,
    spec.app.trim().toLowerCase(),
    (spec.account ?? "").trim().toLowerCase(),
    spec.operation.trim().toLowerCase(),
    canonicalRecipient(spec.recipient),
    spec.payload ?? "", // exact, byte-for-byte
  ]);
}

/** Model-written text shown to the owner: one line, no control characters (no fake extra lines). */
const flat = (s: string) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").slice(0, 300);

/** Human-readable description of a spec for the approval prompt. The structured fields (what is
 * actually matched and enforced) come first; the model's summary is labelled as such. */
export function describeSpec(spec: ApprovalSpec): string {
  const parts = [
    `  operation: ${flat(spec.operation)} in ${flat(spec.app)}${spec.account ? ` (${flat(spec.account)})` : ""}`,
    spec.recipient !== undefined ? `  recipient: ${flat(spec.recipient)}` : "",
    spec.payload !== undefined ? `  payload: ${JSON.stringify(spec.payload)}` : "",
    `  agent's summary: ${flat(spec.summary)}`,
  ];
  return parts.filter(Boolean).join("\n");
}

export function newGrant(step: number, deviceId: string, risk: Risk, spec: ApprovalSpec): ApprovalGrant {
  return {
    step, deviceId, risk, spec,
    key: intentKey(deviceId, risk, spec),
    expiresStep: step + GRANT_STEPS,
    retriesLeft: GRANT_RETRIES,
  };
}

/** A live grant covering exactly this request, if any. */
export function findGrant(grants: ApprovalGrant[], step: number, deviceId: string, risk: Risk, spec: ApprovalSpec): ApprovalGrant | undefined {
  const key = intentKey(deviceId, risk, spec);
  return grants.find((g) => g.key === key && step <= g.expiresStep && g.retriesLeft > 0);
}
