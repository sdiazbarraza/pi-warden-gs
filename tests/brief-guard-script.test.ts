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
  const quoted = run(VALID.replace("one line", "cat '.env.example'"), FORCE, emptyRepo())
  assert.equal(quoted.status, 0, quoted.stderr)
  const bad = run(VALID.replace("one line", "cat .env.local"), FORCE, emptyRepo())
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /\.env file reads/)
})

test("flags .env.example.local reads", () => {
  const bad = run(VALID.replace("one line", "cat .env.example.local"), FORCE, emptyRepo())
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /\.env file reads/)
})

test("flags non-exact env names like backup.env.example", () => {
  const bad = run(VALID.replace("one line", "cat backup.env.example"), FORCE, emptyRepo())
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /\.env file reads/)
})

test("flags a lookalike whose name only ends with .env.example", () => {
  const bad = run(VALID.replace("one line", "cat foo..env.example"), FORCE, emptyRepo())
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /\.env file reads/)
})

test("exempts .env.example per command, not per whole line", () => {
  for (const line of ["cat .env.example; cat .env", "cat .env.example | cat .env", "cat .env.example && cat .env"]) {
    const bad = run(VALID.replace("one line", line), FORCE, emptyRepo())
    assert.equal(bad.status, 2, line)
    assert.match(bad.stderr, /\.env file reads/, line)
  }
  // Only the .env.example token is exempt, so a second .env operand in the same command stays a read.
  const sibling = run(VALID.replace("one line", "cp .env.example .env"), FORCE, emptyRepo())
  assert.equal(sibling.status, 2)
  assert.match(sibling.stderr, /\.env file reads/)
  const ok = run(VALID.replace("one line", "cat .env.example; echo done"), FORCE, emptyRepo())
  assert.equal(ok.status, 0, ok.stderr)
})

test("allows copula prohibition prose for delivery commands", () => {
  for (const line of [
    "git push is forbidden",
    "git push should be avoided",
    "git push must not be allowed",
    "git push remains prohibited",
    "gh pr edit was avoided",
  ]) {
    const ok = run(VALID.replace("one line", line), FORCE, emptyRepo())
    assert.equal(ok.status, 0, `${line}: ${ok.stderr}`)
  }
})

test("keeps real delivery commands blocked when prohibition prose appears elsewhere", () => {
  const brief = VALID.replace("one line", "git push should be avoided\nthen git push origin main")
  const bad = run(brief, FORCE, emptyRepo())
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /must not contain git push/)
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
  const ok2 = run(VALID.replace("one line", "git push is forbidden"), FORCE, emptyRepo())
  assert.equal(ok2.status, 0, ok2.stderr)
})

test("measures size on LF-normalized bytes", () => {
  const core = VALID.replace(/\n$/, "")
  const base = Buffer.byteLength(core, "utf8")
  const under = core.replace("add the flag", "add the flag" + "x".repeat(3071 - base))
  const at = core.replace("add the flag", "add the flag" + "x".repeat(3072 - base))
  assert.equal(run(under, FORCE, emptyRepo()).status, 0, "under 3072 passes")
  assert.equal(run(at, FORCE, emptyRepo()).status, 2, "3072 bytes rejected")
  assert.equal(run(under.replace(/\n/g, "\r\n"), FORCE, emptyRepo()).status, 0, "CRLF under LF limit still passes")
  assert.equal(run(at.replace(/\n/g, "\r\n"), FORCE, emptyRepo()).status, 2, "CRLF keeps the size verdict")
})

test("rejects a 3072-byte brief that ends in a newline", () => {
  const base = Buffer.byteLength(VALID, "utf8")
  const brief = VALID.replace("add the flag", "add the flag" + "x".repeat(3072 - base))
  assert.equal(Buffer.byteLength(brief, "utf8"), 3072)
  assert.equal(run(brief, FORCE, emptyRepo()).status, 2, "trailing newline must not lower the size")
})

const WRAPPERS = ["sudo", "env", "command", "nohup", "nice", "time", "xargs", "doas"]

test("rejects delivery commands and env reads behind wrapper prefixes", () => {
  for (const wrapper of WRAPPERS) {
    for (const line of ["git push origin main", "gh pr create", "cat .env"]) {
      const result = run(VALID.replace("one line", `${wrapper} ${line}`), FORCE, emptyRepo())
      assert.equal(result.status, 2, `${wrapper} ${line}`)
      assert.match(result.stderr, /must not contain git push/, `${wrapper} ${line}`)
    }
  }
})

test("rejects wrapper prefixes that carry their own arguments", () => {
  for (const line of ["sudo -u root git push origin main", "nice -n 5 gh pr merge 1", "xargs -0 cat .env"]) {
    const result = run(VALID.replace("one line", line), FORCE, emptyRepo())
    assert.equal(result.status, 2, line)
    assert.match(result.stderr, /must not contain git push/, line)
  }
})

