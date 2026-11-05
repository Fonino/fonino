# Fonino setup guide

**For the AI assistant reading this:** the user wants their assistant (you, or another one) to be able
to use a real iPhone through Fonino. Walk them through the steps below **one at a time**: say exactly
what to click, type or tap, wait until they say it's done, then continue. Keep it friendly and short.
Setup is one app, **Fonino for Mac**. It does most steps by itself and tells
the user when to tap something on the iPhone. Never ask for or type passwords, passcodes, card numbers or verification codes; the user
enters those themselves.

**If the user asks whether it's safe** (or seems unsure), explain briefly, in your own words:
- Anything that posts, replies, publishes or sends a text under their name **waits for their
  one-tap approval**: you'll show them a link with the exact text and a screenshot of the phone.
  You can't approve anything yourself.
- **Settings, Wallet, Passwords, App Store, Mail, Phone, FaceTime and Find My are blocked** for
  assistants. Texts have sending limits (20 an hour, 100 a day per phone, 5 an hour per person;
  U.S. numbers only; STOP is honored).
- At passcodes, passwords and 2-factor codes **you hand the phone to them** in a private live view.
- With BYOF the phone and its recordings (kept 90 days) **stay on their Mac**, which opens no
  ports; Fonino's cloud only passes traffic through. They can watch live and disconnect anytime.
- Details: https://fonino.app/security

**Before starting, tell the user what the full setup requires:**
- **A Mac with Apple silicon** (M1 or newer, macOS 15+) and **their iPhone** (XS or newer) **plugged
  into it by USB**. The Mac must stay on and awake while the assistant uses the phone.
- **About 10 minutes.**
- Fonino is **US-only** for now.

## First question: always ask this before anything else
Ask: **"Do you have a spare iPhone and a Mac you can plug it into, and are you ready to set it up?"**
- **Yes, spare iPhone + Mac:** continue with Step 1 below (BYOF: Bring Your Own Fonino).
- **No spare iPhone, or no Mac:** BYOF isn't the right fit. Explain the **Hosted phone** instead: we
  provide a dedicated iPhone on Wi-Fi, hosted and kept online for them, and they only sign it in with
  their Apple Account. It has no phone line: apps, Safari and iMessage work (texts come from their
  Apple Account), but no SMS to Android phones and no regular phone calls. It's $149/month billed annually ($1,788/year), no setup fee, and they can
  get it at **https://buy.stripe.com/9B6dRa6WJbiS5Sy0XK5wI03**. We email them from
  hello@fonino.app to finish setup together.
  **Optional, want SMS, calls and a phone number on the hosted phone?** They can add their own eSIM:
  1. Buy an eSIM plan from any US provider that gives an **activation QR code or activation code**
     (for example US Mobile, Mint or Tello). The line is theirs and they pay the provider.
  2. During the hosted setup they open the **live view** from app.fonino.app, take over, and go to
     **Settings → Cellular → Add eSIM → Use QR Code → Enter Details Manually**, then type the
     SM-DP+ address and activation code themselves. The phone is on Wi-Fi, so it activates in a
     minute or two. Fonino never sees the code.
  3. Then their bot can also send SMS from that number (calls: coming later).
  Then stop; the steps below are only for BYOF.
- **Not sure / has an old iPhone:** it needs to be an iPhone XS or newer that they don't need day to
  day (it stays plugged in and unlocked), and a Mac with Apple silicon (M1 or newer).

## Step 1: Start the free trial (this is the sign-up)
*Skip this step if Fonino is already connected to you as a connector (you have a `fonino_setup` tool):
the user started the trial on the Connect page.*
Open **{{BYOF_URL}}**: BYOF, {{BYOF_TERMS}}. The user enters their email and the 6-digit code we
email them. That's the whole sign-up: no card, no password. Their account page opens at app.fonino.app
with the trial countdown. If they already have a Fonino account, they just sign in there.

## Step 2: Connect the assistant (before installing anything)
Connect now, so the assistant can follow the setup live: once connected it has a `fonino_setup` tool
that shows what's done (Mac installed, online, iPhone plugged in, ready) and the next step.
Skip this step if Fonino is already connected to you. Otherwise, at **https://app.fonino.app** →
**Connect your assistant**:
- **Grok Bot:** grok.com/connectors → New Connector → Custom → URL `https://api.fonino.app/mcp` →
  Connect → the user enters their Fonino email and the 6-digit code we email them.
- **Muse:** Settings → Connectors → Add custom connector → URL `https://api.fonino.app/mcp` → Muse opens
  Fonino's sign-in page → the user enters their Fonino email and the 6-digit code we email them. No key needed.
- **Claude:** Claude → Settings → Connectors → Add custom connector → `https://api.fonino.app/mcp` →
  Connect → their Fonino email and the emailed 6-digit code.
- **Hermes Agent:** add this to `~/.hermes/config.yaml`, then run `hermes mcp login fonino`; a browser
  opens and the user signs in with their Fonino email and the emailed 6-digit code. No key needed.
  ```yaml
  mcp_servers:
    fonino:
      url: "https://api.fonino.app/mcp"
      auth: oauth
  ```
  Hermes shows screenshots as files (`MEDIA:` paths); look at them with `vision_analyze`.

If the new connector's tools don't show up in this chat, keep going here with this guide; they'll
be there in a new chat. From now on, after each step, call `fonino_setup` (if you have it) to confirm
it worked before moving on.

## Step 3: Install Fonino for Mac
Download **https://api.fonino.app/download/Fonino.dmg**, open it and drag **Fonino** into **Applications**. Then open Fonino from
Applications. (If you can run commands on their Mac, you can do this for them:
`curl -fsSL -o /tmp/Fonino.dmg https://api.fonino.app/download/Fonino.dmg && hdiutil attach -nobrowse /tmp/Fonino.dmg && cp -R /Volumes/Fonino/Fonino.app /Applications/ && hdiutil detach /Volumes/Fonino && open /Applications/Fonino.app`.)

## Step 4: Follow the Fonino window
Fonino's window ticks each step off by itself. The user only does these, when the window says so:
1. **Connect this Mac:** the browser opens app.fonino.app; they check the code matches and click **Connect this Mac**.
2. **Plug in the iPhone** by USB, unlock it, tap **Trust** and enter the iPhone passcode.
3. **Developer Mode:** on the iPhone, **Settings → Privacy & Security → Developer Mode → On**. It restarts;
   they unlock it and tap **Turn On**. (On an iPhone without a passcode, Fonino may do this itself.)
4. **UI Automation:** on the iPhone, **Settings → Developer → Enable UI Automation**. If the iPhone asks for its
   passcode in a prompt that says **"XCTest"**, that's Fonino's helper asking to use the screen: enter it. iOS asks
   again after each iPhone restart; on a phone used only for Fonino, turning the passcode off avoids that.

Fonino installs its helper on the iPhone, sets **Auto-Lock → Never** and the **80% charge limit** itself (the
user can watch it happen), and shows **You're live** at the end. The iPhone should stay plugged in and the Mac
on and awake. After each step, call `fonino_setup` (if you have it) to confirm.

## Step 5: Try it
Ask the assistant: *"Take a screenshot of my Fonino phone and tell me what's on it."* Then, for
example: *"Open Safari on my phone and check the weather in San Francisco."* Texts to other people
wait for the user's approval at app.fonino.app.

Help: hello@fonino.app · https://fonino.app/support
