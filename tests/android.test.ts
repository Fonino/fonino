import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  AndroidAdapter,
  inputTextArg,
  labelsAt,
  parseBubbles,
  parseDevices,
  parseForeground,
  parseSmsRows,
  parseUiDump,
  type AdbRun,
} from "../packages/iphone-adapter/src/android.ts";
import { appDenied, isBrowser } from "../packages/mcp-server/src/policy.ts";

const node = (attrs: string, children = "") => `<node ${attrs}${children ? `>${children}</node>` : " />"}`;

test("adb devices -l: states and models", () => {
  const d = parseDevices(
    "List of devices attached\nemulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n" +
      "R5CT1234ABC unauthorized usb:1-1 transport_id:2\n192.168.1.20:5555 device product:husky model:Pixel_8_Pro device:husky\n\n",
  );
  assert.deepEqual(d.map((x) => [x.serial, x.state, x.model]), [
    ["emulator-5554", "device", "sdk gphone64 arm64"],
    ["R5CT1234ABC", "unauthorized", undefined],
    ["192.168.1.20:5555", "device", "Pixel 8 Pro"],
  ]);
});

test("foreground app from dumpsys", () => {
  assert.equal(parseForeground("  topResumedActivity=ActivityRecord{115698228 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity t6}"), "com.google.android.apps.nexuslauncher");
  assert.equal(parseForeground("    mResumedActivity: ActivityRecord{2b1 u0 com.android.chrome/com.google.android.apps.chrome.Main t12}"), "com.android.chrome");
  assert.equal(parseForeground(""), undefined);
});

test("input text: spaces become %s and quotes can't break out of the shell word", () => {
  assert.equal(inputTextArg("hi there"), "'hi%sthere'");
  assert.equal(inputTextArg("it's; rm -rf /"), "'it'\\''s;%srm%s-rf%s/'");
});

test("ui dump: nesting, escapes, single-quoted values and the label under a point", () => {
  const xml =
    `<?xml version='1.0' ?><hierarchy rotation="0">` +
    node(`text="" resource-id="" clickable="false" bounds="[0,0][1080,2400]"`,
      node(`text='say "hi" &amp; bye' resource-id="com.google.android.apps.messaging:id/compose_message_text" content-desc="" clickable="true" bounds="[190,2190][796,2316]"`) +
      node(`text="" resource-id="com.google.android.apps.messaging:id/Compose:Draft:Send" content-desc="" clickable="true" bounds="[923,2191][1049,2317]"`,
        node(`text="" resource-id="" content-desc="Send SMS" clickable="false" bounds="[954,2212][1017,2275]"`) + node(`text="SMS" resource-id="" content-desc="" clickable="false" bounds="[961,2265][1011,2295]"`)) +
      node(`text="Hello" resource-id="com.google.android.apps.messaging:id/message_text" content-desc="You said  Hello 2:25 PM ." clickable="false" bounds="[678,1738][1017,1801]"`) +
      node(`text="See you &#128522;" resource-id="com.google.android.apps.messaging:id/message_text" content-desc="(628) 555-0142 said  See you 2:26 PM ." clickable="false" bounds="[63,1885][448,1948]"`)) +
    `</hierarchy>`;
  const nodes = parseUiDump(xml);
  assert.equal(nodes.length, 7);
  assert.equal(nodes[1].text, 'say "hi" & bye');
  assert.equal(nodes[1].id, "compose_message_text");
  assert.equal(nodes[2].depth, 1);
  assert.equal(nodes[3].depth, 2);
  assert.deepEqual(labelsAt(nodes, 980, 2250), ["Send SMS", "SMS"]);
  assert.deepEqual(labelsAt(nodes, 10, 10), []);
  assert.deepEqual(parseBubbles(nodes).map((m) => [m.from, m.text]), [["me", "Hello"], ["them", "See you 😊"]]);
});

