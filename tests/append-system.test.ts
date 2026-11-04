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
  "Issues as the spec",
  "Small diagnosed fixes",
  "Search and memory",
  "Context hygiene",
  "Model and effort",
  "Review tool arguments",
]

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

test("the global prompt replaces the brief review with the issue contract", () => {
  const text = read()
  assert.ok(text.includes("### Issues as the spec"), "missing the issue-as-spec section")
  assert.ok(text.includes("## Specs"), "missing the parent-issue Specs section")
  assert.ok(text.includes("## Tasks"), "missing the parent-issue Tasks section")
  assert.ok(text.includes("one subissue"), "the tasks must be subissues")
  assert.ok(text.includes("acceptance criteria"), "missing the acceptance criteria")
  assert.ok(text.includes("pi-issue-spec-gs"), "the prompt must name the protocol package")
  assert.ok(!text.includes("<<<BRIEF"), "the retired brief markers survived")
  assert.ok(!text.includes("gentle-ai-brief-review"), "the retired reviewer survived")
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
