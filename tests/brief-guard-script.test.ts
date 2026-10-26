import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const SCRIPT = join(import.meta.dirname, "..", "hooks", "brief-guard.sh")

const VALID = `## Objective
add the flag

## Preconditions
On expected branch feat/example; HEAD is that tip; tree is clean (git status --short).

## Steps
1. edit the guard
If a step fails for a reason this brief does not cover, stop and report it; never change the planned design on your own.

## Allowed edit surfaces
hooks/brief-guard.sh

## Verification
node --test tests/brief-guard-script.test.ts

## Acceptance criteria
flag honored

## Architecture constraints
none

## Report
one line
`

function run(brief: string, env: Record<string, string | undefined>, cwd: string, agent = "gentle-ai-worker") {
  return spawnSync(SCRIPT, [], {
    input: JSON.stringify({ cwd, tool_input: { subagent_type: agent, prompt: brief } }),
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
}

function emptyRepo() {
  return mkdtempSync(join(tmpdir(), "brief-guard-"))
}

test("passes a structurally valid writer brief when the caller forces the check", () => {
  const result = run(VALID, { BRIEF_GUARD_FORCE_STRUCTURE: "1" }, emptyRepo())
  assert.equal(result.status, 0, result.stderr)
})

test("rejects a forced writer brief that misses a required section", () => {
  const brief = VALID.replace(/## Verification\nnode --test[^\n]*\n\n/, "")
  const result = run(brief, { BRIEF_GUARD_FORCE_STRUCTURE: "1" }, emptyRepo())
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Verification/)
})

test("rejects a forced writer brief whose Steps lacks the stop-and-report clause", () => {
  const brief = VALID.replace(/If a step fails for a reason this brief does not cover, stop and report it; never change the planned design on your own\.\n/, "2. done\n")
  const result = run(brief, { BRIEF_GUARD_FORCE_STRUCTURE: "1" }, emptyRepo())
  assert.equal(result.status, 2)
  assert.match(result.stderr, /stop and report it/)
})

test("ignores non-writer agents even when the check is forced", () => {
  const result = run("no headings here", { BRIEF_GUARD_FORCE_STRUCTURE: "1" }, emptyRepo(), "gentle-ai-explore")
  assert.equal(result.status, 0)
})

const FORCE = { BRIEF_GUARD_FORCE_STRUCTURE: "1" }

test("rejects every delivery-command form a brief can carry", () => {
  for (const line of ["git -C /repo push origin main", "git  push origin main", "gh -R o/r pr create", "gh pr  merge 1"]) {
    const result = run(VALID.replace("one line", `then ${line}`), FORCE, emptyRepo())
    assert.equal(result.status, 2, line)
    assert.match(result.stderr, /must not contain git push/)
  }
})

test("accepts Preconditions that label branch\/HEAD with capitals", () => {
  const brief = VALID.replace(
    "On expected branch feat/example; HEAD is that tip; tree is clean (git status --short).",
    "Branch: feat/example; Head: abc123; tree clean via Git Status --short.",
  )
  assert.equal(run(brief, FORCE, emptyRepo()).status, 0)
})

test("keeps the repository trigger when no caller forces the check", () => {
  const cwd = emptyRepo()
  const malformed = "## Objective\nonly one heading\n"
  assert.equal(run(malformed, {}, cwd).status, 0, "a non-git cwd has no repository trigger")
  spawnSync("git", ["init", "-q", cwd])
  assert.equal(run(malformed, {}, cwd).status, 0, "no AGENTS.md trigger means no structural check")
  writeFileSync(join(cwd, "AGENTS.md"), "### Brief del subagente\n")
  assert.equal(run(malformed, {}, cwd).status, 2, "the repository trigger still applies")
})
