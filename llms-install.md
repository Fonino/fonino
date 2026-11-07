# Installing Fonino (for AI agents)

Fonino lets you control the user's own iPhone or Android phone from their Mac. Follow these steps in
order. Stop and ask the user whenever a step needs their hands on the phone or the Mac, and never
type their passcode, Apple ID password or any other password for them.

## Requirements

- An Apple-silicon Mac on macOS 15 or later, with Node 22.18 or later (`node -v`).
- The user's phone: an iPhone (USB cable or iPhone Mirroring) or an Android phone (USB debugging).

## 1. Install

```bash
npm install -g fonino
fonino doctor
```

`fonino doctor` checks the Mac, the phone and the permissions, and says what to fix next.

## 2. Connect the phone

Pick the user's case and follow that section of [docs/setup.md](docs/setup.md):

- **Android** (simplest): section 2c. The user turns on USB debugging, plugs the phone in and taps
  Allow on the phone. Needs `adb` (Android platform-tools).
- **iPhone, no cable**: section 2a, iPhone Mirroring (macOS 15+, iOS 18+, not in the EU).
- **iPhone over USB** (recommended for iPhone): section 2b. Needs Xcode and the user's Apple ID for
  signing; the user must approve prompts on the phone.

Then check that the phone shows as `connected`:

```bash
fonino devices
```

## 3. Add the MCP server

Add this to the MCP settings (for Cline: `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "fonino": {
      "command": "fonino",
      "args": ["mcp"]
    }
  }
}
```

This is the basic stdio server (screen, tap, swipe, type, Home). For the full tool set with
approvals for sending, posting, buying and deleting, run `fonino mcp-http --show-token` and connect to
`http://localhost:3001/mcp` with the header `Authorization: Bearer <token>` instead.

## 4. Test

Call the `phone_list_devices` tool, then take a screenshot with `phone_get_screen`. Tell the user
what is on their screen to confirm it works.
