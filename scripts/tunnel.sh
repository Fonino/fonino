#!/bin/sh
# HTTPS tunnel to the local AgentPhone MCP service, for cloud agents like Grok Bot.
#
#   scripts/tunnel.sh [port]        (default 3001, where `agentphone mcp-http` listens)
#
# Uses a Cloudflare quick tunnel (no account; supports Streamable HTTP, per
# docs.x.ai/grok/connectors/custom-mcp-tunneling). The URL is random and changes on
# every restart — re-add the MCP server in Grok Bot when it does. The tunnel is NOT
# authentication: the service itself requires the bearer token for every request.
# cloudflared is fetched from Cloudflare's official GitHub releases into vendor/bin.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/vendor/bin/cloudflared"
PORT="${1:-3001}"

if [ ! -x "$BIN" ]; then
  mkdir -p "$ROOT/vendor/bin"
  case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=amd64 ;; esac
  URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$ARCH.tgz"
  echo "Downloading cloudflared ($ARCH) from $URL"
  curl -fsSL "$URL" | tar -xz -C "$ROOT/vendor/bin"
  chmod +x "$BIN"
fi
# Only run a binary signed by Cloudflare's Apple Developer ID (team 68WVV388M8).
if ! codesign --verify --strict -R '=anchor apple generic and certificate leaf[subject.OU] = "68WVV388M8"' "$BIN" 2>/dev/null; then
  echo "cloudflared at $BIN is not signed by Cloudflare; refusing to run it." >&2
  exit 1
fi
"$BIN" --version
echo "Tunnelling https://<random>.trycloudflare.com → http://127.0.0.1:$PORT (the MCP endpoint is <url>/mcp)"
# Record the current public URL for `agentphone service status` and the dashboard.
URLFILE="${AGENTPHONE_HOME:-$HOME/.agentphone}/public-url"
mkdir -p "$(dirname "$URLFILE")"
: > "$URLFILE"
"$BIN" tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" 2>&1 | while IFS= read -r line; do
  echo "$line"
  u=$(printf '%s' "$line" | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' || true)
  [ -n "$u" ] && printf '%s\n' "$u" > "$URLFILE"
done