test("sms rows: bodies with commas and new lines, oldest first", () => {
  const rows = parseSmsRows(
    "Row: 0 address=+16285550142, type=1, date=1762381500000, body=Got it, see you\nsoon\nRow: 1 address=+16285550142, type=2, date=1762381400000, body=Hello, from Fonino\n",
  );
  assert.deepEqual(rows.map((r) => [r.type, r.body]), [[2, "Hello, from Fonino"], [1, "Got it, see you\nsoon"]]);
});

// A fake phone: answers the adb commands the adapter sends, records the rest.
function fakeAdb(opts: { devices?: string; locked?: boolean } = {}) {
  const calls: string[] = [];
  const run: AdbRun = async (serial, args) => {
    const cmd = args.join(" ");
    calls.push(`${serial ?? ""} ${cmd}`);
    if (cmd === "devices -l") return Buffer.from(opts.devices ?? "List of devices attached\nemulator-5554 device product:p model:sdk_gphone64_arm64\n");
    if (cmd.includes("getprop")) return Buffer.from("Pixel 9\n16\n");
    if (cmd.includes("isKeyguardShowing")) return Buffer.from(`    isKeyguardShowing=${!!opts.locked}\n  mWakefulness=Awake\n`);
    if (cmd === "shell wm density") return Buffer.from("Physical density: 420\n");
    if (cmd === "shell wm size") return Buffer.from("Physical size: 1080x2400\n");
    return Buffer.from("");
  };
  return { run, calls };
}

test("adapter lists phones (locked and unauthorized ones as unavailable) and scales taps from dp to pixels", async () => {
  const a = new AndroidAdapter({ run: fakeAdb({ devices: "List of devices attached\nemulator-5554 device model:x\nABC unauthorized usb:1\n" }).run });
  const list = await a.listDevices();
  assert.deepEqual(list.map((d) => [d.id, d.status]), [["emulator-5554", "connected"], ["ABC", "unavailable"]]);
  assert.match(list[0].name, /emulator.*Pixel 9/);
  assert.match(list[1].detail!, /Allow USB debugging/);

  const locked = new AndroidAdapter({ run: fakeAdb({ locked: true }).run });
  assert.equal((await locked.listDevices())[0].status, "unavailable");

  const f = fakeAdb();
  const d = await new AndroidAdapter({ run: f.run }).getDevice("emulator-5554");
  await d.tap(100, 200);
  assert.ok(f.calls.includes("emulator-5554 shell input tap 263 525")); // 420 dpi = 2.625 px per dp
  await assert.rejects(() => d.tap(500, 200), /outside the 411x914 screen/);
  await d.type("hi you");
  assert.ok(f.calls.includes("emulator-5554 shell input text 'hi%syou'"));
  await assert.rejects(() => d.type("café"), /plain ASCII/);
  await d.key("return");
  assert.ok(f.calls.includes("emulator-5554 shell input keyevent KEYCODE_ENTER"));
  await assert.rejects(() => d.openApp!("com.x; reboot"), /not an Android package/);
});

test("no adb installed: no Android phones, no error", { skip: ["/opt/homebrew/bin/adb", "/usr/local/bin/adb"].some((p) => existsSync(p)) }, async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { ANDROID_ADB: "/nonexistent/adb", ANDROID_HOME: "/nonexistent", ANDROID_SDK_ROOT: "/nonexistent", HOME: "/nonexistent", PATH: "/nonexistent" });
    assert.deepEqual(await new AndroidAdapter().listDevices(), []);
  } finally {
    process.env = saved;
  }
});

test("policy: Android system apps are off limits for customer keys, launchers are home, Chrome is a browser", () => {
  const customer = { kind: "key", keyId: "k1" } as unknown as Parameters<typeof appDenied>[0];
  assert.match(appDenied(customer, "com.android.settings")!, /Settings/);
  assert.match(appDenied(customer, "com.google.android.apps.messaging")!, /phone_send_message/);
  assert.match(appDenied(customer, "com.android.vending")!, /Play Store/);
  assert.equal(appDenied(customer, "com.google.android.apps.nexuslauncher"), undefined);
  assert.equal(appDenied(customer, "com.android.chrome"), undefined);
  assert.ok(isBrowser("com.android.chrome"));
});
