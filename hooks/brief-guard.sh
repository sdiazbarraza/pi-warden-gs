#!/usr/bin/env bash
# brief-guard: PreToolUse hook on the Agent tool, also invoked by the Pi safety-guard.
# Blocks a writer launch (gentle-ai-worker, gentle-ai-worker-infra) whose brief
# misses the sections required by the repository AGENTS.md.
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

problems=$(jq -r '.tool_input.prompt // empty' <<<"$input" | awk '
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
cur != "" && /[^[:space:]]/ { body[cur]++; if (cur == "Steps") last = $0 }
END {
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
}') || exit 0

[ -z "$problems" ] && exit 0
{
  echo "brief-guard: $agent brief rejected; required sections missing, empty or out of order."
  echo "$problems"
  echo "Fix the brief and relaunch the worker."
} >&2
exit 2
