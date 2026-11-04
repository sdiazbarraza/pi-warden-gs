<!-- user-override: global orchestrator rules -->

## User overrides (all projects)

Persistent overrides outside `node_modules/`; they survive updates of the tool
that installs them. Project rules belong in each project's `CLAUDE.md`.

### Roles

- `gentle-ai-runner`: command-only tasks with no repository edits (`gh`,
  `curl`, read-only `docker exec`, `psql -c "SELECT ..."`, `redis-cli GET`,
  inspection). Never give it repository writes or investigation; route
  investigation to `gentle-ai-explore`.
- Run short read-only commands yourself (`git status/log/diff --stat`,
  `gh issue|pr view`, `ls`, `cat`) with bounded output and inline exit codes;
  use the runner only for Docker, long-running or state-changing commands.
- `git push` and `gh pr create|merge|edit` run only through
  `gentle-ai-publisher` (foreground Agent launch, exact commands, human
  authorization). This overrides the default agent table that runs `git`/`gh`
  inline; safety-guard blocks those commands everywhere else.
- Builds, test runs and container runs (`backend/scripts/dotnet-in-docker.sh`,
  `docker run|build|exec`, `docker compose up|run|build|exec`) run only in
  a subagent: delegate them with the Agent tool to `gentle-ai-runner`, or
  `gentle-ai-worker-infra` when files change too. safety-guard blocks them in
  the orchestrator; if the subagent is unavailable, stop and tell the human.
- In Claude Code: work that writes Dockerfiles, Compose files or environment
  configuration, or runs containers to verify them, goes to
  `gentle-ai-worker-infra` (same task format; it carries fixed Docker and
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
- Append to a task file (`odd/tasks/*.md`) with the `Edit` tool in one call:
  replace its last line with that line plus the new entries. Never use
  temporary scripts, renumbering passes or `git checkout`/`git restore` to
  redo it; if the edit fails, report the error instead.
- Before relaunching a worker to correct a task, snapshot locally: `git add
  -A && git commit -m "chore(wip): snapshot before <task> correction"`. Never
  push WIP commits; before the closing commit, fold them with `git reset
  --soft <task base>` into one Conventional Commit.

### Prompt refinement

- When a human message requests new work or changes direction (implement,
  correct, investigate, review, deliver), first launch `gentle-ai-prompt-refine`
  with the Agent tool as a foreground launch, passing the verbatim message, the
  repository or worktree path, and the issue number and task document when known.
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
  and keep the observation ID for the issue that carries the task.

### Issues as the spec

A task is specified by its GitHub issue, not by a brief. The parent issue carries `## Specs`
(numbered `S#` that quote the human's exact words) and `## Tasks`, where each task is one subissue.
The subissue carries the objective, its acceptance criteria as verifiable checkboxes, the allowed
edit surfaces and the verification commands.
Everything the retired brief review checked is an acceptance criterion now: the eight sections in
order, the size, the strict-test-first line, the banned words, the preconditions, the narrow edit
surfaces and the commands that cannot hide a failure.
`pi-issue-spec-gs` ships the protocol, the issue templates and a linter you run by hand; nothing
blocks a launch.

### Small diagnosed fixes

- Small = cause and exact change already known (file, line, replacement),
  at most one file and about 20 lines, no new behavior, dependency or design
  decision.
- Use one worker agent (`gentle-ai-worker-infra` if it needs containers),
  launched with the Agent tool, with the exact change and its checks; the
  task's final `gentle-ai-verify` covers it, so nothing reviews anything
  before the launch. Save to Engram and update the task list once, after the
  fix. If the fix is not small, the worker stops and reports; never expand
  it.

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

### Context hygiene

- Read each SKILL.md once per session, when its task starts. Do not read
  subagent definition files; their description is enough.
- Filter JSON tool output to the needed fields (state, findings, next
  command); never print it whole.
- Outside resume (where Claude Code requires the full task file and
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
