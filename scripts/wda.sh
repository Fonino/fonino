#!/bin/sh
# WebDriverAgent (XCUITest runner) for the iphone-wda adapter.
#
#   scripts/wda.sh setup [udid…]    clone + build WDA for testing (needs Xcode + signing team).
#                                   Pass the phones' UDIDs so Xcode registers them with the team
#                                   (a free/personal team can't sign until a device is registered).
#   scripts/wda.sh start <udid>     run WDA on one phone (foreground; one per phone)
#   scripts/wda.sh devices          list attached phones (Xcode's devicectl)
#
# Env: AGENTPHONE_TEAM_ID  your Apple Developer Team ID (Xcode → Settings → Accounts)
#      AGENTPHONE_BUNDLE   unique bundle id prefix (default com.<you>.agentphone.wda)
#
# Status: written against WDA's documented xcodebuild flow; NOT yet run on this machine
# (no Xcode at time of writing). See docs/iphone-control-research.md.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WDA_DIR="$ROOT/vendor/WebDriverAgent"
DERIVED="${AGENTPHONE_WDA_BUILD:-$ROOT/vendor/wda-build}"
BUNDLE="${AGENTPHONE_BUNDLE:-com.$(id -un | tr -cd 'a-z0-9').agentphone.wda}"

need_xcode() {
  if ! xcodebuild -version >/dev/null 2>&1; then
    echo "Xcode is required: install it from the App Store, then" >&2
    echo "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
    exit 1
  fi
}

case "${1:-}" in
  setup)
    need_xcode
    : "${AGENTPHONE_TEAM_ID:?set AGENTPHONE_TEAM_ID to your Apple Developer Team ID}"
    # The patched copy ships with Fonino (it binds the helper to USB only); never fetch upstream.
    [ -d "$WDA_DIR" ] || { echo "WebDriverAgent source missing at $WDA_DIR" >&2; exit 1; }
    shift
    DESTS=""
    for u in "$@"; do DESTS="$DESTS -destination id=$u"; done
    [ -n "$DESTS" ] || DESTS="-destination generic/platform=iOS"
    # With a paid team's App Store Connect API key, Xcode needs no signed-in account and the profile
    # lasts a year; without one it uses Xcode's account (free Apple IDs: 7 days).
    AUTH=""
    [ -n "${AGENTPHONE_ASC_KEY:-}" ] && AUTH="-authenticationKeyPath $AGENTPHONE_ASC_KEY -authenticationKeyID $AGENTPHONE_ASC_KEY_ID -authenticationKeyIssuerID $AGENTPHONE_ASC_ISSUER"
    # shellcheck disable=SC2086
    xcodebuild build-for-testing \
      -project "$WDA_DIR/WebDriverAgent.xcodeproj" \
      -scheme WebDriverAgentRunner \
      $DESTS \
      -derivedDataPath "$DERIVED" \
      -allowProvisioningUpdates \
      -allowProvisioningDeviceRegistration \
      $AUTH \
      DEVELOPMENT_TEAM="$AGENTPHONE_TEAM_ID" \
      PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE" \
      CODE_SIGN_STYLE=Automatic
    echo "Built. Now: scripts/wda.sh start <udid>   (enable Developer Mode on the phone first)"
    ;;
  start)
    need_xcode
    UDID="${2:?usage: scripts/wda.sh start <udid>}"
    XCTESTRUN="$(ls "$DERIVED"/Build/Products/*.xctestrun 2>/dev/null | head -1)"
    [ -n "$XCTESTRUN" ] || { echo "Run scripts/wda.sh setup first" >&2; exit 1; }
    echo "Starting WDA on $UDID (Ctrl+C to stop). First run: trust the developer on the phone"
    echo "(Settings → General → VPN & Device Management)."
    exec xcodebuild test-without-building -xctestrun "$XCTESTRUN" -destination "id=$UDID"
    ;;
  devices)
    need_xcode
    xcrun devicectl list devices
    ;;
  *)
    sed -n '2,12p' "$0"
    exit 2
    ;;
esac
