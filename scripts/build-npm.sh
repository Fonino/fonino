#!/bin/sh
# Builds dist/npm: the `fonino` npm package. One bundled JavaScript file (Node won't run TypeScript
# from node_modules) plus the macOS helpers, prebuilt for Apple silicon.
#
#   scripts/build-npm.sh [version] && (cd dist/npm && npm publish)
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-0.1.0}"
OUT="$ROOT/dist/npm"
rm -rf "$OUT"
mkdir -p "$OUT/dist/cli/bin" "$OUT/scripts" "$OUT/native/ocr" "$OUT/native/agentphone-macos/.build/release" "$OUT/assets" "$OUT/docs"
cd "$ROOT"

# 1. The CLI (and the MCP server inside it) as one file. It sits three folders deep, like
#    apps/cli/src/main.ts, so the code's paths to the package root (scripts/, native/, assets/)
#    resolve the same from a clone and from npm. npm dependencies stay external.
EXT=""
for d in @anthropic-ai/sdk @modelcontextprotocol/sdk puppeteer-core ws zod; do EXT="$EXT --external:$d --external:$d/*"; done
# shellcheck disable=SC2086
npx -y esbuild@0.25.11 apps/cli/src/main.ts --bundle --platform=node --format=esm --target=node22 \
  --outfile="$OUT/dist/cli/bin/fonino.mjs" --log-level=warning $EXT \
  --banner:js='import { createRequire as __fonino_cr } from "node:module"; const require = __fonino_cr(import.meta.url);'
head -1 "$OUT/dist/cli/bin/fonino.mjs" | grep -q "^#!" || { echo "bundle has no #! line" >&2; exit 1; }
chmod +x "$OUT/dist/cli/bin/fonino.mjs"

# 2. macOS helpers: text recognition and iPhone Mirroring input, prebuilt so users need no Swift.
cp native/ocr/ocr.swift "$OUT/native/ocr/"
swiftc -O -target arm64-apple-macos13 -o "$OUT/native/ocr/fonino-ocr" native/ocr/ocr.swift
(cd native/agentphone-macos && swift build -c release >/dev/null)
cp native/agentphone-macos/.build/release/agentphone-macos "$OUT/native/agentphone-macos/.build/release/"

# 3. Scripts, fonts, docs.
cp scripts/wda.sh scripts/tunnel.sh "$OUT/scripts/"
cp -R assets/fonts "$OUT/assets/fonts"
cp docs/setup.md "$OUT/docs/"
cp README.md LICENSE "$OUT/"

# 4. package.json: the root one's metadata and runtime dependencies.
node -e '
const fs = require("node:fs");
const root = JSON.parse(fs.readFileSync("package.json", "utf8"));
const deps = Object.fromEntries(Object.entries(root.dependencies).filter(([k]) => k !== "nodemailer"));
const pkg = {
  name: "fonino", version: process.argv[1], description: root.description, license: root.license,
  homepage: root.homepage, repository: root.repository, mcpName: "io.github.Fonino/fonino",
  keywords: ["mcp", "mcp-server", "iphone", "android", "adb", "webdriveragent", "ai-agent", "claude-code"],
  type: "module", bin: { fonino: "dist/cli/bin/fonino.mjs" }, engines: root.engines, dependencies: deps,
};
fs.writeFileSync(process.argv[2], JSON.stringify(pkg, null, 2) + "\n");
' "$VERSION" "$OUT/package.json"
echo "dist/npm  fonino@$VERSION  $(du -sh "$OUT" | cut -f1)"
