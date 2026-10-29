#!/usr/bin/env bash
# Installs the pi-warden-gs package: copies config files, wires settings and registers the pi package.
# Agent definitions ship a placeholder model: a model the user already chose is preserved, while
# `thinking:` always comes from the package.
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
# The definitions ship this as their model so nobody inherits someone else's routing.
PLACEHOLDER_MODEL="provider/model"
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
# An `model:` line the user already edited wins over the placeholder; `thinking:` always comes from
# the package. The placeholder reaches the agent only on a first install or while it is untouched.
for agent in "$PKG_DIR"/pi/agents/*.md; do
  name="$(basename "$agent")"
  dst="$PI_HOME/agents/$name"
  model=""
  if [ -n "$MODEL_OVERRIDE" ]; then
    model="$MODEL_OVERRIDE"
  elif [ -f "$dst" ]; then
    chosen="$(sed -n 's/^model:[[:space:]]*//p' "$dst" | head -n 1)"
    if [ -n "$chosen" ] && [ "$chosen" != "$PLACEHOLDER_MODEL" ]; then model="$chosen"; fi
  fi
  src="$agent"
  if [ -n "$model" ]; then
    # Rewrite only the first `model:` line (the frontmatter one).
    src="$WORK_DIR/$name"
    awk -v m="$model" '!done && /^model:/ { print "model: " m; done = 1; next } { print }' "$agent" > "$src"
  fi
  place "$src" "$dst"
done
if [ -n "$MODEL_OVERRIDE" ]; then
  echo "agents use model $MODEL_OVERRIDE"
else
  echo "agent models: $PLACEHOLDER_MODEL in $PI_HOME/agents/*.md is a placeholder; edit it or rerun with PI_WARDEN_GS_MODEL=provider/model"
fi
place "$PKG_DIR/hooks/brief-guard.sh" "$CLAUDE_HOME/hooks/brief-guard.sh"
chmod 755 "$CLAUDE_HOME/hooks/brief-guard.sh"

# --- Claude Code: the same guards, the same global prompt, the same subagents.
# Every file is deployed with a backup and the settings entries are added only when they are
# missing, so running this script again changes nothing.
CLAUDE_HOOKS_SRC="$PKG_DIR/claude/hooks"
CLAUDE_AGENTS_SRC="$PKG_DIR/claude/agents"
CLAUDE_MODEL_OVERRIDE="${CLAUDE_WARDEN_MODEL:-}"
APPEND_MARKER="<!-- pi-warden-gs:append-system -->"
APPEND_END="<!-- /pi-warden-gs:append-system -->"

place_tree() {
  local src_dir="$1" dst_dir="$2" src
  [ -d "$src_dir" ] || return 0
  mkdir -p "$dst_dir"
  for src in "$src_dir"/*.mjs; do
    [ -e "$src" ] || continue
    place "$src" "$dst_dir/$(basename "$src")"
  done
}

if [ -d "$CLAUDE_HOOKS_SRC" ]; then
  place_tree "$CLAUDE_HOOKS_SRC" "$CLAUDE_HOME/hooks"
  place_tree "$CLAUDE_HOOKS_SRC/lib" "$CLAUDE_HOME/hooks/lib"
fi

# A model the user already chose wins over the packaged default, exactly as on the Pi side.
for agent in "$CLAUDE_AGENTS_SRC"/*.md; do
  [ -e "$agent" ] || continue
  name="$(basename "$agent")"
  dst="$CLAUDE_HOME/agents/$name"
  model=""
  if [ -n "$CLAUDE_MODEL_OVERRIDE" ]; then
    model="$CLAUDE_MODEL_OVERRIDE"
  elif [ -f "$dst" ]; then
    chosen="$(sed -n 's/^model:[[:space:]]*//p' "$dst" | head -n 1)"
    if [ -n "$chosen" ] && [ "$chosen" != "inherit" ]; then model="$chosen"; fi
  fi
  src="$agent"
  if [ -n "$model" ]; then
    src="$WORK_DIR/$name"
    awk -v m="$model" '!done && /^model:/ { print "model: " m; done = 1; next } { print }' "$agent" > "$src"
  fi
  place "$src" "$dst"
done

# The global prompt lives in its own file and is included from CLAUDE.md, so the harness that
# composes CLAUDE.md never rewrites the prompt itself.
ensure_append_import() {
  local md="$CLAUDE_HOME/CLAUDE.md" import_line="@$CLAUDE_HOME/APPEND_SYSTEM.md" tmp
  mkdir -p "$CLAUDE_HOME"
  [ -f "$md" ] || : > "$md"
  if grep -qF "$APPEND_MARKER" "$md"; then
    tmp="$(mktemp "$md.XXXXXX")"
    awk -v s="$APPEND_MARKER" -v e="$APPEND_END" -v i="$import_line" '
      $0 == s { print s; print i; skip = 1; next }
      skip && $0 == e { print e; skip = 0; next }
      skip { next }
      { print }' "$md" > "$tmp"
    chmod --reference="$md" "$tmp" 2>/dev/null || true
    if cmp -s "$tmp" "$md"; then
      rm -f "$tmp"
      echo "unchanged $md"
    else
      cp -p "$md" "$md.bak-$STAMP"
      mv "$tmp" "$md"
      echo "updated $md (backup: $md.bak-$STAMP)"
    fi
  else
    cp -p "$md" "$md.bak-$STAMP"
    printf '\n%s\n%s\n%s\n' "$APPEND_MARKER" "$import_line" "$APPEND_END" >> "$md"
    echo "updated $md (backup: $md.bak-$STAMP)"
  fi
}

if [ -f "$PKG_DIR/claude/APPEND_SYSTEM.md" ]; then
  place "$PKG_DIR/claude/APPEND_SYSTEM.md" "$CLAUDE_HOME/APPEND_SYSTEM.md"
  ensure_append_import
fi

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

# This installer never disables a built-in extension. Installing a guard package must not turn off
# MCP support (or any other built-in): that is the user's setting, not the package's. A file a
# previous version already changed is reported and left byte-identical.
SETTINGS_FILE="$PI_HOME/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
  if ! disabled_builtins="$(jq -r '(.extensions // [])[] | select(type == "string" and startswith("-builtin:"))' \
    "$SETTINGS_FILE" 2>/dev/null)"; then
    echo "warning: $SETTINGS_FILE is not valid JSON; it is left untouched, so this installer cannot tell whether it disables a built-in extension" >&2
  elif [ -n "$disabled_builtins" ]; then
    while IFS= read -r disabled; do
      echo "note: $SETTINGS_FILE disables $disabled; remove that entry to load the built-in again"
    done <<< "$disabled_builtins"
  fi
fi

# Adds the MiniMax M3.1 preview model used by plan-minimax-m3; keeps every other entry and key.
update_json "$PI_HOME/models.json" "$(cat "$PKG_DIR/pi/models-minimax.jq")"

if [ -f "$PKG_DIR/claude/claude-settings.jq" ]; then
  update_json "$CLAUDE_HOME/settings.json" "$(cat "$PKG_DIR/claude/claude-settings.jq")"
fi

"${REGISTER[@]}" "$PKG_DIR"
echo "registered package $PKG_DIR"
echo "Keep $PKG_DIR in place: pi loads the extensions from it. Restart open pi sessions to apply the changes."
if [ -d "$CLAUDE_HOOKS_SRC" ]; then
  echo "Claude Code guards installed in $CLAUDE_HOME/hooks and registered in $CLAUDE_HOME/settings.json."
  echo "Restart Claude Code to apply them; the global prompt is included from $CLAUDE_HOME/CLAUDE.md."
fi
