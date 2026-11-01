import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const REVIEWER = readFileSync(new URL("../pi/agents/gentle-ai-brief-review.md", import.meta.url), "utf8")
const CLAUDE_REVIEWER = readFileSync(new URL("../claude/agents/gentle-ai-brief-review.md", import.meta.url), "utf8")
const OVERRIDE = readFileSync(new URL("../pi/APPEND_SYSTEM.md", import.meta.url), "utf8")

test("reviewer definition asks for every previous finding to be classified", () => {
  assert.match(REVIEWER, /previous findings/i)
  for (const label of ["CLOSED", "OPEN", "NEW"]) assert.match(REVIEWER, new RegExp(`\\b${label}\\b`))
})

test("the Claude reviewer carries the same classification rule", () => {
  assert.match(CLAUDE_REVIEWER, /previous findings/i)
  for (const label of ["CLOSED", "OPEN", "NEW"]) assert.match(CLAUDE_REVIEWER, new RegExp(`\\b${label}\\b`))
})

test("reviewer definition keeps a repeated OPEN finding blocking", () => {
  assert.match(REVIEWER, /OPEN[^\n]*block/i)
})

test("override fixes every finding in one pass and caps review rounds", () => {
  assert.match(OVERRIDE, /every finding/i)
  assert.match(OVERRIDE, /one pass/i)
  assert.match(OVERRIDE, /three reviews/)
  assert.match(OVERRIDE, /safety-guard blocks the fourth launch/i)
  assert.match(OVERRIDE, /worktree: <absolute path>/)
  assert.match(OVERRIDE, /round identity/)
})
