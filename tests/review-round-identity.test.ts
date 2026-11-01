// The round identity is the worktree the reviewer launch declares on its first line.
// These probes cover the edges the cap can be escaped through: the declaration inside
// the brief, inside the previous findings, inside the context, a later line, an alias,
// a case variant, a unicode path, and a rejected launch that must not burn a round.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import guard, { declaredReviewScope, declaredWorktree, roundIdentity } from "../extensions/safety-guard.ts"

const CONTRACT_BRIEF = `## Objective
Do it

## Preconditions
On expected branch feat/example; HEAD is that tip; tree is clean (git status --short).

## Steps
1. do it
If a step fails for a reason this brief does not cover, stop and report it; never change the planned design on your own.

## Allowed edit surfaces
src/a.ts

## Verification
node --test tests/safety-guard.test.ts

## Acceptance criteria
it works

## Architecture constraints
none

## Report
one line
`

const wtRoot = mkdtempSync(join(tmpdir(), "pi-warden-gs-wt-"))
const worktree = (name: string) => {
  const path = join(wtRoot, name)
  mkdirSync(path, { recursive: true })
  return path
}
const WT_A = worktree("a")
const WT_B = worktree("b")
const WT_UNICODE = worktree("trabajo-ñ-日本")
const WT_LINK = join(wtRoot, "link-to-a")
symlinkSync(WT_A, WT_LINK)

type Handler = (event: any, ctx: any) => any
function setup() {
  const handlers = new Map<string, Handler[]>()
  const entries: Array<{ type: "custom"; customType: string; data: any }> = []
  const pi = {
    on: (name: string, h: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), h])
    },
    appendEntry: (customType: string, data: any) => {
      entries.push({ type: "custom", customType, data })
    },
  }
  const cwd = mkdtempSync(join(tmpdir(), "pi-warden-gs-"))
  const ctx = { cwd, sessionManager: { getBranch: () => entries } }
  guard(pi as any, false, false)
  const fire = async (name: string, event: any) => {
    let out: any
    for (const h of handlers.get(name) ?? []) out = (await h(event, ctx)) ?? out
    return out
  }
  return { fire, entries }
}

const call = (id: string, input: any) => ({ type: "tool_call", toolName: "subagent_run", toolCallId: id, input })
const result = (id: string, input: any, text: string, isError = false) => ({
  type: "tool_result",
  toolName: "subagent_run",
  toolCallId: id,
  input,
  isError,
  content: [{ type: "text", text }],
})
const FIX_RESULT = 'Subagent gentle-ai-brief-review (task r1, "x") finished.\n\n- [IMPORTANTE] x\nVERDICT: FIX'
const APPROVE_RESULT = 'Subagent gentle-ai-brief-review (task r1, "x") finished.\n\nok\nVERDICT: APPROVE'
const marked = (body: string) => `<<<BRIEF\n${body}\nBRIEF>>>`
const reviewTask = (worktreePath: string, body: string, scope = "") =>
  `worktree: ${worktreePath}${scope}\n${body}`
const reviewLaunch = (id: string, worktreePath: string, body: string) =>
  call(id, { agent: "gentle-ai-brief-review", mode: "task", task: reviewTask(worktreePath, body) })
const roundsOf = (entries: Array<{ customType: string }>) =>
  entries.filter((e) => e.customType === "pi-warden-gs.review-round").length

test("a declaration only in the context buys no round and no launch", async () => {
  const { fire, entries } = setup()
  const out = await fire(
    "tool_call",
    call("c1", { agent: "gentle-ai-brief-review", mode: "task", task: marked(CONTRACT_BRIEF), context: `worktree: ${WT_A}` }),
  )
  assert.equal(out?.block, true)
  assert.match(out.reason, /first line/)
  assert.equal(roundsOf(entries), 0)
})

test("a declaration on a later line is not a declaration", () => {
  assert.equal(declaredWorktree(`Review the brief.\nworktree: ${WT_A}`), null)
  assert.equal(declaredWorktree(`worktree: ${WT_A}\nworktree: ${WT_B}`), WT_A, "only the first line declares")
  assert.equal(declaredWorktree(`worktree:\n${WT_A}`), null, "a newline cannot smuggle a path")
})

test("spaces, tabs and CRLF around the declared path keep the identity", () => {
  const base = roundIdentity(reviewTask(WT_A, marked(CONTRACT_BRIEF)))
  assert.equal(roundIdentity(`worktree: ${WT_A}   \n${marked(CONTRACT_BRIEF)}`), base)
  assert.equal(roundIdentity(`worktree:\t${WT_A}\n${marked(CONTRACT_BRIEF)}`), base)
  assert.equal(roundIdentity(`worktree: ${WT_A}\r\n${marked(CONTRACT_BRIEF)}`), base)
})

test("a case variant that does not exist is no declaration", () => {
  assert.notEqual(WT_A.toUpperCase(), WT_A)
  assert.equal(declaredWorktree(reviewTask(WT_A.toUpperCase(), marked(CONTRACT_BRIEF))), null)
})

test("a unicode worktree is a real declaration and caps like any other", async () => {
  assert.notEqual(roundIdentity(reviewTask(WT_UNICODE, marked(CONTRACT_BRIEF))), null)
  const { fire } = setup()
  for (let round = 1; round <= 3; round++) {
    const launch = reviewLaunch(`u${round}`, WT_UNICODE, marked(`${CONTRACT_BRIEF}u${round}`))
    assert.equal((await fire("tool_call", launch))?.block, undefined, `round ${round}`)
    await fire("tool_result", result(`u${round}`, launch.input, FIX_RESULT))
  }
  const fourth = await fire("tool_call", reviewLaunch("u4", WT_UNICODE, marked(CONTRACT_BRIEF)))
  assert.equal(fourth?.block, true)
})

