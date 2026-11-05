# Controlling a physical, non-jailbroken iPhone from macOS

Research + spike results, 2026-09-26. **T** = tested on real hardware in this repo;
**D** = documented / widely known but *not yet tested here*; **?** = open question.

Test rig: Apple silicon Mac (18 cores, 36 GB, macOS 27.0), Xcode 27.0.
Phones: iPhone 17 Pro Max (iOS 26.5.2) and iPhone 15 Pro Max (iOS 26.2.1), both on USB;
the 17 Pro Max also via iPhone Mirroring. Free Apple "Personal Team" for signing.

## TL;DR

| | iPhone Mirroring + CGEvents | XCUITest / WebDriverAgent over USB |
|---|---|---|
| Status | **built, works** (single phone) | **built, works — recommended** |
| Needs | macOS 15+, Apple silicon/T2, same Apple Account, phone nearby & **locked** | Xcode, signing team, Developer Mode, USB (Wi‑Fi possible), phone **unlocked** |
| Screenshot | T ✅ ScreenCaptureKit window capture, ~0.18 s | T ✅ `/screenshot`, ~0.4 s |
| Tap | T ✅ HID mouse click | T ✅ W3C pointer actions |
| Swipe horizontal | T ✅ mouse drag | T ✅ |
| Swipe/scroll vertical | T ✅ **scroll‑wheel events** (vertical mouse drags are ignored) | T ✅ real finger drag |
| Type text | T ✅ unicode key events (Mac keyboard, no on‑screen keyboard) | T ✅ `/wda/keys` (on‑screen keyboard appears) |
| Home / App Switcher / Spotlight | T ✅ View‑menu items via Accessibility (⌘1/2/3 fallback) | T ✅ `/wda/homescreen`; Spotlight by swipe; app switcher: D |
| System & third‑party apps | T ✅ Settings, Safari, Calendar, Clock, Calculator, Chrome | T ✅ Settings, Calculator, Weather, Messages, Spotlight |
| Multiple phones per Mac | T ❌ **one mirrored iPhone per Mac** | T ✅ 2 phones, independent, **2.03× parallel speedup** |
| Uses the Mac's cursor/keyboard | T ❌ **yes** – can't share the Mac with a human | T ✅ no |
| Phone auto‑locks | n/a (must be locked) | T ❌ WDA `/status` still OK but **every UI action is refused**; a (re)start of WDA **hangs silently** → Auto‑Lock must be Never |
| Phone rings / is picked up | T ❌ session drops to "iPhone in Use"; only a human can restore | D (WDA keeps running) |
| App with Face ID app‑lock (Messages) | T ⛔ asks for **Mac** Touch ID/password | T ⛔ "Try Face ID Again" on the phone |
| Host cost per phone | n/a | T ~155–160 MB RAM (xcodebuild host), ~5% of one core while driven, ~0% idle |

**Recommendation:** make WDA the primary adapter — independent, concurrent, headless (no host
cursor), and cheap on the host. Keep Mirroring as the zero‑setup path for one phone (no Xcode, no
Developer Mode, no cable). Both sit behind the same `PhoneDevice` interface, so agent/CLI/MCP
don't change — the same agent loop ran unchanged on both.

**AgentPhone never authenticates on the owner's behalf** (Face ID / passcode / Mac password
prompts are surfaced as `blocked`). This is enforced both by the agent prompt and, in this
development setup, by Claude Code's safety classifier, which refused to type a password into an
unlock prompt even with the owner's permission. Dedicated agent phones shouldn't app‑lock the
apps the agent needs.

## Answers to the 15 questions

1. **Identify connected iPhones.** T: `usbmuxd` (`/var/run/usbmuxd`) lists USB and Wi‑Fi‑paired
   devices with UDIDs; implemented natively in Node (`packages/iphone-adapter/src/usbmux.ts`, no
   libimobiledevice). Unpaired `lockdownd` `GetValue` also returns DeviceName, ProductType and
   ProductVersion (used to show "iPhone 15 Pro Max, iOS 26.2.1"); `ReadPairRecord` tells whether the
   phone trusts this Mac. `xcrun devicectl list devices` also works with full Xcode. The Mirroring
   path identifies "the" phone via its window (CGWindowList) — no UDID.
2. **Capture the screen.** T: Mirroring — ScreenCaptureKit on the window, ~0.18 s, works while
   other windows overlap it; rendered at 1 px per window point (387×844). T: WDA — `/screenshot`
   (device pixels), downscaled with `sips` to points (430×932 / 440×956), ~0.4 s. Both return
   screenshots where a pixel == a tap coordinate, plus a 48×104 grayscale signature for change detection.
