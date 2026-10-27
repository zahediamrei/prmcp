#!/usr/bin/env bash
# Premiere Connector installer for macOS.
#
# Builds the MCP server, packages the CEP panel as a signed ZXP (self-signed
# certificate, so Premiere loads it without PlayerDebugMode) and registers the
# server with Claude Code and Claude Desktop.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="$ROOT/build"
EXT_ID="com.premiereconnector"
EXT_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/$EXT_ID"
ZXPSIGN_URL="https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD/4.1.3/macOS/ZXPSignCmd"
CERT_PASS="premiere-connector"

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
step() { printf "\n\033[1m%s\033[0m\n" "$1"; }
die()  { printf "  \033[31m✗ %s\033[0m\n" "$1" >&2; exit 1; }

[[ "$(uname)" == "Darwin" ]] || die "This installer is for macOS. On Windows use install.bat."

step "1/6  Checking Node.js"
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || die "Node.js 18+ is required. Install it from https://nodejs.org and run this again."
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 18 )) || die "Node.js 18+ is required (found $("$NODE_BIN" -v))."
ok "node $("$NODE_BIN" -v) at $NODE_BIN"

step "2/6  Building the MCP server"
cd "$ROOT"
[[ -f config.json ]] || { cp config.example.json config.json; ok "created config.json"; }
npm install --no-audit --no-fund --loglevel=error
npm run build --silent
ok "built dist/server.js"

step "3/6  Signing the Premiere panel"
mkdir -p "$BUILD"
ZXPSIGN="$BUILD/ZXPSignCmd"
if [[ ! -x "$ZXPSIGN" ]]; then
  curl -fsSL -o "$ZXPSIGN" "$ZXPSIGN_URL" || die "Could not download ZXPSignCmd from Adobe's GitHub."
  chmod +x "$ZXPSIGN"
  xattr -c "$ZXPSIGN" 2>/dev/null || true
fi
if [[ "$(uname -m)" == "arm64" ]] && ! /usr/bin/pgrep -q oahd; then
  echo "  ZXPSignCmd needs Rosetta 2. Installing it…"
  softwareupdate --install-rosetta --agree-to-license >/dev/null
fi
CERT="$BUILD/selfsigned.p12"
if [[ ! -f "$CERT" ]]; then
  "$ZXPSIGN" -selfSignedCert US CA "Premiere Connector" "Premiere Connector" "$CERT_PASS" "$CERT" >/dev/null
fi
STAGE="$BUILD/stage"
rm -rf "$STAGE" "$BUILD/$EXT_ID.zxp"
mkdir -p "$STAGE"
# -L copies symlink targets: a signed panel must not contain symlinks.
rsync -aL --exclude ".debug" --exclude ".DS_Store" --exclude "__MACOSX" "$ROOT/cep/" "$STAGE/"
"$ZXPSIGN" -sign "$STAGE" "$BUILD/$EXT_ID.zxp" "$CERT" "$CERT_PASS" >/dev/null
"$ZXPSIGN" -verify "$BUILD/$EXT_ID.zxp" >/dev/null || die "Signature verification failed."
ok "signed build/$EXT_ID.zxp"

step "4/6  Installing the panel into Premiere Pro"
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
unzip -q "$BUILD/$EXT_ID.zxp" -d "$EXT_DIR"
"$ZXPSIGN" -verify "$EXT_DIR" >/dev/null || die "Installed panel failed signature verification."
ok "installed to $EXT_DIR"

step "5/6  Registering with Claude"
SERVER="$ROOT/dist/server.js"

if command -v claude >/dev/null 2>&1; then
  claude mcp remove premiere-connector -s user >/dev/null 2>&1 || true
  claude mcp add premiere-connector -s user -- "$NODE_BIN" "$SERVER" >/dev/null
  ok "Claude Code (user scope)"
else
  echo "  - Claude Code CLI not found, skipped"
fi

DESKTOP_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
if [[ -d "$(dirname "$DESKTOP_CFG")" ]]; then
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [file, node, server] = process.argv.slice(1);
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers["premiere-connector"] = { command: node, args: [server] };
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  ' "$DESKTOP_CFG" "$NODE_BIN" "$SERVER"
  ok "Claude Desktop"
else
  echo "  - Claude Desktop not found, skipped"
fi

step "6/6  Installing the skill"
# The skill tells Claude how to work in Premiere with these tools: the order to work in and the rules learned so far.
SKILL_DIR="$HOME/.claude/skills/premiere-connector"
mkdir -p "$SKILL_DIR"
cp "$ROOT/skill/premiere-connector/SKILL.md" "$SKILL_DIR/SKILL.md"
ok "Claude Code skill in $SKILL_DIR"
echo "  - Claude Desktop: add skill/premiere-connector as a skill in Settings > Capabilities if you use it there"

cat <<EOF

Done. Next:
  1. Restart Premiere Pro
  2. Open  Window > Extensions > Premiere Connector  (it says "Connected to Claude" while Claude is running)
  3. Restart Claude Code / Claude Desktop and ask Claude to edit your sequence.

After editing the panel code, run ./install.sh again to re-sign and reinstall it.
EOF
