// The file-backed approval store — Claude Code has no session-entry API for hooks,
// so approvals live in a JSON file that survives reload, resume and a new session.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import {
  add,
  approvalsPath,
  consume,
  has,
  normalizeBrief,
  readStore,
  sha256,
} from "../claude/hooks/lib/approvals.mjs"

const LIB = pathToFileURL(join(import.meta.dirname, "..", "claude", "hooks", "lib", "approvals.mjs")).href

function withStateDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "claude-approvals-"))
  const previous = process.env.CLAUDE_WARDEN_STATE_DIR
  process.env.CLAUDE_WARDEN_STATE_DIR = dir
  try {
    return fn(dir)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_WARDEN_STATE_DIR
    else process.env.CLAUDE_WARDEN_STATE_DIR = previous
  }
}

test("the store lives in the state dir when it is set", () => {
  withStateDir((dir) => {
    assert.equal(approvalsPath(), join(dir, "approvals.json"))
  })
})

test("the store falls back to ~/.claude/.warden", () => {
  const previous = process.env.CLAUDE_WARDEN_STATE_DIR
  delete process.env.CLAUDE_WARDEN_STATE_DIR
  try {
    assert.equal(approvalsPath(), join(process.env.HOME ?? "/root", ".claude", ".warden", "approvals.json"))
  } finally {
    if (previous !== undefined) process.env.CLAUDE_WARDEN_STATE_DIR = previous
  }
})

test("an approval is consumed once and only once", () => {
  withStateDir(() => {
    const hash = sha256("brief")
    add(hash, "sess-1")
    assert.equal(has(hash, "sess-1"), true)
    assert.equal(consume(hash, "sess-1"), true)
    assert.equal(consume(hash, "sess-1"), false)
    assert.equal(has(hash, "sess-1"), false)
  })
})

test("an approval of one session does not leak into another", () => {
  withStateDir(() => {
    const hash = sha256("brief")
    add(hash, "sess-1")
    assert.equal(has(hash, "sess-2"), false)
    assert.equal(consume(hash, "sess-2"), false)
    assert.equal(has(hash, "sess-1"), true)
  })
})

test("the store creates its directory on demand", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "claude-approvals-")), "nested", "state")
  const previous = process.env.CLAUDE_WARDEN_STATE_DIR
  process.env.CLAUDE_WARDEN_STATE_DIR = dir
  try {
    add(sha256("brief"), "sess-1")
    assert.equal(readFileSync(join(dir, "approvals.json"), "utf8").length > 0, true)
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_WARDEN_STATE_DIR
    else process.env.CLAUDE_WARDEN_STATE_DIR = previous
  }
})

test("the store survives a corrupt file", () => {
  withStateDir((dir) => {
    writeFileSync(join(dir, "approvals.json"), "{not json")
    add(sha256("brief"), "sess-1")
    assert.equal(has(sha256("brief"), "sess-1"), true)
  })
})

test("the approved list of a session is capped", () => {
  withStateDir(() => {
    for (let i = 0; i < 60; i++) add(sha256(`brief-${i}`), "sess-1")
    const store = readStore()
    assert.equal(store.sessions["sess-1"].approved.length, 50)
    // The most recent approvals survive; the oldest are dropped.
    assert.equal(store.sessions["sess-1"].approved.includes(sha256("brief-59")), true)
    assert.equal(store.sessions["sess-1"].approved.includes(sha256("brief-0")), false)
  })
})

test("old sessions are dropped when the file is rewritten", () => {
  withStateDir(() => {
    for (let i = 0; i < 12; i++) add(sha256(`brief-${i}`), `sess-${i}`)
    const store = readStore()
    assert.equal(Object.keys(store.sessions).length, 10)
    assert.equal(store.sessions["sess-11"] !== undefined, true)
    assert.equal(store.sessions["sess-0"] === undefined, true)
  })
})

test("the file is valid JSON after concurrent writers", () => {
  withStateDir((dir) => {
    const helper = join(dir, "add.mjs")
    writeFileSync(
      helper,
      `import { add } from ${JSON.stringify(LIB)}\nadd(process.argv[2], process.argv[3])\n`,
    )
    const writers = Array.from({ length: 8 }, (_, i) =>
      spawnSync(process.execPath, [helper, sha256(`brief-${i}`), "sess-1"], {
        encoding: "utf8",
        env: { ...process.env, CLAUDE_WARDEN_STATE_DIR: dir },
      }),
    )
    for (const writer of writers) assert.equal(writer.status, 0, writer.stderr)
    const store = JSON.parse(readFileSync(join(dir, "approvals.json"), "utf8"))
    assert.equal(store.version, 1)
    assert.equal(store.sessions["sess-1"].approved.length, 8)
    // No half-written state and no leftover temporary files.
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes(".tmp")),
      [],
    )
  })
})

test("brief normalization folds CRLF and trims", () => {
  assert.equal(normalizeBrief("  a\r\nb  "), "a\nb")
  assert.equal(sha256("a\nb"), sha256(normalizeBrief("  a\r\nb  ")))
})
