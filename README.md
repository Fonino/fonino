# Fonino

**Let your AI agent use your real iPhone or Android phone, with your OK before anything is sent.**

Fonino lets Claude Code, Codex, Hermes or any MCP client see your phone's screen, open apps,
tap, swipe and type. Anything that sends, posts, buys or deletes waits for your one-tap
approval first. It runs on your Mac, with your own phone: no jailbreak, no cloud phone, nothing
to install on an Android phone and only a small helper on an iPhone.

<!-- TODO: demo GIF (an agent sends a text, the approval pops up, you tap Approve) -->

```text
  ● agent: text Sam that I'm running late
  │
  ● phone_open_app("Messages") → phone_get_screen → Sam's conversation
  │
  ● phone_send_message(to: Sam, "Running 10 minutes late, sorry!")
  │   ⏸ waiting for your OK: "Send a text to Sam?"   [Approve] [Deny]
  │
  ✓ sent after you approved (Delivered via iMessage)
```

## Get started

Paste this into your coding agent (Claude Code, Codex…) on a Mac:

```text
Clone https://github.com/fonino/fonino, run npm install, then read docs/setup.md and walk me
through connecting my phone. Stop and ask me whenever a step needs my hands, and never type
my passcode or passwords for me.
```

Or by hand:

```bash
git clone https://github.com/fonino/fonino && cd fonino
npm install && npm run build:native
apps/cli/bin/fonino doctor        # checks the Mac, the phone and permissions
apps/cli/bin/fonino devices
```

**Don't want to set it up yourself?** [Fonino for Mac](https://fonino.app) is the signed app
built on this code. It does the iPhone setup for you (no Xcode) and connects your phone to
Grok Bot, Muse, Claude and ChatGPT from anywhere, with approvals on your phone.

## Two ways to connect the iPhone

| | **USB helper** (recommended) | **iPhone Mirroring** |
|---|---|---|
| How | Fonino's helper (WebDriverAgent, Apple's UI test runner) on the phone, over USB | Fonino reads and clicks macOS's iPhone Mirroring window |
| Taps | Exact: reads the screen's structure, not just pixels | From screenshots and text recognition |
| Your Mac | Free to use: nothing moves your mouse | Takes over the cursor while it works |
| Phones | Several per Mac, at the same time | One |
| Needs | Xcode, an Apple ID for signing, Developer Mode, a cable | macOS 15+, iOS 18+, same Apple Account on Mac and iPhone (not in the EU) |

## Android

Turn on USB debugging (Settings → About phone → tap Build number 7 times, then Settings →
System → Developer options → USB debugging), plug the phone in and tap **Allow** on the phone.
Fonino finds it through `adb` ([Android platform-tools](https://developer.android.com/tools/releases/platform-tools));
an Android emulator works too. Nothing is installed on the phone.

```bash
fonino devices
# android-001  Pixel 9  connected  android-adb  Pixel 9, Android 16, USB
```

Same tools and the same safety rules as on iPhone: screenshots in points, taps checked against
the button under them, texts sent through Google Messages and verified before Send, Settings,
Wallet, Play Store and calls off limits. Typing is plain ASCII (texts can hold any characters).

Step-by-step for both iPhone ways and Android: [docs/setup.md](docs/setup.md).

## Use it from your agent (MCP)

**Full toolset, with approvals** (recommended): run the local HTTP server and add it to your client.

```bash
apps/cli/bin/fonino mcp-http --show-token     # http://localhost:3001/mcp
claude mcp add --transport http fonino http://localhost:3001/mcp \
  --header "Authorization: Bearer <token>"
```

Tools include `phone_list_devices`, `phone_acquire` / `phone_release` (one agent per phone),
`phone_get_screen` (screenshot + elements), `phone_tap`, `phone_swipe`, `phone_type`,
`phone_open_app`, `phone_read_messages`, `phone_send_message`, `phone_wait_for_reply`,
`phone_await_approval`, `phone_request_help` (hand the phone to you for logins) and more.

**Basic control only:** `fonino mcp` (stdio; tap, type, swipe, screen). This repo's
`.mcp.json` registers it for Claude Code.

## Safety

The rules are in the code, not in a prompt, so an agent can't talk its way past them:

- **Approvals.** Sending, posting, buying and deleting pause until you approve the exact app,
  recipient and text. Fonino checks the button under every tap too: Send, Post, Reply, Buy Now
  and Place your order always need your OK, even if the agent didn't say what it was doing.
  `fonino approvals` lists pending requests; `fonino approve <id>` (`--for-task` covers
  the rest of the task, `--always` allows that kind of action in that app, with a daily cap).
- **Off limits.** Settings, Wallet, Passwords, Mail, Phone, FaceTime, Find My and the App Store.
- **Your logins stay yours.** The agent hands you the phone for passwords, Face ID and
  verification codes; one-time codes in messages are hidden from it.
- **Texting limits.** Rate limits per phone and recipient; anyone who replies STOP is never texted again.
- **Local and private.** Tokens, approvals and screenshots stay in `~/.fonino`, readable
  only by your macOS user.

## Other commands

```bash
fonino screen <device> --open          # screenshot
fonino tap <device> 200 500            # screenshot pixels
fonino agent <device> --goal "Open Settings and tell me the iOS version"   # built-in agent (Anthropic API key)
fonino wda up                          # keep the USB helper running (health checks, restarts)
fonino service install                 # run it all as login services
fonino runs && fonino replay <run-id> --open
fonino help                            # everything else
```

## How it works

```
apps/cli                 fonino CLI: setup, doctor, watchdog, local services, replay
packages/iphone-adapter  iPhone USB helper (WebDriverAgent over usbmuxd), iPhone Mirroring, Android over adb
packages/mcp-server      MCP tools, approvals, policy (off-limits apps, risky buttons), rate limits
packages/agent-runtime   built-in agent loop and approval gate
packages/device-core     device protocol, leases, mock phone for tests
packages/browser         optional agent browser on the Mac (pages as text, replayable recipes)
packages/relay           client that connects this Mac to the Fonino cloud (optional)
native/                  Swift helpers: screen capture and input for Mirroring, text recognition
docs/                    setup, research notes on controlling a non-jailbroken iPhone
```

Background on why the USB helper and what we measured:
[docs/iphone-control-research.md](docs/iphone-control-research.md).

Requirements: an Apple-silicon Mac on macOS 15 or later, Node 22.18 or later.
Tests: `npm test`.

## Limits

- The phone has to stay unlocked (iPhone: Auto-Lock Never; Android: the longest screen timeout).
- The first start of the helper may show a passcode prompt titled "XCTest": that's the helper
  asking to use the screen. Enter it on the phone; it asks again only after a restart.
- No multi-touch, camera or Face ID flows. Some apps add their own checks.

## License

MIT. See [LICENSE](LICENSE).