3. **Taps.** T: Mirroring — `CGEvent` mouse events to `cghidEventTap`. **Negative result:**
   `CGEvent.postToPid(iPhone Mirroring)` is ignored, background or frontmost, so input must use the
   HID stream (moves the real cursor, needs the window key). T: WDA — W3C pointer actions.
4. **Swipes.** T: Mirroring — horizontal mouse drags work; **vertical mouse drags are ignored**;
   vertical scrolling only via scroll‑wheel (pixel) events (`swipe --method auto` picks). Picker
   wheels respond poorly to scroll events (3 of 6 attempts had no effect) — open issue.
   T: WDA — real finger drags in all directions (pull‑down Spotlight worked directly).
   D: edge gestures (Control Center, Notification Center).
5. **Typing.** T: Mirroring — unicode key events; no on‑screen keyboard, text goes into the
   focused field. T: WDA — `/wda/keys`; the on‑screen keyboard appears and **moves UI** (in Test 4
   an approved tap on Send only raised the keyboard, and Send moved — see approvals below).
6. **Home / app switching.** T: Mirroring View menu (*Home Screen, App Switcher, Spotlight,
   Control Center*) via Accessibility; its Home also jumps back to Home Screen page 1. T: WDA
   `/wda/homescreen` leaves apps, but **when SpringBoard is already in front, XCUITest's Home
   (`/wda/homescreen`, `pressButton home`, synthesized bottom‑edge swipe) is a no‑op** — it does
   not return to page 1 (iOS 26.2.1); swipe right instead. Note: Home from an app launched via
   Spotlight returns to **Spotlight**; a second Home dismisses it.
7. **Outside an app we control?** T: yes, both paths — Springboard, system and third‑party apps.
8. **Arbitrary App Store / system apps?** T: Settings, Safari, Calendar, Clock, Calculator, Weather,
   Messages (system) and Chrome (third‑party). D: DRM video shows black.
9. **What needs Developer Mode?** T: WDA — per phone, Settings → Privacy & Security → Developer
   Mode → restart → confirm; the toggle may only appear after Xcode has seen the phone. Mirroring
   needs none.
10. **What needs USB?** T: WDA setup was done over USB (trust, Developer Mode, install). D: afterwards
    Wi‑Fi works (WDA printed `http://<phone-ip>:8100` and answered over Wi‑Fi — T for `/status`).
    Mirroring needs no cable.
11. **What works over Wi‑Fi?** T: Mirroring entirely; WDA's HTTP server answers on the phone's IP
    (`AGENTPHONE_WDA_URLS=<udid>=http://ip:8100`). D: full agent runs over Wi‑Fi WDA.
12. **What breaks while locked?** T: Mirroring *requires* the phone locked; unlocking/using it or
    the phone ringing (a timer fired) drops the session to "iPhone in Use" — only a human at the
    phone restores it. T: WDA *requires* the phone unlocked: when a phone auto‑locked, WDA's
    `/status` still answered but every action failed ("device was not, or could not be, unlocked"),
    and `xcodebuild test-without-building` **hung with no error** when started on a locked phone.
    AgentPhone now checks `/wda/locked` and `devicectl … lockState` and reports "phone is locked".
    T: Face‑ID‑locked apps block both paths (Mac password sheet in Mirroring; "Try Face ID Again"
    over WDA). **Unattended phones need Auto‑Lock → Never and no app locks on the agent's apps.**
13. **Multiple phones addressed independently?** T (WDA): **yes** — each phone by UDID through its
    own usbmuxd tunnel to WDA on port 8100; acting on one left the other's screen 0.0% changed.
    T (Mirroring): **no** — a second instance targeted the same paired phone and timed out.
14. **Concurrent control?** T (WDA): **yes** — 2.03× speedup, identical per‑op latency, 0 errors;
    two agents completed different tasks simultaneously. Mirroring: one phone, input serialized
    through a host‑wide lock (one system cursor).
15. **Apple restrictions.** Mirroring: no API (GUI automation + TCC grants that can't be given
    headlessly), one phone, phone locked & nearby, region‑limited. XCUITest/WDA: developer‑signed
    runner; **free Personal Team: 3 devices max, signing expires after 7 days**; paid program ($99/yr):
    100 iPhones registered per membership year, 1‑year certs; Developer Mode + trust prompts per phone;
    a free team can't get a provisioning profile until a device is registered (build with
    `-destination id=<udid> -allowProvisioningDeviceRegistration`). No jailbreak needed.

