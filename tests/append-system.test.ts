import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const FILE = join(import.meta.dirname, "..", "claude", "APPEND_SYSTEM.md")

const OVERRIDE_OPEN = "<!-- user-override: global orchestrator rules -->"
const OVERRIDE_CLOSE = "<!-- /user-override: global orchestrator rules -->"

const REQUIRED_SECTIONS = [
  "Roles",
  "Verification",
  "Prompt refinement",
  "Brief review",
  "Small diagnosed fixes",
  "Search and memory",
  "Brief content",
  "Context hygiene",
  "Model and effort",
  "Review tool arguments",
]

// The structural contract enforced by hooks/brief-guard.sh, in order.
const BRIEF_SECTIONS = [
  "Objective",
  "Preconditions",
  "Steps",
  "Allowed edit surfaces",
  "Verification",
  "Acceptance criteria",
  "Architecture constraints",
  "Report",
]

const STOP_AND_REPORT =
  "If a step fails for a reason this brief does not cover, stop and report it; never change the planned design on your own."

const PI_ONLY_VOCABULARY = [
  "subagent_run",
  "subagent_continue",
  "subagent_send_message",
  "AGENTS.md",
  "gentle-pi",
  'mode: "task"',
  'mode "task"',
  "provider/model",
]

function read(): string {
  assert.ok(existsSync(FILE), "missing claude/APPEND_SYSTEM.md")
  return readFileSync(FILE, "utf8")
}

test("the global prompt exists and keeps the user-override markers", () => {
  const text = read()
  assert.ok(text.includes(OVERRIDE_OPEN), "missing the opening user-override marker")
  assert.ok(text.includes(OVERRIDE_CLOSE), "missing the closing user-override marker")
  assert.ok(text.trimStart().startsWith(OVERRIDE_OPEN), "the opening marker must come first")
})

test("the global prompt keeps every required section", () => {
  const text = read()
  for (const section of REQUIRED_SECTIONS) {
    assert.ok(text.includes(`### ${section}`), `missing section: ${section}`)
  }
})

test("the global prompt keeps the load-bearing strings verbatim", () => {
  const text = read()
  assert.ok(text.includes("<<<BRIEF"), "missing the <<<BRIEF marker")
  assert.ok(text.includes("BRIEF>>>"), "missing the BRIEF>>> marker")
  assert.ok(
    text.includes("<!-- review: skipped (small fix) -->"),
    "missing the small-fix skip marker",
  )
  assert.ok(text.includes("Strict TDD is active."), "missing the Strict TDD line")
  assert.ok(text.includes(STOP_AND_REPORT), "missing the stop-and-report clause")
})

test("the global prompt keeps the eight brief sections in order", () => {
  const text = read()
  const pattern = BRIEF_SECTIONS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(
    "[^A-Za-z]+",
  )
  assert.match(text, new RegExp(pattern), "the eight brief sections must appear in order")
})

test("the global prompt does not restate the reply-length policy", () => {
  const text = read()
  assert.ok(
    !/at most 5 lines/i.test(text),
    "the reply-length policy lives only in the reply-length hook",
  )
})

test("the global prompt carries no Pi-only vocabulary", () => {
  const text = read()
  for (const word of PI_ONLY_VOCABULARY) {
    assert.ok(!text.includes(word), `Pi-only vocabulary survived: ${word}`)
  }
})
