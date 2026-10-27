#!/usr/bin/env bash
# brief-guard: PreToolUse hook on the Agent tool, also invoked by the Pi safety-guard.
# Validates the structure of a writer launch (gentle-ai-worker, gentle-ai-worker-infra)
# brief: the sections required by the repository AGENTS.md, present, non-empty and in
# order, plus the size, Steps, Preconditions, Allowed edit surfaces and Verification
# rules. Command-level prohibitions (push commands and .env reads) are enforced at
# execution time by the host safety guard, not here.
# Active in repositories whose AGENTS.md defines "### Brief del subagente", and in any
# repository when the caller sets BRIEF_GUARD_FORCE_STRUCTURE=1 (the Pi path, where the
# global override defines the brief contract for every project).
# Any parsing problem lets the call through (exit 0).
set -u

input=$(cat) || exit 0
agent=$(jq -r '.tool_input.subagent_type // empty' <<<"$input" 2>/dev/null) || exit 0
case "$agent" in
  gentle-ai-worker | gentle-ai-worker-infra) ;;
  *) exit 0 ;;
esac

cwd=$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null) || exit 0
if [ "${BRIEF_GUARD_FORCE_STRUCTURE:-}" != 1 ]; then
  root=$(git -C "${cwd:-.}" rev-parse --show-toplevel 2>/dev/null) || exit 0
  grep -qF '### Brief del subagente' "$root/AGENTS.md" 2>/dev/null || exit 0
fi

brief=$(jq -r '.tool_input.prompt // empty' <<<"$input" 2>/dev/null) || exit 0
brief=$(printf '%s' "$brief" | tr -d '\r')
# Count the exact LF-normalized bytes of the prompt without command substitution stripping
# trailing newlines: `jq -j` emits no added newline, `tr -d '\r'` normalizes CRLF, so `wc -c`
# counts exact LF bytes including any trailing newline.
bytes=$(jq -j '.tool_input.prompt // empty' <<<"$input" 2>/dev/null | tr -d '\r' | wc -c | tr -d '[:space:]') || exit 0

problems=$(printf '%s' "$brief" | awk -v bytes="$bytes" '
BEGIN {
  list = "Objective|Preconditions|Steps|Allowed edit surfaces|Verification|Acceptance criteria|Architecture constraints|Report"
  n = split(list, req, "|")
  for (i = 1; i <= n; i++) idx[req[i]] = i
}
/^[[:space:]]*(```|~~~)/ {
  fence = !fence
  if (cur != "") { body[cur]++; if (cur == "Steps") last = $0 }
  next
}
!fence && /^## / {
  h = substr($0, 4); sub(/[[:space:]]+$/, "", h); cur = h
  if ((h in idx) && !(h in seen)) { seen[h] = ++pos; order[pos] = h }
  next
}
!fence && /^# / { cur = ""; next }
cur != "" && /[^[:space:]]/ {
  body[cur]++
  if (cur == "Steps") {
    last = $0
    line = $0
    sub(/^[[:space:]]+/, "", line)
    sub(/[[:space:]]+$/, "", line)
    if (first_steps == "") first_steps = line
    if (index(line, "Strict TDD is active.") > 0) tdd = 1
    low = tolower(line)
    if (low ~ /(^|[^a-z0-9_])preferred([^a-z0-9_]|$)/) weasel = 1
    if (low ~ /(^|[^a-z0-9_])may([^a-z0-9_]|$)/) weasel = 1
    if (index(low, "if possible") > 0) weasel = 1
  }
  if (cur == "Preconditions") pre = pre $0 "\n"
  if (cur == "Allowed edit surfaces") surf[++ns] = $0
  if (cur == "Verification") ver = ver $0 "\n"
}
END {
  if (bytes + 0 >= 3072)
    print "- brief must be smaller than 3072 bytes"
  for (i = 1; i <= n; i++) {
    h = req[i]
    if (!(h in seen)) printf "- missing section \"## %s\"\n", h
    else if (!body[h]) printf "- empty section \"## %s\"\n", h
  }
  prev = 0
  for (p = 1; p <= pos; p++) {
    i = idx[order[p]]
    if (i < prev) { printf "- sections out of order; expected: %s\n", list; break }
    prev = i
  }
  if (("Steps" in seen) && last !~ /stop and report it/)
    print "- \"## Steps\" must end with: If a step fails for a reason this brief does not cover, stop and report it; never change the planned design on your own."
  if (tdd && first_steps != "Strict TDD is active.")
    print "- \"## Steps\" must start with: Strict TDD is active."
  if (weasel)
    print "- \"## Steps\" must not contain \"preferred\", \"may\", or \"if possible\""
  lowpre = tolower(pre)
  if (("Preconditions" in seen) && body["Preconditions"] && (lowpre !~ /branch/ || lowpre !~ /head/ || lowpre !~ /git status --short/))
    print "- \"## Preconditions\" must reference the expected branch, HEAD, and git status --short"
  for (i = 1; i <= ns; i++) {
    line = surf[i]
    sub(/^[[:space:]]+/, "", line)
    sub(/[[:space:]]+$/, "", line)
    if (line == "") continue
    bad = 0
    if (line ~ /^-[[:space:]]/) bad = 1
    else if (line == ".") bad = 1
    else if (line ~ /^`.*`$/) {
      inner = substr(line, 2, length(line) - 2)
      if (inner == "" || inner == "." || inner ~ /^\// || inner ~ /\.\./ || inner ~ /\*\*/) bad = 1
    } else if (line ~ /[[:space:]]/ || line ~ /^\//) bad = 1
    if (line ~ /\.\./ || line ~ /\*\*/) bad = 1
    if (bad)
      print "- \"## Allowed edit surfaces\" line is not a repository-relative path or narrow glob"
  }
  if (ver ~ /export[[:space:]]+[A-Za-z_][A-Za-z0-9_]*=.*\$\(/ || ver ~ /\|[ \t]*while[ \t]+read/)
    print "- \"## Verification\" must not hide failures with export VAR=$( or | while read"
}') || exit 0

[ -z "$problems" ] && exit 0
{
  echo "brief-guard: $agent brief rejected; required sections missing, empty or out of order."
  echo "$problems"
  echo "Fix the brief and relaunch the worker."
} >&2
exit 2
