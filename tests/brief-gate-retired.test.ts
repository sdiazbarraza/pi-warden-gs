// The brief-review gate was retired in 3.0.0: the reviewer agent, the structural script, the
// approvals library and both runtime branches are gone. These assertions pin the removal, so a
// later change cannot bring the gate back by accident.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dirname, "..")

const RETIRED = [
  "hooks/brief-guard.sh",
  "claude/hooks/brief-approval.mjs",
  "claude/hooks/lib/approvals.mjs",
  "pi/agents/gentle-ai-brief-review.md",
  "claude/agents/gentle-ai-brief-review.md",
]

test("the brief-review assets are gone from both runtimes", () => {
  for (const rel of RETIRED) {
    assert.equal(existsSync(join(ROOT, rel)), false, `${rel} still exists`)
  }
})

test("the Pi extension exports no brief API", async () => {
  const guard: Record<string, unknown> = await import("../extensions/safety-guard.ts")
  for (const name of [
    "briefRejection",
    "writerBriefKey",
    "parseVerdict",
    "declaredReviewScope",
    "hasHumanApproval",
    "roundIdentity",
    "ApprovalStore",
    "ReviewRounds",
    "WriterTasks",
    "MAX_REVIEW_ROUNDS",
    "MAX_REVIEW_REFUNDS",
  ]) {
    assert.equal(name in guard, false, `${name} is still exported`)
  }
})

test("the Claude hook module exports no brief handler", async () => {
  const hook: Record<string, unknown> = await import("../claude/hooks/safety-guard.mjs")
  for (const name of ["briefRejection", "extractMarkedBrief", "parseVerdict", "isSmallFixExempt"]) {
    assert.equal(name in hook, false, `${name} is still exported`)
  }
  assert.equal(typeof hook.handleAgent, "undefined", "handleAgent is still exported")
})

test("the shipped Claude hook registration names no brief script", () => {
  const settings = readFileSync(join(ROOT, "claude", "claude-settings.jq"), "utf8")
  assert.doesNotMatch(settings, /brief-guard|brief-approval/)
})

test("no model profile routes the retired reviewer", () => {
  for (const profile of ["deepseek", "deepseek-minimax", "go-minimax", "gpt", "opencode-go", "plan-minimax-m3"]) {
    const raw = readFileSync(join(ROOT, "pi", "profiles", `${profile}.json`), "utf8")
    assert.doesNotMatch(raw, /gentle-ai-brief-review/, `${profile} still routes the reviewer`)
  }
})
