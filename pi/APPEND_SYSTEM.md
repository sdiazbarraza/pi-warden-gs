<!-- user-override: global orchestrator rules -->

## User overrides (all projects)

Persistent overrides outside `node_modules/`; they survive `npm update` of
gentle-pi. Project rules belong in each project's AGENTS.md.

### Roles

- `gentle-ai-runner`: command-only tasks with no repository edits (`gh`,
  `curl`, read-only `docker exec`, `psql -c "SELECT ..."`, `redis-cli GET`,
  inspection). Never give it repository writes or investigation; route
  investigation to `gentle-ai-explore`.
- Run short read-only commands yourself (`git status/log/diff --stat`,
  `gh issue|pr view`, `ls`, `cat`) with bounded output and inline exit codes;
  use the runner only for Docker, long-running or state-changing commands.
- `git push` and `gh pr create|merge|edit` run only through
  `gentle-ai-publisher` (mode `"task"`, exact commands, human
  authorization). This overrides the gentle-pi table that runs `git`/`gh`
  inline; safety-guard blocks those commands everywhere else.
- Builds, test runs and container runs (`backend/scripts/dotnet-in-docker.sh`,
  `docker run|build|exec`, `docker compose up|run|build|exec`) run only in
  a subagent: delegate them to `gentle-ai-runner`, or `gentle-ai-worker-infra`
  when files change too. safety-guard blocks them in the orchestrator; if
  the subagent is unavailable, stop and tell the human.
- In pi: work that writes Dockerfiles, Compose files or environment
  configuration, or runs containers to verify them, goes to
  `gentle-ai-worker-infra` (same brief format; it carries fixed Docker and
  environment safety rules).

### Verification

- Reuse supplied reads and verified facts; repeat a check on unchanged
  source only for a named reason. After a correction, rerun only the failed
  and affected checks.
- Subagents run only the checks in `## Verification`: no ad-hoc scripts, no
  checking a fact twice. For shared manifests or merge conflicts, list the
  exact check there (a `grep` of the entries, or the build that consumes it).
- Run read-only commands directly with inline exit codes (`git diff --stat
  <a> <b>; echo "exit=$?"`); use a script only to apply edits whose exact
  content was decided beforehand.
- Append to a task file (`odd/tasks/*.md`) with the edit tool in one call:
  replace its last line with that line plus the new entries. Never use
  temporary scripts, renumbering passes or `git checkout`/`git restore` to
  redo it; if the edit fails, report the error instead.
- Before relaunching a worker to correct a task, snapshot locally: `git add
  -A && git commit -m "chore(wip): snapshot before <task> correction"`. Never
  push WIP commits; before the closing commit, fold them with `git reset
  --soft <task base>` into one Conventional Commit.

### Prompt refinement

- When a human message requests new work or changes direction (implement,
  correct, investigate, review, deliver), first run `gentle-ai-prompt-refine`
  with the verbatim message, the repository or worktree path, and the issue
  number and task document when known.
- Skip it for answers, approvals, status questions, short follow-ups inside
  the current task, and requests that already state the file, exact change
  and verification. A yes/no, an authorization, a choice between offered
  options, or an instruction that already lists its explicit steps never
  goes through it.
- Its output is the working instruction; the human's verbatim words win on
  conflict, and AUTHORIZED never exceeds what they wrote. Ask its OPEN
  QUESTIONS one at a time. Show the refined text only if asked; report its
  route in one line.
- Save its output verbatim with `mem_save`, `topic_key`
  `refined-request/<feature-name>` (one per feature, overwritten per request),
  and keep the observation ID for brief review.

### Brief review

- Before launching `gentle-ai-worker` or `gentle-ai-worker-infra`, run
  `gentle-ai-brief-review` with `mode: "task"` and
  the exact brief inline between a line `<<<BRIEF` and a line `BRIEF>>>`,
  plus the worktree, the issue number, the human's requested corrections
  and, if any, the current `refined-request/<feature-name>` observation ID.
  Never write the brief to a file.
- `hooks/brief-guard.sh` (also spawned before `gentle-ai-brief-review` and
  at writer launch) enforces, locally and offline: the eight headings in
  order and non-empty; `## Steps` ends with the stop-and-report clause;
  brief size under 3072 bytes; if `Strict TDD is active.` appears it is the
  first non-empty `## Steps` line; `## Steps` has no whole words `preferred`,
  `may`, or the phrase `if possible`; `## Preconditions` names the expected
  branch, `HEAD`, and `git status --short`; `## Allowed edit surfaces` lines
  are repository-relative paths or narrow globs (no bullets, `.`, absolute
  paths, or unquoted spaces); `## Verification` has no `export VAR=$(` or
  `| while read`. It validates brief structure only; the execution-time guard
  owns the delivery and `.env` rules: the `.env` rule matches a literal path in
  the command line, removing the quotes inside a token before the name is
  compared (`cat .e''nv` names `.env`); a path assembled by shell expansion
  (`$FILE`, `$(...)`) is a known limit it does not detect. Fail-open on parse.
  The reviewer judges the rest: acceptance criteria copied verbatim, whether
  checks can fail, and whether the plan is the right work. A small-fix brief
  starting with `<!-- review: skipped (small fix) -->` skips the model review
  and still runs these instant checks.