test("a symlink alias of the worktree is the same identity", async () => {
  const { fire } = setup()
  for (let round = 1; round <= 3; round++) {
    const launch = reviewLaunch(`l${round}`, round === 1 ? WT_A : WT_LINK, marked(`${CONTRACT_BRIEF}l${round}`))
    assert.equal((await fire("tool_call", launch))?.block, undefined, `round ${round}`)
    await fire("tool_result", result(`l${round}`, launch.input, FIX_RESULT))
  }
  const fourth = await fire("tool_call", reviewLaunch("l4", WT_LINK, marked(CONTRACT_BRIEF)))
  assert.equal(fourth?.block, true, "an alias must not buy a fourth round")
})

test("a launch rejected before the cap burns no round", async () => {
  const { fire, entries } = setup()
  const malformed = "## Objective\nonly one heading\n"
  const rejected = await fire("tool_call", reviewLaunch("bad", WT_A, marked(malformed)))
  assert.equal(rejected?.block, true)
  assert.match(rejected.reason, /brief-guard/)
  assert.equal(roundsOf(entries), 0)
  assert.equal((await fire("tool_call", reviewLaunch("ok", WT_A, marked(CONTRACT_BRIEF))))?.block, undefined)
})

test("the documented flow: a declared worktree reviews, approves and dispatches once", async () => {
  const { fire, entries } = setup()
  const launch = reviewLaunch("d1", WT_A, marked(CONTRACT_BRIEF))
  assert.equal((await fire("tool_call", launch))?.block, undefined)
  await fire("tool_result", result("d1", launch.input, APPROVE_RESULT))
  assert.equal(entries.filter((e) => e.customType === "pi-warden-gs.brief-approval").length, 1)
  const worker = { agent: "gentle-ai-worker", mode: "task", task: CONTRACT_BRIEF }
  assert.equal((await fire("tool_call", call("w1", worker)))?.block, undefined)
  const second = await fire("tool_call", call("w2", worker))
  assert.equal(second?.block, true)
  assert.match(second.reason, /brief not approved/)
})

test("sibling subissues of one worktree have separate budgets", async () => {
  const { fire } = setup()
  for (let round = 1; round <= 3; round++) {
    const launch = call(`s${round}`, {
      agent: "gentle-ai-brief-review",
      mode: "task",
      task: reviewTask(WT_A, marked(`${CONTRACT_BRIEF}s${round}`), " issue: 42 subissue: 12"),
    })
    assert.equal((await fire("tool_call", launch))?.block, undefined, `round ${round}`)
    await fire("tool_result", result(`s${round}`, launch.input, FIX_RESULT))
  }
  const capped = call("s4", {
    agent: "gentle-ai-brief-review",
    mode: "task",
    task: reviewTask(WT_A, marked(CONTRACT_BRIEF), " issue: 42 subissue: 12"),
  })
  assert.equal((await fire("tool_call", capped))?.block, true, "the same subissue stops at three")

  const sibling = call("s5", {
    agent: "gentle-ai-brief-review",
    mode: "task",
    task: reviewTask(WT_A, marked(CONTRACT_BRIEF), " issue: 42 subissue: 13"),
  })
  assert.equal((await fire("tool_call", sibling))?.block, undefined, "a sibling subissue starts fresh")
})

test("the declaration reads worktree, issue and subissue, and falls back in that order", () => {
  const full = declaredReviewScope(reviewTask(WT_A, marked(CONTRACT_BRIEF), " issue: 42 subissue: 12"))
  assert.deepEqual(full, { worktree: WT_A, issue: "42", subissue: "12" })

  const issueOnly = declaredReviewScope(reviewTask(WT_A, marked(CONTRACT_BRIEF), " issue: 42"))
  assert.deepEqual(issueOnly, { worktree: WT_A, issue: "42", subissue: null })
  assert.notEqual(roundIdentity(reviewTask(WT_A, marked(CONTRACT_BRIEF), " issue: 42")), roundIdentity(reviewTask(WT_A, marked(CONTRACT_BRIEF), " issue: 43")))

  const worktreeOnly = declaredReviewScope(reviewTask(WT_A, marked(CONTRACT_BRIEF)))
  assert.deepEqual(worktreeOnly, { worktree: WT_A, issue: null, subissue: null })
  assert.equal(roundIdentity(reviewTask(WT_A, marked(CONTRACT_BRIEF))), roundIdentity(reviewTask(WT_A, marked(`${CONTRACT_BRIEF}v2`))))
})

test("a worktree path with spaces is one declaration", () => {
  const spaced = worktree("repo con espacios")
  const scope = declaredReviewScope(reviewTask(spaced, marked(CONTRACT_BRIEF), " issue: 7 subissue: 2"))
  assert.deepEqual(scope, { worktree: spaced, issue: "7", subissue: "2" })
  assert.equal(roundIdentity(reviewTask(spaced, marked(CONTRACT_BRIEF), " issue: 7 subissue: 2")), roundIdentity(reviewTask(spaced, marked(`${CONTRACT_BRIEF}v2`), " issue: 7 subissue: 2")))
})
