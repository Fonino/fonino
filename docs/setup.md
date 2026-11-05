# Setup

## 1. Mac

* macOS 15+ on Apple silicon (tested: macOS 27.0), Xcode Command Line Tools (`xcode-select --install`),
  Node ≥ 22.18 (runs the TypeScript directly, no build step).

```bash
npm install
npm run build:native          # builds native/agentphone-macos (Swift)
npm link                      # optional: puts `agentphone` on your PATH (else apps/cli/bin/agentphone)
cp .env.example .env          # add ANTHROPIC_API_KEY (+ ANTHROPIC_WORKSPACE_ID if your key isn't workspace-scoped)
```

Grant the app you run `agentphone` from (Terminal, iTerm, your IDE…) **both** permissions in
System Settings → Privacy & Security, then restart that app:

* **Screen Recording** — to capture the phone screen
* **Accessibility** — to send taps/keys and press iPhone Mirroring's menu items

## 2a. Phone via iPhone Mirroring (no cable, no Xcode)

1. iPhone on iOS 18+, same Apple Account as the Mac, Bluetooth + Wi‑Fi on, near the Mac.
2. Open **iPhone Mirroring** once and complete its setup.
3. **Lock the iPhone** — mirroring only runs while the phone is locked.
4. `agentphone doctor --input` (this presses Home and opens Spotlight on the phone).

Caveats (see research doc): one phone per Mac; input moves your real cursor, so don't use the Mac
during runs; if the phone rings or is picked up, mirroring stops until it's locked again; apps
locked with Face ID ask for your Mac password, which AgentPhone will not enter.

## 2b. Phones via USB + WebDriverAgent (multi‑phone; needs Xcode) — recommended

Signing: a free Apple ID ("Personal Team") works for testing but allows **3 devices** and its
signing **expires after 7 days** (rerun step 4). A paid Apple Developer account ($99/yr) allows
100 iPhones per membership year and 1‑year certificates, and can be shared by several Macs.

1. Install Xcode, open it once (install iOS components), accept the license, then
   `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` and sign in under
   Xcode → Settings → Accounts.
2. Per phone, **unlocked**: plug in a data cable → **Allow** on the Mac's "Allow accessory to
   connect?" → **Trust This Computer** on the phone (if it never completes, open the phone in
   Finder and click Trust there) → Settings → Privacy & Security → **Developer Mode** → On →
   restart → confirm **Turn On** (the toggle may only appear after Xcode has seen the phone).
3. **Settings → Display & Brightness → Auto‑Lock → Never.** Required: a locked phone refuses
   every UI action, and WDA can't even start on it (it hangs without an error). Also don't
   Face‑ID‑lock apps the agent must use — AgentPhone won't authenticate.
4. `AGENTPHONE_TEAM_ID=XXXXXXXXXX scripts/wda.sh setup <udid> [<udid>…]` — passing UDIDs
   registers the phones with your team (a free team can't sign anything until one is registered).
   The Team ID is the `OU=` of your "Apple Development" certificate:
   `security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject`.
5. `agentphone wda up` — starts WebDriverAgent on every trusted phone and keeps it running
   (health checks every 5 s, restarts with backoff, logs in `~/.agentphone/wda/<udid>.log`).
   The first launch on each phone reports `needs_human: trust the developer certificate`: on the
   phone, Settings → General → VPN & Device Management → trust it; the supervisor retries by itself.
   (`scripts/wda.sh start <udid>` runs one phone in the foreground without supervision.)
6. `agentphone devices` should list each phone as `connected` with its model and iOS version.
   `unavailable … phone is locked` means step 3 was skipped.
7. Optional checks: `node experiments/multi-device.ts iphone-002 iphone-003` (independence +
   concurrency) and `node experiments/scale.ts 30` (latency, errors, host CPU/RAM per phone).

## 3. Use

```bash
agentphone devices
agentphone screen iphone-001 --open
agentphone tap iphone-001 200 500
agentphone agent iphone-001                 # interactive
agentphone agent iphone-001 --goal "Open Settings and tell me the iOS version"
agentphone runs && agentphone replay <run-id> --open
agentphone wda up                           # USB phones: keep WebDriverAgent running
npm test                                    # unit tests (approval grants, abort on closed prompt)
```

Approvals: risky actions (sending, purchases, credentials, deleting) pause for `Allow? [y/N]`.
A "yes" also covers up to 2 retries of the *same* intent (same quoted text and numbers) within
5 steps, shown as "✓ covered by your approval"; if stdin is closed the run stops as `aborted`.

MCP: the repo's `.mcp.json` registers the server for Claude Code; elsewhere run
`node packages/mcp-server/src/main.ts` (stdio).

Web UI: `agentphone serve` then `cd apps/web && npm install && npm run dev` → http://localhost:3000.

Useful env: `AGENTPHONE_MODEL` (default `claude-opus-5-5`), `AGENTPHONE_EFFORT`,
`AGENTPHONE_MOCK=1` (two fake phones), `AGENTPHONE_ADAPTERS=mirroring,wda`,
`AGENTPHONE_RESTORE_FOCUS=0`, `AGENTPHONE_MIRROR_NAME`, `AGENTPHONE_WDA_URLS=<udid>=http://ip:8100`.