## One‑time setup friction per phone (T)

"Allow accessory to connect?" on the Mac → "Trust This Computer" (one phone only completed pairing
via Finder) → Developer Mode + reboot → register with the team → install WDA → "Developer App
Certificate is not trusted" → trust it in Settings → General → VPN & Device Management →
Auto‑Lock Never. About 5 minutes per phone, all needing a human at the phone.

## Scaling to a fleet

Measured (2 phones, `experiments/scale.ts`): per phone ~155–160 MB RAM for the `xcodebuild` host
that keeps WDA alive, ~5% of one core while driven, ~0% idle; latency flat from 1 → 2 phones.

Extrapolated (not measured): this 36 GB Mac ≈ 138 phones by RAM / ≈ 210 by CPU; a 16 GB, 10‑core
Mac mini ≈ 60 / ≈ 115. **Host compute is not the binding constraint.** What we expect to bind first:

* **USB power and topology** — ~2–2.5 A per charging phone; ~10 powered hubs for 100 phones; a bad
  hub drops ~10 phones at once.
* **`xcodebuild`/`testmanagerd` stability** with dozens of concurrent test sessions (lighter launchers
  such as go‑ios / pymobiledevice3 avoid one `xcodebuild` per phone — D).
* **Blast radius** — one Mac reboot or macOS/Xcode update takes every phone on it offline.
* **Signing** — one paid developer account covers 100 iPhones and its certificate can be shared
  across several Macs.
* **Batteries** — phones on charge 24/7: use the 80% charge limit, keep them cool.

Working plan: **~20–30 phones per Mac mini, several Macs on one developer account**, each Mac running
its own local runtime + `agentphone wda up`; revisit with ≥ 3 phones of scale data.

## Keeping WDA alive (`agentphone wda up`, T)

Adopts already‑running WDAs, health‑checks every 5 s (`/status` + `/wda/locked`) through usbmuxd,
relaunches dead ones with exponential backoff, and flags human‑only problems (untrusted
certificate, Developer Mode off, locked phone) as `needs_human` instead of restart‑looping.
Killing a phone's `xcodebuild` host: detected in ~2 s; relaunch healthy in ~5 s on an unlocked phone.

## Hybrid options considered

* Screen via Mirroring + input via WDA: pointless now that WDA has both.
* Screen via QuickTime/`AVCaptureDevice` "iOS screen capture" (USB) + input via WDA: a video stream
  instead of per‑step screenshots. D, worth testing for latency; so is WDA's MJPEG stream.
* Notifications: neither path exposes them structurally; Mirroring forwards them to macOS
  Notification Center (D — readable via Accessibility).

## Measured performance

* Mirroring: screenshot 0.18 s; tap/type/home 0.2–0.5 s incl. window activation and focus
  restore (was 1.5 s before fixing a run‑loop bug). 25‑action loop: every app launch succeeded.
* WDA: screenshot ~0.4 s p50 (0.44 s p95); tap/type ~0.8–1 s incl. CLI start‑up; latency unchanged
  with two phones running concurrently.
* Agent (Claude Opus 5.5): ~2.7–4 s per step, ~$0.007 per step with prompt caching.

## Reproduce

```bash
npm run build:native
agentphone doctor --input                                 # Mirroring: presses Home, opens Spotlight
node experiments/device-reliability.ts iphone-001 5 Clock # Mirroring reliability
agentphone wda up                                         # USB phones: start + supervise WDA
node experiments/multi-device.ts iphone-002 iphone-003    # independence + concurrency
node experiments/scale.ts 30                              # per-phone host cost
```

## Messages automation (T, 2026-09-26)

`phone_send_message` / `phone_read_messages` drive Messages through WDA's accessibility tree, no
coordinates (`packages/iphone-adapter/src/messages.ts`):
`sms:<to>&body=<text>` opens the thread with the draft → the `ConversationTitle` must show the
recipient → `messageBodyField` must hold the exact text → one click on `sendButton` → the new
"Your iMessage, <text>, <time>" cell and its status row ("Delivered", "Read", "Not Delivered",
"Sent as Text Message") give the result. First real send: iPhone 15 → owner's number, iMessage,
Delivered, 8.9 s. Gotchas: WDA's JSON source reports short types (`Cell`, not
`XCUIElementTypeCell`); the transcript loads just after the compose field; a Face ID app-lock on
Messages shows "Try Face ID Again" while `/wda/locked` still says false; each `/source` takes ~2.5 s.
