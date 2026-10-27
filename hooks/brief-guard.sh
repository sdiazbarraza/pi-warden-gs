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

brief=$(jq -r '.tool_input.prompt // empty' <<<"$input" 2>/dev/null) || exit 0
brief=$(printf '%s' "$brief" | tr -d '\r')
# Count the exact LF-normalized bytes of the prompt without command substitution stripping
# trailing newlines: `jq -j` emits no added newline, `tr -d '\r'` normalizes CRLF, so `wc -c`
# counts exact LF bytes including any trailing newline.
bytes=$(jq -j '.tool_input.prompt // empty' <<<"$input" 2>/dev/null | tr -d '\r' | wc -c | tr -d '[:space:]') || exit 0

problems=$(printf '%s' "$brief" | awk -v bytes="$bytes" '
function trim(s) {
  sub(/^[[:space:]]+/, "", s)
  sub(/[[:space:]]+$/, "", s)
  gsub(/[ \t]+/, " ", s)
  return s
}
# envref: the text names a .env file. The .env.example exemption applies to a basename
# that is exactly ".env.example": the left anchor rejects a preceding "." or "-", so
# "foo..env.example" and "backup.env.example" stay reads, and only the exempt token is
# removed, so "cp .env.example .env" still reads .env.
function envref(t) {
  gsub(/(^|[^A-Za-z0-9_.-])\.env\.example([^A-Za-z0-9_.-]|$)/, " ", t)
  return t ~ /\.env([^A-Za-z0-9_]|$)/
}
# isread: the text reads file contents through a reader command, a control-flow word list
# ("for f in .env" names a file with no reader command at all), a redirect or an env-file
# flag. head lets the reader sit behind a wrapper, a nested shell, eval or find -exec.
function isread(s) {
  if (s ~ /^[.][[:space:]]/) return 1
  if (s ~ ("^" head readers "([[:space:]]|$)")) return 1
  if (s ~ /<[[:space:]]*\.env/) return 1
  if (s ~ /--env-file([[:space:]]+|=)?([^[:space:]]*\/)?\.env/) return 1
  if (s ~ /(^|[[:space:]])(for|while|until)[[:space:]]/ && s ~ /(^|[[:space:]])in([[:space:]]|$)/) return 1
  return 0
}
# envbad: the text reads a .env file.
function envbad(s) {
  if (!isread(s)) return 0
  return envref(s)
}
# hasneg: the segment is itself a prohibition (imperative list or copula prose), so it names
# delivery or .env reads without performing them.
function hasneg(s) {
  if (s ~ /(^|[^A-Za-z0-9_])(do[[:space:]]+not|must[[:space:]]+not|never|avoid|without|should[[:space:]]+not)[[:space:]]/) return 1
  if (s ~ /(is|are|was|were|being|remains|stays|must|should|shall)[[:space:]]+(be[[:space:]]+)?(not[[:space:]]+)?(forbidden|prohibited|blocked|disallowed|avoided|not[[:space:]]+allowed)/) return 1
  return 0
}
# stripassign: drop leading shell assignment prefixes (VAR=value). The quoted forms are
# matched on the raw text, before quote stripping, because a quoted value may contain a
# space and stripping quotes first would end the prefix at that space ("x y" -> "x y").
function stripassign(s) {
  while (sub("^[[:space:]]*" assignpre, "", s)) { }
  return s
}
# segbad: every command the line runs. Negation is per command segment, so
# "never push; cat .env" still reads .env.
function segbad(line,   n, parts, i, s, whole) {
  # A trailing shell comment must not mask a read or a delivery command, and quoting is
  # noise for these patterns.
  whole = line
  sub(/(^|[[:space:]])#.*$/, "", whole)
  whole = stripassign(whole)
  gsub("[" dq sq bt "]", "", whole)
  whole = trim(whole)
  if (whole != "" && !hasneg(whole) && envbad(whole)) envread = 1
  # ; & | and command substitution (backticks or $( )) each start a new command, so a
  # nested command is inspected on its own.
  n = split(line, parts, /[;&|]|[`]|[$][(]/)
  for (i = 1; i <= n; i++) {
    s = parts[i]
    sub(/(^|[[:space:]])#.*$/, "", s)
    s = stripassign(s)
    gsub("[" dq sq bt "]", "", s)
    # a trailing ")" closes a substitution or a subshell around this command
    sub(/[)]+$/, "", s)
    s = trim(s)
    if (s == "") continue
    if (hasneg(s)) continue
    if (s ~ ("^" head "git([[:space:]]+[^[:space:]]+)*[[:space:]]+push([[:space:]]|$)")) delivery = 1
    if (s ~ ("^" head "gh([[:space:]]+[^[:space:]]+)*[[:space:]]+pr([[:space:]]+[^[:space:]]+)*[[:space:]]+(create|merge|edit)([[:space:]]|$)")) delivery = 1
    if (envbad(s)) envread = 1
  }
}
BEGIN {
  # Quoting characters are built from codes so this program stays inside single quotes.
  dq = sprintf("%c", 34); sq = sprintf("%c", 39); bt = sprintf("%c", 96)
  list = "Objective|Preconditions|Steps|Allowed edit surfaces|Verification|Acceptance criteria|Architecture constraints|Report"
  n = split(list, req, "|")
  for (i = 1; i <= n; i++) idx[req[i]] = i
  # A command can sit behind a wrapper (sudo, env, timeout, xargs, ...), a control-flow
  # keyword, a nested shell (-c), eval/exec or find -exec, a path prefix (/usr/bin/,
  # ./ or ../) or a shell assignment prefix (VAR=value); each carries its own arguments
  # and the alternatives nest, so sudo plus bash -c plus git push is still one command.
  nest = "(sudo|env|command|nohup|nice|time|timeout|xargs|doas)([[:space:]]+[^[:space:]]+)*[[:space:]]+"
  nest = nest "|(then|do|else|if|elif|while|until)([[:space:]]+)"
  nest = nest "|(bash|sh|zsh|dash|eval|exec)([[:space:]]+-[^[:space:]]+)*[[:space:]]+"
  nest = nest "|find([[:space:]]+[^[:space:]]+)*[[:space:]]+-exec[[:space:]]+"
  nest = nest "|((/[^[:space:]/]+)+/|(\\.\\.?/)+)[[:space:]]*"
  # A shell assignment prefix may carry a quoted value, including one with spaces.
  nest = nest "|[A-Za-z_][A-Za-z0-9_]*=(" dq "[^" dq "]*" dq "|" sq "[^" sq "]*" sq "|[^[:space:]]*)[[:space:]]+"
  head = "(" nest ")*"
  # assignpre is matched on raw text, where the quote characters still delimit the value.
  assignpre = "[A-Za-z_][A-Za-z0-9_]*=(" dq "[^" dq "]*" dq "|" sq "[^" sq "]*" sq "|[^[:space:]" dq sq "]*)[[:space:]]+"
  # Readers expose file contents with or without a dedicated "read" verb.
  readers = "(cat|source|grep|egrep|fgrep|rg|sed|awk|perl|python3?|node|bash|sh|zsh|cp|mv|ln|less|more|head|tail|read|jq|diff|cmp|sort|uniq|wc|tee|cut|tr|env|dotenv|export|realpath|stat"
  readers = readers "|strings|dd|od|xxd|hexdump|openssl|curl|file|ls|bat|tac|rev|nl|column|paste|join|comm|split|csplit|shuf|fold|fmt)"
}
{
  raw = raw $0 "\n"
  segbad($0)
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
  if (delivery || envread)
    print "- brief must not contain git push, gh pr create|merge|edit, or .env file reads"
}') || exit 0

[ -z "$problems" ] && exit 0
{
  echo "brief-guard: $agent brief rejected; required sections missing, empty or out of order."
  echo "$problems"
  echo "Fix the brief and relaunch the worker."
} >&2
exit 2
