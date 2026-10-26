# Registers the pi-warden-gs hooks for Claude Code.
#
# Only entries that are missing are added: a hook already registered with the same matcher and
# command is left alone, and every foreign entry (the harness hooks, the user's own hooks) is
# preserved. The script that applies this filter is idempotent.
#
# ensure(event; matcher; command; timeout)
def ensure($event; $matcher; $cmd; $timeout):
  if any(.hooks[$event][]? | select(.matcher == $matcher) | .hooks[]?;
         (.command // "") == $cmd)
  then .
  else .hooks[$event] = ((.hooks[$event] // []) + [{
         matcher: $matcher,
         hooks: [{type: "command", command: $cmd, timeout: $timeout}]
       }])
  end;

.hooks = (.hooks // {})
| ensure("PreToolUse";       "Bash";  "node ~/.claude/hooks/safety-guard.mjs";   10)
| ensure("PreToolUse";       "Bash";  "node ~/.claude/hooks/rtk.mjs";            5)
| ensure("PreToolUse";       "Agent"; "node ~/.claude/hooks/safety-guard.mjs";   10)
| ensure("PreToolUse";       "Agent"; "~/.claude/hooks/brief-guard.sh";          10)
| ensure("PostToolUse";      "Agent"; "node ~/.claude/hooks/brief-approval.mjs";  5)
| ensure("UserPromptSubmit"; "";     "node ~/.claude/hooks/reply-length.mjs";    5)
