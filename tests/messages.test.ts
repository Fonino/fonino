// Messages accessibility-tree parsing, on a synthetic tree shaped like iOS 26.2's.

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAddress, optedOut, parseTranscript, recipientShown, resultFrom, smsUrl, type UiNode } from "../packages/iphone-adapter/src/messages.ts";

const cell = (label: string, inner?: string): UiNode => ({
  type: "Cell", // as WDA's JSON source reports it
  label,
  children: inner ? [{ type: "XCUIElementTypeOther", children: [{ type: "XCUIElementTypeStaticText", label: inner }] }] : [],
});

const tree = (title: string, cells: UiNode[], draft = "iMessage"): UiNode => ({
  type: "XCUIElementTypeApplication",
  children: [
    { type: "XCUIElementTypeNavigationBar", children: [{ type: "XCUIElementTypeButton", rawIdentifier: "ConversationTitle", label: title, rect: { x: 118, y: 113, width: 194, height: 34 } }] },
    { type: "XCUIElementTypeTextField", rawIdentifier: "messageBodyField", label: "Message", value: draft, rect: { x: 83, y: 557, width: 283, height: 41 } },
    { type: "XCUIElementTypeCollectionView", rawIdentifier: "TranscriptCollectionView", children: cells },
  ],
});

test("addresses normalize across formats", () => {
  assert.equal(normalizeAddress("+1 (628) 200-8584"), "6282008584");
  assert.equal(normalizeAddress("628-200-8584"), "6282008584");
  assert.equal(normalizeAddress("+44 20 7946 0958"), "442079460958");
  assert.equal(normalizeAddress("Me@Example.com"), "me@example.com");
  assert.equal(normalizeAddress("Alex"), undefined);
  assert.equal(smsUrl("+1 (628) 555-0100", "a&b c"), "sms:+16285550100&body=a%26b%20c");
});

test("recipient must match the conversation title", () => {
  assert.equal(recipientShown(tree("+1 (628) 555-0100", []), "+16285550100").ok, true);
  assert.equal(recipientShown(tree("+1 (628) 555-0199", []), "+16285550100").ok, false);
  assert.equal(recipientShown(tree("Alex", []), "+16285550100").ok, false);
});

test("transcript: sender, service, text (commas kept, time dropped), status", () => {
  const t = parseTranscript(tree("+1 (628) 555-0100", [
    cell("", "Nov 23, 2021 at 5:18 PM"),
    cell("Alex, Can we move dinner to 8, or later?, 5:19 PM"),
    cell("Your iMessage, Sure, 8 works, 5:20 PM"),
    cell("", "Read"),
    cell("Your Text Message, On my way, 5:30 PM"),
    cell("", "Delivered"),
  ]));
  assert.deepEqual(t.map((m) => [m.from, m.text, m.service, m.status]), [
    ["them", "Can we move dinner to 8, or later?", undefined, undefined],
    ["me", "Sure, 8 works", "iMessage", "Read"],
    ["me", "On my way", "SMS", "Delivered"],
  ]);
});

test("result mapping", () => {
  const me = (status?: string, service: "iMessage" | "SMS" = "iMessage") => ({ from: "me" as const, text: "x", label: "x", service, status });
  assert.equal(resultFrom(me("Delivered")).status, "delivered");
  assert.equal(resultFrom(me("Read 5:20 PM")).status, "read");
  assert.equal(resultFrom(me("Not Delivered")).status, "failed");
  assert.deepEqual(resultFrom(me("Sent as Text Message")), { status: "sent", service: "SMS", detail: "Sent as Text Message" });
  assert.equal(resultFrom(me(undefined)).status, "sent");
  assert.equal(resultFrom(undefined).status, "failed");
});

test("opt-out: STOP blocks until START", () => {
  const m = (from: "me" | "them", text: string) => ({ from, text, label: text });
  assert.equal(optedOut([m("me", "hi"), m("them", "Stop")]), true);
  assert.equal(optedOut([m("them", "STOP"), m("them", "start")]), false);
  assert.equal(optedOut([m("them", "we can stop by later")]), false);
  assert.equal(optedOut([m("me", "Reply STOP to opt out")]), false);
});

test("recipient check ignores message bubbles, and opt-out keywords are broad", () => {
  const t: UiNode = {
    type: "Application",
    children: [
      { type: "Button", rawIdentifier: "ConversationTitle", label: "Alice", rect: { x: 118, y: 113, width: 194, height: 34 } },
      { type: "CollectionView", rawIdentifier: "TranscriptCollectionView", children: [{ type: "Cell", label: "Alice, call me at +1 628 555 1234", rect: { x: 0, y: 150, width: 430, height: 40 } }] },
    ],
  };
  assert.equal(recipientShown(t, "+16285551234").ok, false);
  const m = (text: string) => ({ from: "them" as const, text, label: text });
  for (const x of ["STOP", "Stop please", "please stop", "Unsubscribe", "BAJA", "arrêt"]) assert.equal(optedOut([m(x)]), true, x);
  for (const x of ["don't stop now", "stopped by the store"]) assert.equal(optedOut([m(x)]), false, x);
});
