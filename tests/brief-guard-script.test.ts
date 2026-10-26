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

test("rejects edit surfaces with traversal or broad globs", () => {
  for (const surf of ["../outside.txt", "**", "src/../a.ts"]) {
    const result = run(VALID.replace("hooks/brief-guard.sh", surf), FORCE, emptyRepo())
    assert.equal(result.status, 2, surf)
    assert.match(result.stderr, /not a repository-relative path or narrow glob/)
  }
})

test("rejects git -c forms of push", () => {
  const result = run(VALID.replace("one line", "then git -c core.hooksPath=/tmp push origin main"), FORCE, emptyRepo())
  assert.equal(result.status, 2)
  assert.match(result.stderr, /must not contain git push/)
})

test("rejects quoted export command substitution in Verification", () => {
  const brief = VALID.replace(
    "node --test tests/brief-guard-script.test.ts",
    "export OUT=\"$(node --test tests/brief-guard-script.test.ts)\"",
  )
  const result = run(brief, FORCE, emptyRepo())
  assert.equal(result.status, 2)
  assert.match(result.stderr, /must not hide failures/)
})

test("allows .env.example and rejects .env.local reads", () => {
  const ok = run(VALID.replace("one line", "cat .env.example"), FORCE, emptyRepo())
  assert.equal(ok.status, 0, ok.stderr)
  const bad = run(VALID.replace("one line", "cat .env.local"), FORCE, emptyRepo())
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /\.env file reads/)
})

test("flags .env.example.local reads", () => {
  const bad = run(VALID.replace("one line", "cat .env.example.local"), FORCE, emptyRepo())
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /\.env file reads/)
})

test("allows prose mentions of env files and unrelated .environment", () => {
  const ok1 = run(VALID.replace("one line", "must not read .env"), FORCE, emptyRepo())
  assert.equal(ok1.status, 0, ok1.stderr)
  const ok2 = run(VALID.replace("one line", "update .environment config"), FORCE, emptyRepo())
  assert.equal(ok2.status, 0, ok2.stderr)
})

test("allows prose delivery mentions", () => {
  const ok = run(VALID.replace("one line", "do not run git push"), FORCE, emptyRepo())
  assert.equal(ok.status, 0, ok.stderr)
})

test("measures size on LF-normalized bytes", () => {
  const core = VALID.replace(/\n$/, "")
  const base = Buffer.byteLength(core, "utf8")
  const under = core.replace("add the flag", "add the flag" + "x".repeat(3071 - base))
  const at = core.replace("add the flag", "add the flag" + "x".repeat(3072 - base))
  assert.equal(run(under, FORCE, emptyRepo()).status, 0, "under 3072 passes")
  assert.equal(run(at, FORCE, emptyRepo()).status, 2, "3072 bytes rejected")
  assert.equal(run(at.replace(/\n/g, "\r\n"), FORCE, emptyRepo()).status, 2, "CRLF keeps the size verdict")
})

test("rejects a 3072-byte brief that ends in a newline", () => {
  const base = Buffer.byteLength(VALID, "utf8")
  const brief = VALID.replace("add the flag", "add the flag" + "x".repeat(3072 - base))
  assert.equal(Buffer.byteLength(brief, "utf8"), 3072)
  assert.equal(run(brief, FORCE, emptyRepo()).status, 2, "trailing newline must not lower the size")
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
