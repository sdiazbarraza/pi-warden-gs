#!/usr/bin/env bash
# Installs the pi-warden-gs package: copies config files, wires settings and registers the pi package.
set -euo pipefail

command -v jq >/dev/null 2>&1 || { echo "error: jq is required" >&2; exit 1; }

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# gentle-shell picks the agent home: "link" uses ~/.pi/agent, "isolated" (its default)
# ~/.gentle-shell/agent with config in ~/.gentle-shell/gentle-ai. `gentle-shell home`
# prints "<mode> <agent home>". Plain pi keeps ~/.pi/agent and ~/.pi/gentle-ai.
SHELL_BIN="${GENTLE_SHELL_BIN:-gentle-shell}"
SHELL_MODE=""; SHELL_HOME=""
if command -v "$SHELL_BIN" >/dev/null 2>&1; then
  read -r SHELL_MODE SHELL_HOME < <("$SHELL_BIN" home 2>/dev/null) || true
fi
PI_HOME="${PI_CODING_AGENT_DIR:-${SHELL_HOME:-$HOME/.pi/agent}}"
if [ -n "${GENTLE_PI_CONFIG_HOME:-}" ]; then GENTLE_HOME="$GENTLE_PI_CONFIG_HOME"
elif [ "$SHELL_MODE" = isolated ]; then GENTLE_HOME="$HOME/.gentle-shell/gentle-ai"
else GENTLE_HOME="$HOME/.pi/gentle-ai"; fi
CLAUDE_HOME="$HOME/.claude"
STAMP="$(date +%Y%m%d-%H%M%S)"
# Registers the package against the same home: gentle-shell when present, else pi (PI_BIN overrides).
if [ -n "${PI_BIN:-}" ]; then REGISTER=("$PI_BIN" install)
elif [ -n "$SHELL_MODE" ]; then REGISTER=("$SHELL_BIN" install)
else REGISTER=(pi install); fi
# Optional: one model for every bundled agent, e.g. PI_WARDEN_GS_MODEL=minimax/MiniMax-M3.
MODEL_OVERRIDE="${PI_WARDEN_GS_MODEL:-${PI_OVERRIDES_MODEL:-}}"
if [ -n "$MODEL_OVERRIDE" ] && ! [[ "$MODEL_OVERRIDE" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._:-]+$ ]]; then
  echo "error: PI_WARDEN_GS_MODEL must look like provider/model (got: $MODEL_OVERRIDE)" >&2
  exit 1
fi
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Move the legacy copies so the package extensions are not loaded twice.
for name in safety-guard.ts rtk.ts minimax-review-binding.ts; do
  old="$PI_HOME/extensions/$name"
  if [ -e "$old" ]; then
    mkdir -p "$PI_HOME/extensions-backup-$STAMP"
    mv "$old" "$PI_HOME/extensions-backup-$STAMP/$name"
    echo "moved $old -> $PI_HOME/extensions-backup-$STAMP/$name"
  fi
done

place() {
  local src="$1" dst="$2"
  if [ -e "$dst" ]; then
    if cmp -s "$src" "$dst"; then
      echo "unchanged $dst"
      return
    fi
    cp -p "$dst" "$dst.bak-$STAMP"
    cp "$src" "$dst"
    echo "updated $dst (backup: $dst.bak-$STAMP)"
  else
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    echo "copied $dst"
  fi
}

place "$PKG_DIR/pi/APPEND_SYSTEM.md" "$PI_HOME/APPEND_SYSTEM.md"
for agent in "$PKG_DIR"/pi/agents/*.md; do
  src="$agent"
  if [ -n "$MODEL_OVERRIDE" ]; then
    # Rewrite only the first `model:` line (the frontmatter one).
    src="$WORK_DIR/$(basename "$agent")"
    awk -v m="$MODEL_OVERRIDE" '!done && /^model:/ { print "model: " m; done = 1; next } { print }' "$agent" > "$src"
  fi
  place "$src" "$PI_HOME/agents/$(basename "$agent")"
done
if [ -n "$MODEL_OVERRIDE" ]; then echo "agents use model $MODEL_OVERRIDE"; fi
place "$PKG_DIR/hooks/brief-guard.sh" "$CLAUDE_HOME/hooks/brief-guard.sh"
chmod 755 "$CLAUDE_HOME/hooks/brief-guard.sh"
place "$PKG_DIR/bin/pi-perfil" "$HOME/bin/pi-perfil"
chmod 755 "$HOME/bin/pi-perfil"
for profile in "$PKG_DIR"/pi/profiles/*.json; do
  place "$profile" "$GENTLE_HOME/profiles/$(basename "$profile")"
done

# Rewrites a JSON settings file with a jq filter, only when the result differs.
update_json() {
  local file="$1" filter="$2" tmp
  mkdir -p "$(dirname "$file")"
  [ -e "$file" ] || echo '{}' > "$file"
  tmp="$(mktemp "$file.XXXXXX")"
  jq "$filter" "$file" > "$tmp"
  if [ "$(jq -S . "$file")" = "$(jq -S . "$tmp")" ] && cmp -s <(jq -c . "$file") <(jq -c . "$tmp"); then
    rm -f "$tmp"
    echo "unchanged $file"
  else
    cp -p "$file" "$file.bak-$STAMP"
    mv "$tmp" "$file"
    echo "updated $file (backup: $file.bak-$STAMP)"
  fi
}

update_json "$PI_HOME/settings.json" '
  .extensions = (
    (.extensions // []) as $e
    | $e + (["-builtin:mcp", "-builtin:codemode"] - $e)
  )'

# Adds the MiniMax M3.1 preview model used by plan-minimax-m3; keeps every other entry and key.
update_json "$PI_HOME/models.json" "$(cat "$PKG_DIR/pi/models-minimax.jq")"

update_json "$CLAUDE_HOME/settings.json" '
  if any(.hooks.PreToolUse[]?.hooks[]?; (.command // "") | contains("brief-guard.sh")) then .
  else .hooks.PreToolUse = ((.hooks.PreToolUse // []) + [{
    "matcher": "Agent",
    "hooks": [{"type": "command", "command": "~/.claude/hooks/brief-guard.sh", "timeout": 10}]
  }])
  end'

"${REGISTER[@]}" "$PKG_DIR"
echo "registered package $PKG_DIR"
echo "Keep $PKG_DIR in place: pi loads the extensions from it. Restart open pi sessions to apply the changes."