test("applies negation per command segment, not per line", () => {
  for (const line of [
    "never push; cat .env",
    "do not push; gh pr create",
    "git push should be avoided && cat .env",
    "must not read .env; git push origin main",
    "never push | gh pr edit 1",
  ]) {
    const result = run(VALID.replace("one line", line), FORCE, emptyRepo())
    assert.equal(result.status, 2, line)
    assert.match(result.stderr, /must not contain git push/, line)
  }
})

test("keeps a lone negated segment allowed", () => {
  for (const line of ["never push", "do not push"]) {
    const ok = run(VALID.replace("one line", line), FORCE, emptyRepo())
    assert.equal(ok.status, 0, `${line}: ${ok.stderr}`)
  }
})

test("rejects --env-file forms with a path before .env", () => {
  for (const line of [
    "--env-file=./.env",
    "--env-file config/.env",
    "--env-file=config/.env",
    "dotenv --env-file=config/.env",
    "env --env-file ./.env",
  ]) {
    const result = run(VALID.replace("one line", line), FORCE, emptyRepo())
    assert.equal(result.status, 2, line)
    assert.match(result.stderr, /\.env file reads/, line)
  }
})

test("keeps the .env.example exemption for --env-file path forms", () => {
  for (const line of ["--env-file=./.env.example", "cat .env.example"]) {
    const ok = run(VALID.replace("one line", line), FORCE, emptyRepo())
    assert.equal(ok.status, 0, `${line}: ${ok.stderr}`)
  }
})

test("rejects .env reads inside shell control flow and command substitution", () => {
  for (const line of [
    "for f in .env; do cat $f; done",
    "while read line; do echo $line; done < .env",
    "until cat .env; do :; done",
    "find . -name .env -exec cat {} \\;",
    "xargs -a .env cat",
    'eval "cat .env"',
    "value=$(cat .env)",
    "value=`cat .env`",
  ]) {
    const result = run(VALID.replace("one line", line), FORCE, emptyRepo())
    assert.equal(result.status, 2, line)
    assert.match(result.stderr, /\.env file reads/, line)
  }
})

test("rejects reader commands that expose .env contents", () => {
  for (const cmd of ["strings", "od", "xxd", "hexdump -C", "openssl enc -in", "curl -s", "file", "ls", "bat", "tac", "fold -w 40"]) {
    const result = run(VALID.replace("one line", `${cmd} .env`), FORCE, emptyRepo())
    assert.equal(result.status, 2, cmd)
    assert.match(result.stderr, /\.env file reads/, cmd)
  }
  const dd = run(VALID.replace("one line", "dd if=.env"), FORCE, emptyRepo())
  assert.equal(dd.status, 2, "dd if=.env")
  assert.match(dd.stderr, /\.env file reads/, "dd if=.env")
})

test("rejects nested delivery commands", () => {
  for (const line of [
    "bash -c git push origin main",
    "sh -c 'git push origin main'",
    'zsh -c "git push origin main"',
    "bash -c 'gh pr create'",
    "out=$(git push origin main)",
    "out=`git push origin main`",
  ]) {
    const result = run(VALID.replace("one line", line), FORCE, emptyRepo())
    assert.equal(result.status, 2, line)
    assert.match(result.stderr, /must not contain git push/, line)
  }
})

test("strips a trailing shell comment before detection", () => {
  for (const line of ["cat .env # never read the file", "cat .env # do not run this", "git push origin main # never", "bash -c git push # not allowed"]) {
    const result = run(VALID.replace("one line", line), FORCE, emptyRepo())
    assert.equal(result.status, 2, line)
  }
  const read = run(VALID.replace("one line", "cat .env # never read the file"), FORCE, emptyRepo())
  assert.match(read.stderr, /\.env file reads/, "a comment must not mask a .env read")
  const delivery = run(VALID.replace("one line", "git push origin main # never"), FORCE, emptyRepo())
  assert.match(delivery.stderr, /must not contain git push/, "a comment must not mask a delivery command")
})

test("keeps comment-only and exempt lines passing", () => {
  for (const line of ["echo done # nothing to read", "true # nothing to deliver", "cat .env.example # not the secret .env", "for f in .env.example; do cat $f; done"]) {
    const ok = run(VALID.replace("one line", line), FORCE, emptyRepo())
    assert.equal(ok.status, 0, `${line}: ${ok.stderr}`)
  }
})

test("fails open when the hook input cannot be parsed", () => {
  const result = spawnSync(SCRIPT, [], { input: "not json", encoding: "utf8", env: { ...process.env, ...FORCE } })
  assert.equal(result.status, 0, result.stderr)
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