- The text between the markers must be byte-identical to the later launch's
  `task` (plus `context`, joined by one blank line). safety-guard hashes
  both and blocks any launch whose exact brief was not approved. Approvals
  are single-use: any edit, or a second launch, needs a new review.
- `VERDICT: FIX`: correct the brief and its inputs and review again. Stop
  and show the human the findings only when a `FIX` repeats a finding from
  an earlier review of the same brief, or after the third review; new minor
  findings are fixed without asking. `VERDICT: APPROVE`:
  launch the identical text without showing it unless the human asked to
  see it; report the verdict in one line.
- Never send new instructions to a writer task
  (`subagent_continue`, `subagent_send_message`); safety-guard blocks it.
  Launch a new reviewed brief instead.
- Brief review applies only to those two writer agents. Runner, publisher,
  explore and verify briefs never go through it (runner briefs still get the
  self-check above; safety-guard blocks destructive commands at run time); launch the publisher with plain `git`
  and `gh` commands (for example `gh pr merge` per PR, in order, stopping at
  the first failure), never with a wrapper script.
- Review never replaces human authorization for commits, merges, pushes,
  issue or PR edits, or architectural decisions.

### Small diagnosed fixes

- Small = cause and exact change already known (file, line, replacement),
  at most one file and about 20 lines, no new behavior, dependency or design
  decision.
- Use one worker (`gentle-ai-worker-infra` if it needs containers) with the
  exact change and its checks; skip brief review and the separate reviewer
  (the task's final `gentle-ai-verify` covers it) by starting the brief with
  the line `<!-- review: skipped (small fix) -->`. Save to Engram and update
  the task list once, after the fix. If the fix is not small, the worker
  stops and reports; never expand it.

### Search and memory

- Never search `/`, `/mnt` or the home root; scope searches to the repository
  or a known directory.
- For codebase questions, query CodeGraph yourself first; delegate to
  `gentle-ai-explore` only when it cannot answer.
- Only the orchestrator updates Engram (`mem_*`). Workers update only the
  local task file and never look for memory storage on disk.
- During delivery steps (fetch, merge, push, PR, merge of a PR), update
  Engram and the todo list once, when the delivery ends or blocks, not after
  each step.

### Brief content

- Known final content (issue/PR body, file text): write it yourself to a temp
  file outside the repository and give the exact command that applies it;
  subagents never draft text or compose commands.
- Resolve every design choice first: `## Steps` has no "preferred", "may" or
  "if possible". If a choice depends on something unknown, explore or ask.
- If the change breaks or replaces tests or behavior, `## Steps` says what to
  do with each (keep, adapt or remove, with reason); subagents never remove a
  test on their own.
- A brief that changes behavior puts the literal line `Strict TDD is
  active.` at the top of `## Steps`, followed by a RED step that runs the
  new tests before any implementation (exact command, expected non-zero
  exit and the failing tests per rule), then the implementation and GREEN
  steps. Writer definitions treat RED as optional unless that line is
  present; abbreviations such as "RED before behavior" do not activate it.
- End every worker brief's `## Steps` with: "If a step fails for a reason
  this brief does not cover, stop and report it; never change the planned
  design on your own."
- Container/environment work also fixes runtime user and file ownership,
  where generated files live (named volume or bind mount), and which ports
  and resources may be created or removed.
- `## Allowed edit surfaces`: only repository-relative paths or narrow
  globs, one per line, no bullets or prose; restrictions go in `## Steps`.
- Full-diff review: `git diff --stat`, then read each changed file in ranges
  of at most 100 lines (`sed -n '1,100p' <file>`, ...), not the whole `git
  diff` (tool output is compacted per file).
- A delivery that merges into the default branch ends with step and command
  surface `git -C <main checkout> pull --ff-only`, so the main checkout and
  its CodeGraph index match.
- Keep briefs lean: state each fact once (a precondition checked by a
  command is not repeated in prose), copy only the acceptance criteria the
  task verifies, and reuse documented recipes (component READMEs) instead of
  writing new command payloads. Aim for under 3 KB per brief.
- Add a defensive check only when it guards a named risk of this task.
- Batch corrections to the same issue, PR or file into one delegation.
- Inject only the skills the task uses (no commit/PR skills for subagents
  that do not commit or open PRs).
- In pi: run any delivery that pushes in `mode: "task"` (the push guardrail
  asks the human; background dialogs are dismissed).

### Context hygiene

- Read each SKILL.md once per session, when its task starts. Do not read
  subagent definition files; their description is enough.
- Filter JSON tool output to the needed fields (state, findings, next
  command); never print it whole.
- Outside resume (where gentle-pi requires the full task file and
  observation once), read the task file by section or grep, and fetch a full
  Engram observation only when a decision depends on it.

### Model and effort

- Never change a subagent's model or reasoning effort without the user's
  authorization.

### Review tool arguments

- Pass `collectBinding` (`gentle_review_capture`) and each `collectBindings`
  item (`gentle_review_capture_group`) as the exact binding from the latest
  result's `collectBindings`, unchanged: never rebuild, reorder or edit it.
- `gentle_review` START/ASSESS take a plain object in `input`; follow the
  `nextTransition` the previous result returned instead of composing START
  on your own. To assess committed work, pass
  `{"baseRef": "<branch point>", "committedOnly": true}`.

<!-- /user-override: global orchestrator rules -->
