import assert from "node:assert/strict";
import { test } from "node:test";
import { smsUrl } from "../packages/iphone-adapter/src/messages.ts";

test("Messages links keep email addresses intact and clean up phone numbers", () => {
  assert.equal(smsUrl("hello@fonino.app"), "sms:hello@fonino.app");
  assert.equal(smsUrl("first.last-name@example.co.uk"), "sms:first.last-name@example.co.uk");
  assert.equal(smsUrl("+1 (628) 555-0142"), "sms:+16285550142");
  assert.equal(smsUrl("+1.628.555.0142", "Hi"), "sms:+16285550142&body=Hi");
});
