import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"

const AGENTS_DIR = join(import.meta.dirname, "..", "claude", "agents")

const AGENT_FILES = [
  "gentle-ai-runner.md",
  "gentle-ai-worker-infra.md",
  "gentle-ai-publisher.md",
  "gentle-ai-brief-review.md",
  "gentle-ai-prompt-refine.md",
]

const PUBLISHER_MARKER = "<!-- pi-warden-gs:agent=gentle-ai-publisher -->"

const CLAUDE_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Agent",
  "SendMessage",
  "TodoWrite",
  "NotebookEdit",
  "AskUserQuestion",
  "Skill",
])

// Pi tool names. A bare one of these must never survive as a tool token.
const PI_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "edit",
  "write",
  "bash",
  "mem_save",
  "mem_search",
  "mem_get_observation",
  "mcp",
]

// Pi-only vocabulary that must not survive anywhere in a ported file.
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

const MCP_TOOL = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/

type Frontmatter = { data: Record<string, string>; body: string }

function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text)
  assert.ok(match, "the file must start with a YAML frontmatter block")
  const data: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === "") continue
    const colon = line.indexOf(":")
    assert.ok(colon > 0, `frontmatter lines must be "key: value", got: ${line}`)
    const key = line.slice(0, colon).trim()
    assert.ok(!(key in data), `frontmatter key must be unique, got: ${key}`)
    data[key] = line.slice(colon + 1).trim()
  }
  return { data, body: text.slice(match[0].length) }
}

function read(file: string): string {
  const path = join(AGENTS_DIR, file)
  assert.ok(existsSync(path), `missing agent definition: claude/agents/${file}`)
  return readFileSync(path, "utf8")
}

for (const file of AGENT_FILES) {
  test(`${file}: exists, with a valid Claude Code frontmatter`, () => {
    const text = read(file)
    const { data } = parseFrontmatter(text)

    assert.equal(data.name, basename(file, ".md"), "name must equal the file basename")
    assert.ok(data.description && data.description.length > 0, "description must not be empty")
    assert.equal(data.model, "inherit", "model must ship as inherit")
    assert.ok(!("thinking" in data), "the Pi-only thinking key must be dropped")
  })

  test(`${file}: tools are Claude Code tool names`, () => {
    const { data } = parseFrontmatter(read(file))
    assert.ok(data.tools !== undefined, "tools must be declared")
    const tokens = data.tools
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "")
    assert.ok(tokens.length > 0, "tools must not be empty")

    for (const token of tokens) {
      assert.ok(
        CLAUDE_TOOLS.has(token) || MCP_TOOL.test(token),
        `unknown tool name: ${token}`,
      )
      assert.ok(!PI_TOOL_NAMES.includes(token), `Pi-only tool name survived: ${token}`)
    }
  })

  test(`${file}: no Pi-only vocabulary survives`, () => {
    const text = read(file)
    for (const word of PI_ONLY_VOCABULARY) {
      assert.ok(!text.includes(word), `Pi-only vocabulary survived: ${word}`)
    }
  })
}

test("the publisher definition carries the delivery-gate marker", () => {
  const { body } = parseFrontmatter(read("gentle-ai-publisher.md"))
  const lines = body.split(/\r?\n/).map((l) => l.trim())
  assert.ok(lines.includes(PUBLISHER_MARKER), "the publisher marker must be on its own line")
})

test("no other agent definition carries the publisher marker", () => {
  for (const file of AGENT_FILES.filter((f) => f !== "gentle-ai-publisher.md")) {
    const { body } = parseFrontmatter(read(file))
    assert.ok(!body.includes(PUBLISHER_MARKER), `${file} must not carry the publisher marker`)
  }
})
