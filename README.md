# pi-warden-gs

A [Pi](https://github.com/gentleman-programming/pi) package with the author's harness guards, gates
and workarounds for Gentle AI workflows: it blocks destructive commands, requires a reviewed brief
before any writer subagent starts, keeps the orchestrator's replies short, and repairs a
`gentle_review` START whose arguments arrived mangled.

Opinionated by design: this is one author's working configuration, published as-is so it can be
read, copied and adapted. Read the code before installing it — packages can execute code in your
session.

- Author: Sebastián Díaz ([@sdiazbarraza](https://github.com/sdiazbarraza))
- License: [MIT](LICENSE)

## Requirements

- Pi (`pi` CLI). Most extensions assume [gentle-pi](https://www.npmjs.com/package/gentle-pi) and its
  `gentle-ai-*` subagents; `safety-guard.ts` and `brief-guard.sh` are the only pieces that depend on
  them.
- Claude Code, for the Claude Code side of the package (see [Claude Code](#claude-code)). That side
  needs Node >= 22 in `PATH` to run the hooks and `jq` for the brief guard; it does not need Pi or
  gentle-pi.
- `bash`, `jq` and `git` for `hooks/brief-guard.sh` and `install.sh`.
- Node >= 22 only to run the tests.
- `install.sh` and `bin/pi-perfil` read the target home from `gentle-shell home`: `link` uses
  `~/.pi/agent` and `~/.pi/gentle-ai`, `isolated` uses `~/.gentle-shell/agent` and
  `~/.gentle-shell/gentle-ai`; `PI_CODING_AGENT_DIR` and `GENTLE_PI_CONFIG_HOME` override both.

## Install

### Option 1 — install the package (extensions only)

```bash
pi install git:github.com/sdiazbarraza/pi-warden-gs
pi list                        # must show ../../... or the git source you just added
```

Personal installs are written to `~/.pi/agent/settings.json`; add `-l` to write
`.pi/settings.json` for one project instead. To try it for a single run without touching settings:

```bash
pi -e git:github.com/sdiazbarraza/pi-warden-gs
```

This option loads the `extensions/` listed in `package.json` and nothing else. Use it if you only
want the guards and workarounds.

### Option 2 — clone and run the installer (full setup)

```bash
git clone https://github.com/sdiazbarraza/pi-warden-gs
cd pi-warden-gs
./install.sh
```

`install.sh` is idempotent and deploys the parts Pi does not load from a package:

1. Copies `pi/APPEND_SYSTEM.md` and the `pi/agents/*.md` definitions into `<agent-dir>`. Every
   definition ships `model: provider/model` as a placeholder, so an install never inherits the
   author's routing: a `model:` line you edited yourself is preserved, while `thinking:` always comes
   from the package.
2. Copies `bin/pi-perfil` to `~/bin/pi-perfil` and the routing profiles to
   `~/.pi/gentle-ai/profiles/`.
3. Installs `hooks/brief-guard.sh` as the Claude Code `PreToolUse` hook in
   `~/.claude/hooks/` and registers it in `~/.claude/settings.json`.
4. Installs the Claude Code side: the four hooks in `~/.claude/hooks/`, the five subagents in
   `~/.claude/agents/`, the global prompt in `~/.claude/APPEND_SYSTEM.md` included from
   `~/.claude/CLAUDE.md`, and the hook registrations in `~/.claude/settings.json`.
5. Moves previously loose `safety-guard.ts`, `rtk.ts` and `minimax-review-binding.ts` out of
   `<agent-dir>/extensions` into `extensions-backup-<stamp>/`, so a stale copy cannot load twice.
6. Disables the `builtin:mcp` and `builtin:codemode` extensions in `<agent-dir>/settings.json`.
7. Registers this directory as a Pi package (`gentle-shell install <dir>`, or `pi install <dir>`
   without gentle-shell).
8. Backs up every file it would overwrite to `*.bak-<stamp>` and keeps the originals otherwise.

Keep the cloned directory in place: Pi loads the extensions from it, and `/reload` (or a new
session) activates changes in an open session.

The definitions ship the placeholder `model: provider/model`, so each install picks its own. Edit
the `model:` line in `<agent-dir>/agents/*.md`, or set one model for every bundled agent at once:

```bash
PI_WARDEN_GS_MODEL=deepseek/deepseek-v4-pro ~/pi-warden-gs/install.sh
```

The value must be `provider/model`. Re-running the installer keeps a `model:` line you already edited
and restores `thinking:` from the package; the placeholder is written again only when a definition is
new or still carries it. The installer never changes Pi's default (orchestrator) model.
`PI_OVERRIDES_MODEL` is still accepted as a legacy alias.

### Option 3 — hooks and agents only

Copy `pi/APPEND_SYSTEM.md` and `pi/agents/*.md` into your agent directory by hand and register
`hooks/brief-guard.sh` in your Claude Code settings. Nothing else is required: the `extensions/`
files are plain Pi extensions if you prefer to load them with `-e`.

### Verify the installation

```bash
pi list                                  # the package appears
node --experimental-strip-types --test tests/*.test.ts    # 73 tests, all passing
chmod 755 hooks/brief-guard.sh           # only if you copied it by hand
```

In an open Pi session, run `/reload` after installing or updating the package.

## Claude Code

The same guard layer, the same five subagents and the same global prompt are available for Claude
Code. The Pi extensions and the Claude Code hooks are two implementations of one contract, kept in
step by a differential test that runs the same command corpus through both and requires identical
labels.

| Pi | Claude Code |
| --- | --- |
| `extensions/safety-guard.ts` (`tool_call`) | `claude/hooks/safety-guard.mjs` (`PreToolUse` on `Bash` and `Agent`) |
| `extensions/reply-length.ts` (`before_agent_start`) | `claude/hooks/reply-length.mjs` (`UserPromptSubmit`) |
| `extensions/rtk.ts` (`tool_call`) | `claude/hooks/rtk.mjs` (`PreToolUse` on `Bash`) |
| approvals in Pi session entries | approvals in `~/.claude/.warden/approvals.json` |
| `pi/APPEND_SYSTEM.md` | `claude/APPEND_SYSTEM.md`, included from `~/.claude/CLAUDE.md` |
| `pi/agents/*.md` | `claude/agents/*.md` → `~/.claude/agents/` |
| `hooks/brief-guard.sh` | the same script, already shared |

### What the Claude Code hooks do

| Hook | Event | What it does |
| --- | --- | --- |
| `safety-guard.mjs` | `PreToolUse` (`Bash`) | Blocks destructive commands, delivery commands outside the publisher, and heavy builds or container runs outside a subagent |
| `safety-guard.mjs` | `PreToolUse` (`Agent`) | The reviewed-brief gate: a writer launch needs an approved brief and a brief that passes `brief-guard.sh` |
| `brief-approval.mjs` | `PostToolUse` (`Agent`) | Registers the sha256 of a brief the reviewer approved |
| `reply-length.mjs` | `UserPromptSubmit` | Adds the reply-length reminder, in the main session only |
| `rtk.mjs` | `PreToolUse` (`Bash`) | Rewrites the command through `rtk rewrite` |

Claude Code has no session-entry API for hooks, so the approvals live in a file:
`~/.claude/.warden/approvals.json` (override the directory with `CLAUDE_WARDEN_STATE_DIR`). The
approvals are scoped to the session that granted them, are single-use, and the write is atomic.

### How the Claude Code side detects a subagent

Pi recognizes a child agent through `GENTLE_PI_AGENTS_CHILD`. Claude Code writes a subagent's
transcript next to a `.meta.json` sibling that names the agent:

```
~/.claude/projects/<slug>/subagents/agent-<id>.jsonl
~/.claude/projects/<slug>/subagents/agent-<id>.meta.json   -> {"agentType":"gentle-ai-publisher",...}
```

The main session has no such sibling. The hooks read `agentType` from it: the heavy-build gate
applies only in the main session, and the delivery gate allows `git push` and `gh pr` only inside
the `gentle-ai-publisher` subagent.

### The global prompt

`claude/APPEND_SYSTEM.md` is installed as `~/.claude/APPEND_SYSTEM.md` and included from
`~/.claude/CLAUDE.md`:

```markdown
<!-- pi-warden-gs:append-system -->
@/home/<user>/.claude/APPEND_SYSTEM.md
<!-- /pi-warden-gs:append-system -->
```

The prompt lives in its own file so a harness that composes `CLAUDE.md` never rewrites it, and the
installer re-adds the inclusion if the file is replaced. Re-running `install.sh` is always safe.

### Installing the Claude Code side

`install.sh` deploys it together with the Pi side. The Claude subagents ship `model: inherit`; a
`model:` you edited yourself is kept. To set one model for all of them:

```bash
CLAUDE_WARDEN_MODEL=sonnet ./install.sh
```

### Verify the Claude Code installation

```bash
ls ~/.claude/hooks/                       # safety-guard.mjs, brief-approval.mjs, reply-length.mjs, rtk.mjs
ls ~/.claude/agents/gentle-ai-*.md        # the five subagents
grep -c "pi-warden-gs:append-system" ~/.claude/CLAUDE.md
jq '.hooks.PreToolUse' ~/.claude/settings.json
```

Restart Claude Code after installing: the hooks of a session are read when it starts.

## How the package works

### Pi packages and what actually loads

A Pi package is an ordinary directory or npm source declared in `settings.json`. Pi shows the ones
it configured with `pi list`, installs or removes them with `pi install` / `pi remove`, and can load
one package for a single invocation with `pi -e`.

`package.json` carries the manifest:

```json
"keywords": ["pi-package"],
"pi": { "extensions": ["./extensions/safety-guard.ts", "..."] }
```

That list, not the contents of `extensions/`, decides what loads. A file present in `extensions/`
but absent from `pi.extensions` loads nothing — which is why every extension is registered here and
why `install.sh` removes loose copies from `<agent-dir>/extensions/`: the same file in two places
would register its handler twice.

Without a `pi` manifest, Pi falls back to discovering `extensions/`, `skills/`, `prompts/` and
`themes/` by convention. This package uses the explicit list.

### Extension lifecycle

Each file in `extensions/` is a self-contained Pi extension. Pi calls its default export once per
session with the `ExtensionAPI`; the extension registers handlers and returns:

```ts
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => { /* runs before every tool */ })
}
```

| Extension | Hooks | What it does | Failure mode |
| --- | --- | --- | --- |
| `safety-guard.ts` | `tool_call` | Blocks destructive bash commands, blocks direct delivery commands outside `gentle-ai-publisher`, blocks heavy builds in the orchestrator, and gates writer dispatch on a reviewed brief | Fail-**closed** on writer dispatch (any guard error blocks), fail-open on the bash destructive check |
| `brief-guard.sh` (hook) | Claude Code `PreToolUse`, and spawned by `safety-guard` | Checks the eight required brief sections, their order, the stop-and-report clause, size, TDD line, weasel words, preconditions, edit surfaces and hidden-failure commands: it validates brief structure only, and the execution-time guard owns the delivery and `.env` rules | Fail-open on parsing, exit 2 on a malformed brief |
| `reply-length.ts` | `before_agent_start` | Adds one hidden reminder per user-started run of the main session: at most 5 lines of at most 25 words, outcome first, long content in a file | Cannot fail: it only appends a message |
| `rtk.ts` | `tool_call` | Rewrites bash commands to use `rtk` for token savings | Leaves commands alone when it cannot rewrite them |

A `tool_call` handler runs before the tool and may mutate `event.input`; Pi performs no validation
afterwards. A handler that throws blocks the tool, so every mutating path here is wrapped: mutations
are deliberate and exceptions are swallowed into a pass-through.

### The brief gate, end to end

Writer subagents (`gentle-ai-worker`, `gentle-ai-worker-infra`) only start with an approved brief:

1. The orchestrator runs `gentle-ai-brief-review` with `mode: "task"` and the exact brief inline,
   between a line `<<<BRIEF` and a line `BRIEF>>>`.
2. `safety-guard.ts` requires the reviewer to run in a foreground `task`, rejects a brief that
   already contains a `VERDICT:` line, and runs `brief-guard.sh` on the marked brief before the
   model review starts.
3. On `VERDICT: APPROVE` the sha256 of the normalized brief (CRLF → LF, trimmed) becomes a session
   entry, an approval.
4. Launching a writer consumes that approval for byte-identical text (task plus context). Approvals
   are single-use: any edit needs a new review.
5. Before the approval is consumed, `hooks/brief-guard.sh` checks the structure and the extra
   mechanical rules (size, TDD line, weasel words, preconditions, edit surfaces and hidden-failure
   commands). It validates brief structure only: the delivery and `.env` rules belong to the
   execution-time guard, which sees the command that will run. Pi forces that check with
   `BRIEF_GUARD_FORCE_STRUCTURE=1`, so it applies to every writer brief regardless of `AGENTS.md`
   or of whether the working directory is a git repository. In Claude Code the same script runs
   as a hook, and there it activates only in repositories whose `AGENTS.md` defines
   `### Brief del subagente`. The reviewer still judges verbatim acceptance-criteria matching
   against the issue and whether the plan is the right work.
6. A brief whose first line is `<!-- review: skipped (small fix) -->` skips the model review and
   still runs the instant `brief-guard.sh` checks.
7. `subagent_continue` and `subagent_send_message` to a writer task are always blocked: new
   instructions need a new reviewed brief.

Approvals and writer task ids are session entries, so they survive reload, resume and branch
changes. In exchange, an entry keyed by the old package name (`pi-overrides.brief-approval`) does
not match after the rename to `pi-warden-gs`: the guard fails closed and that brief has to be
reviewed again.

### What `install.sh` puts where

| From | To | Notes |
| --- | --- | --- |
| `pi/APPEND_SYSTEM.md` | `<agent-dir>/APPEND_SYSTEM.md` | Persistent global override appended to Pi's system prompt |
| `pi/agents/*.md` | `<agent-dir>/agents/` | `gentle-ai-runner`, `-worker-infra`, `-publisher`, `-brief-review`, `-prompt-refine`; `model:` ships as the placeholder `provider/model`, and a `model:` you edited is kept |
| `pi/profiles/*.json` | `~/.pi/gentle-ai/profiles/` | Model routing per agent |
| `pi/models-minimax.jq` | — | Used only to add a missing model to `models.json` |
| `bin/pi-perfil` | `~/bin/pi-perfil` | Profile switcher, needs `jq` |
| `hooks/brief-guard.sh` | `~/.claude/hooks/brief-guard.sh` | Shared with Claude Code |
| `claude/hooks/*.mjs` | `~/.claude/hooks/` | The Claude Code guards, registered in `~/.claude/settings.json` |
| `claude/hooks/lib/*.mjs` | `~/.claude/hooks/lib/` | The approval store and the subagent detection |
| `claude/agents/*.md` | `~/.claude/agents/` | The same five subagents, `model:` ships as `inherit`, and a `model:` you edited is kept |
| `claude/APPEND_SYSTEM.md` | `~/.claude/APPEND_SYSTEM.md` | Included from `~/.claude/CLAUDE.md` |
| `extensions/*.ts` | *(nobody)* | Loaded in place from this package |

Anything already installed with different content is backed up as `*.bak-<stamp>` before it is
replaced, and the script can run repeatedly.

## Contents

### Extensions

- `extensions/safety-guard.ts`: destructive-command blocker, brief approval gate and delivery gate.
  `git push` and `gh pr create|merge|edit` run only inside `gentle-ai-publisher` — a gentle-pi child
  whose definition carries `<!-- pi-warden-gs:agent=gentle-ai-publisher -->` — while the orchestrator
  and other agents are blocked. Builds, test runs and container runs (`dotnet-in-docker.sh`,
  `docker run|build|exec`, `docker compose up|run|build|exec`) are blocked in the orchestrator and
  allowed in subagents, and read-only docker queries stay allowed. Checks cover `bash`,
  `bash_background` and `monitor`.
- `extensions/reply-length.ts`: adds one hidden reminder before every user-started run of the main
  session (never in subagents) to answer in at most 5 lines of at most 25 words each, one sentence
  per line, outcome first and long content in a file. The reminder is the single home of that
  policy; no `AGENTS.md` or `APPEND_SYSTEM.md` restates it.
- `extensions/rtk.ts`: rtk integration for bash command rewriting.

### Provider workarounds live in their own package

The native-review workarounds moved to
[pi-minimax-gs](https://github.com/sdiazbarraza/pi-minimax-gs): the `gentle_review` START repair
(relocated envelope, mangled `lenses`/`lensesReason`/`committedOnly`) and the capture-binding
tripwire both exist because of provider-side argument serialization observed with the MiniMax model
family. They are local workarounds for
[gentle-shell#2280](https://github.com/Gentleman-Programming/gentle-shell/issues/2280), not part of
the general harness, so this package no longer ships them: install `pi-minimax-gs` alongside it if
you review with that family, and drop it once the upstream defects land.

### Hooks, agents and configuration

- `hooks/brief-guard.sh`: the structural brief check shared with Claude Code, described above.
- `pi/APPEND_SYSTEM.md`: the global override — subagent roles, verification rules, prompt refinement,
  brief review, memory, and the reply-length policy.
- `pi/agents/*.md`: the subagent definitions used by these rules (`gentle-ai-runner`,
  `gentle-ai-worker-infra`, `gentle-ai-publisher`, `gentle-ai-brief-review`,
  `gentle-ai-prompt-refine`). Each ships `model: provider/model` as a placeholder that the installer
  must replace, plus the `thinking:` level the author picked for that role.
- `pi/profiles/*.json`: model-routing profiles for the gentle-ai and review agents.
  `deepseek`: DeepSeek only (v4-pro for writers, verify and reviewers; flash for runner and
  publisher). `deepseek-minimax`: writers on DeepSeek, reviewers on MiniMax M3. `gpt`: GPT only
  (`openai-codex`). `opencode-go`: DeepSeek through OpenCode Go (v4-pro for workers, verify,
  refuter and validator; v4.1-flash for the rest). `go-minimax`: like `opencode-go`, but explore,
  runner, publisher and the four review lenses on MiniMax M3, so code written by DeepSeek is
  reviewed by another model; refuter and validator stay on DeepSeek. `plan-minimax-m3`: MiniMax
  only; its writers and refuter use `minimax/MiniMax-M3.1-Flash-Preview`, which Pi's catalog lacks,
  so `install.sh` adds it to the `minimax` provider in `models.json` with `pi/models-minimax.jq`
  (only when missing; other providers, keys and entries are kept).
- `bin/pi-perfil`: activates any routing profile saved in `~/.pi/gentle-ai/profiles/` (`pi-perfil
  <name>`, `pi-perfil list`), reading the connected providers from Pi's `auth.json` and warning, without
  blocking, about a profile whose provider Pi has no credentials for. `pi-perfil suggest --model
  provider/model [profile]` writes `<profile>-suggested.json` with the models of unconnected providers
  replaced by the one you pass, and writes nothing when everything is already reachable. Activation
  validates `~/.pi/gentle-ai/profiles/<name>.json`, adds or replaces it in `~/.pi/gentle-ai/profiles.json`
  (backing that file up first) and marks it active, which gentle-pi uses to route subagents.
  gentle-pi freezes the profile when a session starts: new sessions pick it up, open sessions need
  `/gentle:profiles` → `<name>` → Enter, and `/reload` does not switch it. The profile is also
  copied to `models.export.json` for `/gentle:models` → `r`.

### Tests

`tests/*.test.ts` run with Node's test runner; no dependencies beyond Node >= 22:

```bash
node --experimental-strip-types --test tests/*.test.ts
```

All 73 pass on a clean machine. They cover the destructive-command matcher, the brief approval flow,
the structure checker as a real process, the reply-length reminder, the profile switcher and the
installer. Node's TypeScript stripping is experimental, so the flag is required on Node 22.

## Uninstall

```bash
pi remove git:github.com/sdiazbarraza/pi-warden-gs   # or the source you installed
rm -f <agent-dir>/APPEND_SYSTEM.md <agent-dir>/agents/gentle-ai-*.md ~/bin/pi-perfil
rm -f ~/.claude/hooks/brief-guard.sh ~/.claude/hooks/*.mjs
rm -rf ~/.claude/hooks/lib ~/.claude/.warden
rm -f ~/.claude/agents/gentle-ai-*.md ~/.claude/APPEND_SYSTEM.md
```

Remove the `brief-guard.sh` entry from `~/.claude/settings.json` and the `pi-warden-gs:append-system`
block from `~/.claude/CLAUDE.md`, and restore any `*.bak-<stamp>` or `extensions-backup-<stamp>/` files
you want back.

## Excluded

`herdr-agent-state.ts` (managed by herdr) and the model assignments of agents that this package does
not define.
