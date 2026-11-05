// Messages app automation over WDA's accessibility tree: no coordinates, and every step
// is verified (recipient, exact text) before Send is pressed, exactly once.
//
// Observed on iOS 26.2 (Messages, iPhone 15 Pro Max):
// * `sms:<to>&body=<text>` opens the conversation with the text in the compose field.
// * Conversation title: Button id "ConversationTitle", label = the number/name.
// * Compose field: TextField id "messageBodyField"; its value is the draft, or the service
//   placeholder ("iMessage", "Text Message", …) when empty. Send: Button id "sendButton".
// * Transcript: Cells in TranscriptCollectionView. Bubble cells are labelled
//   "Your iMessage, <text>, <time>" for our own messages; timestamp and status rows are
//   unlabelled Cells holding a StaticText ("Nov 23, 2021 at 5:18 PM", "Delivered", "Read").

import type { MessageResult, ThreadMessage } from "@agentphone/device-core";

export type UiNode = {
  type?: string;
  label?: string | null;
  value?: unknown;
  rawIdentifier?: string | null;
  rect?: { x: number; y: number; width: number; height: number };
  children?: UiNode[];
};

/** Digits for phone numbers (NANP leading 1 dropped), lowercase for emails, undefined otherwise. */
export function normalizeAddress(s: string | undefined | null): string | undefined {
  const t = (s ?? "").trim();
  // Plain characters only: this ends up inside an sms: URL, where & ? ; , would add parameters.
  if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(t)) return t.toLowerCase();
  if (/^\+?[\d\s().-]{7,}$/.test(t)) {
    let d = t.replace(/\D/g, "");
    if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
    return d;
  }
  return undefined;
}

export function smsUrl(to: string, body?: string): string {
  // Strip formatting from phone numbers only: dots and dashes are part of email addresses.
  const addr = to.includes("@") ? to.trim() : to.trim().replace(/[\s().-]/g, "");
  return body === undefined ? `sms:${addr}` : `sms:${addr}&body=${encodeURIComponent(body)}`;
}

function* walk(n: UiNode, skip?: (n: UiNode) => boolean): Generator<UiNode> {
  if (skip?.(n)) return;
  yield n;
  for (const c of n.children ?? []) yield* walk(c, skip);
}

export function findById(tree: UiNode, id: string): UiNode | undefined {
  for (const n of walk(tree)) if (n.rawIdentifier === id) return n;
  return undefined;
}

/** Is the conversation/compose header addressed to `to`? (title, or a To: token near the top) */
export function recipientShown(tree: UiNode, to: string): { ok: boolean; shown?: string } {
  const want = normalizeAddress(to);
  const title = findById(tree, "ConversationTitle")?.label ?? undefined;
  if (want && normalizeAddress(title) === want) return { ok: true, shown: title };
  // Never the transcript: a message bubble that happens to contain the number must not count.
  for (const n of walk(tree, (x) => x.rawIdentifier === "TranscriptCollectionView")) {
    if ((n.rect?.y ?? 999) > 260) continue;
    for (const s of [n.label, typeof n.value === "string" ? n.value : undefined]) {
      if (s && want && normalizeAddress(s) === want) return { ok: true, shown: s };
    }
  }
  return { ok: false, shown: title };
}

const SERVICES: Array<[RegExp, MessageResult["service"]]> = [
  [/^iMessage$/i, "iMessage"],
  [/^(Text Message|SMS)$/i, "SMS"],
  [/^RCS( Message)?$/i, "RCS"],
];
export function serviceOf(s: string | undefined): MessageResult["service"] {
  for (const [re, svc] of SERVICES) if (s && re.test(s.trim())) return svc;
  return undefined;
}

const TIME_SUFFIX = /,\s*\d{1,2}:\d{2}[\s ]?[AP]M$/i;
const STATUS = /^(Delivered|Read|Sent|Not Delivered|Sent as Text Message|Sent as RCS Message)\b/i;

export type TranscriptItem = ThreadMessage & { service?: MessageResult["service"]; status?: string };

/** Messages in the visible transcript, in order, each with the status line shown under it (if any). */
export function parseTranscript(tree: UiNode): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  for (const n of walk(tree)) {
    if (n.type !== "Cell" && n.type !== "XCUIElementTypeCell") continue; // WDA's JSON source uses short names
    const label = (n.label ?? "").trim();
    if (label) {
      const mine = label.match(/^Your ([^,]+), ([\s\S]*)$/);
      if (mine) {
        out.push({ from: "me", service: serviceOf(mine[1]), text: mine[2].replace(TIME_SUFFIX, "").trim(), label });
      } else {
        const rest = label.includes(", ") ? label.slice(label.indexOf(", ") + 2) : label;
        out.push({ from: "them", text: rest.replace(TIME_SUFFIX, "").trim(), label });
      }
      continue;
    }
    // Unlabelled cell: a timestamp or a status row; statuses belong to the message above.
    for (const c of walk(n)) {
      const s = (c.label ?? "").trim();
      if (s && STATUS.test(s) && out.length) {
        out[out.length - 1].status = s;
        break;
      }
    }
  }
  return out;
}

/** Map what the phone shows under our message to a result. */
export function resultFrom(item: TranscriptItem | undefined): MessageResult {
  if (!item) return { status: "failed", detail: "The message did not appear in the conversation." };
  const s = item.status ?? "";
  const service = /Text Message/i.test(s) ? "SMS" : /RCS/i.test(s) ? "RCS" : item.service;
  if (/^Not Delivered/i.test(s)) return { status: "failed", service, detail: "The phone shows “Not Delivered”." };
  if (/^Read/i.test(s)) return { status: "read", service, detail: s };
  if (/^Delivered/i.test(s)) return { status: "delivered", service, detail: s };
  return { status: "sent", service, detail: s || "Sent; no delivery receipt shown yet." };
}

export { optedOut } from "@agentphone/shared";
