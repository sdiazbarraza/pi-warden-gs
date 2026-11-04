// Claude Code hook tests — the hooks are driven as real processes, the way the
// runtime invokes them: a JSON payload on stdin, a JSON answer on stdout.

import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"


const ROOT = join(import.meta.dirname, "..")
const HOOKS = join(ROOT, "claude", "hooks")

// The Pi messages, copied verbatim from extensions/safety-guard.ts and
// extensions/reply-length.ts. The hook must not reword them.
const DESTRUCTIVE_BLOCKED = (label: string) =>
  `safety-guard: "${label}" is blocked. If the human explicitly authorized it, ask them to run it themselves.`
const HEAVY_BLOCKED = (label: string) =>
  `safety-guard: "${label}" runs only in a subagent. Delegate it to gentle-ai-runner (commands only) or gentle-ai-worker-infra (when it also edits files). If they are unavailable, stop and tell the human instead of running it here.`
const DELIVERY_BLOCKED = (label: string) =>
  `safety-guard: "${label}" runs only inside gentle-ai-publisher. Delegate the exact git/gh commands to gentle-ai-publisher (mode "task") with the human's authorization.`
const ENV_BLOCKED = (label: string) =>
  `safety-guard: "${label}" is blocked. Environment files hold secrets and must not be read by an agent. If the human explicitly authorized it, ask them to run it themselves.`

// --- fixtures -------------------------------------------------------------

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-warden-state-"))
  return dir
}

/** A transcript tree with a main session and one subagent per agentType. */
function transcripts(): {
  dir: string
  main: string
  publisher: string
  runner: string
} {
  const dir = mkdtempSync(join(tmpdir(), "claude-warden-transcripts-"))
  const main = join(dir, "main.jsonl")
  writeFileSync(main, "")
  const subagents = join(dir, "subagents")
  mkdirSync(subagents, { recursive: true })
  const publisher = join(subagents, "agent-pub.jsonl")
  writeFileSync(publisher, "")
  writeFileSync(join(subagents, "agent-pub.meta.json"), JSON.stringify({ agentType: "gentle-ai-publisher" }))
  const runner = join(subagents, "agent-run.jsonl")
  writeFileSync(runner, "")
  writeFileSync(join(subagents, "agent-run.meta.json"), JSON.stringify({ agentType: "gentle-ai-runner" }))
  return { dir, main, publisher, runner }
}

type Payload = Record<string, unknown>

function payload(overrides: Payload): Payload {
  return {
    session_id: "sess-1",
    transcript_path: transcripts().main,
    cwd: ROOT,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_use_id: "tu-1",
    ...overrides,
  }
}

function runHook(
  script: string,
  body: Payload,
  env: Record<string, string | undefined> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(body),
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

function answered(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string }
  }
  return parsed.hookSpecificOutput
}

function deniedReason(stdout: string): string {
  const out = answered(stdout)
  assert.equal(out.permissionDecision, "deny", `not a denial: ${stdout}`)
  return out.permissionDecisionReason ?? ""
}

// --- destructive blocker (S1) --------------------------------------------

const DESTRUCTIVE_CASES: Array<[string, string]> = [
  ["docker rm", "docker rm my-container"],
  ["docker volume rm", "docker volume rm data"],
  ["docker prune", "docker system prune -af"],
  ["docker compose down -v", "docker compose down -v"],
  ["git reset --hard", "git reset --hard HEAD~1"],
  ["git push --force", "git push --force origin main"],
  ["git clean -f", "git clean -fd"],
  ["sudo", "sudo rm -rf /var/log"],
]

for (const [label, command] of DESTRUCTIVE_CASES) {
  test(`blocks the destructive command "${label}"`, () => {
    const result = runHook("safety-guard.mjs", payload({ tool_input: { command } }))
    assert.equal(result.status, 0, result.stderr)
    assert.equal(deniedReason(result.stdout), DESTRUCTIVE_BLOCKED(label))
  })
}


test("a heredoc consumed by a read-only text tool is data, not a command", () => {
  const command = "wc -l <<'EOF'\nsudo rm -rf /\nEOF\n"
  const result = runHook("safety-guard.mjs", payload({ tool_input: { command } }))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), "")
})

test("a heredoc consumed by a shell is still checked", () => {
  const command = "bash <<'EOF'\nsudo rm -rf /\nEOF\n"
  const result = runHook("safety-guard.mjs", payload({ tool_input: { command } }))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(deniedReason(result.stdout), DESTRUCTIVE_BLOCKED("sudo"))
})

// --- delivery gate (S2) ---------------------------------------------------

test("blocks git push in the main session", () => {
  const result = runHook("safety-guard.mjs", payload({ tool_input: { command: "git push origin main" } }))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(deniedReason(result.stdout), DELIVERY_BLOCKED("git push"))
})

test("allows git push inside the publisher subagent", () => {
  const t = transcripts()
  const result = runHook(
    "safety-guard.mjs",
    payload({ transcript_path: t.publisher, tool_input: { command: "git push origin main" } }),
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), "")
})

test("blocks gh pr create in the main session", () => {
  const result = runHook(
    "safety-guard.mjs",
    payload({ tool_input: { command: "gh pr create --title x" } }),
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(deniedReason(result.stdout), DELIVERY_BLOCKED("gh pr create"))
})

test("blocks gh pr merge in the main session", () => {
  const result = runHook("safety-guard.mjs", payload({ tool_input: { command: "gh -R a/b pr merge" } }))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(deniedReason(result.stdout), DELIVERY_BLOCKED("gh pr merge"))
})

// --- environment-file gate ------------------------------------------------

const ENV_CASES: Array<[string, string]> = [
  [".env", "cat .env"],
  [".env", "cat config/.env"],
  [".env", "busybox cat .env"],
  [".env", "git show HEAD:.env"],
  [".env", "git diff -- .env"],
  [".env.local", "cat .env.local"],
  [".env.example.local", "cat .env.example.local"],
  [".env", "cp .env.example .env"],
  // Quoted paths name the same file: the quotes are shell syntax, not part of the path.
  [".env", 'cat ".env"'],
  [".env", "cat '.env'"],
  [".env", 'cat "config/.env"'],
  // Punctuated paths name the same file: the punctuation is shell syntax, not part of the path.
  [".env", "cat .env;"],
  [".env", "(cat .env)"],
  [".env", "cat .env)"],
  [".env", "cat .env,"],
  [".env", "('.env')"],
  // The dot of a backup name is part of the name: ".env.bak" is still an environment file.
  [".env.bak", "cat .env.bak"],
  // A shell operator or a trailing slash still names the file.
  [".env", "cat .env|tee"],
  [".env", "cat .env&&echo"],
  [".env", "cat .env>"],
  [".env", "ls .env/"],
]

for (const [label, command] of ENV_CASES) {
  test(`blocks the environment file read "${command}"`, () => {
    const result = runHook("safety-guard.mjs", payload({ tool_input: { command } }))
    assert.equal(result.status, 0, result.stderr)
    assert.equal(deniedReason(result.stdout), ENV_BLOCKED(label))
  })
}

test("allows reading the example environment file", () => {
  for (const command of [
    "cat .env.example",
    "cat backup.env.example",
    'cat ".env.example"',
    'cat "backup.env.example"',
    // Names that only look like an environment file stay readable.
    "cat my.env",
    "cat .envrc",
  ]) {
    const result = runHook("safety-guard.mjs", payload({ tool_input: { command } }))
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "", command)
  }
})

test("blocks an environment file read behind an operator or a trailing slash", () => {
  for (const command of ["cat .env|tee", "cat .env&&echo", "cat .env>", "ls .env/"]) {
    const result = runHook("safety-guard.mjs", payload({ tool_input: { command } }))
    assert.equal(result.status, 0, result.stderr)
    assert.equal(deniedReason(result.stdout), ENV_BLOCKED(".env"), command)
  }
})

test("the unchanged environment file commands keep their labels", () => {
  for (const [label, command] of [
    [".env", "cat .env"],
    [".env", "cat .env;"],
    [".env", "(cat .env)"],
    [".env.bak", "cat .env.bak"],
  ] as Array<[string, string]>) {
    const result = runHook("safety-guard.mjs", payload({ tool_input: { command } }))
    assert.equal(result.status, 0, result.stderr)
    assert.equal(deniedReason(result.stdout), ENV_BLOCKED(label), command)
  }
  for (const command of ["cat .env.example", "cat backup.env.example", "cat my.env", "cat .envrc"]) {
    const result = runHook("safety-guard.mjs", payload({ tool_input: { command } }))
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "", command)
  }
})

test("blocks an environment file read with quotes inside the token", () => {
  for (const command of ["cat .e''nv", 'cat .e""nv']) {
    const result = runHook("safety-guard.mjs", payload({ tool_input: { command } }))
    assert.equal(result.status, 0, result.stderr)
    assert.equal(deniedReason(result.stdout), ENV_BLOCKED(".env"), command)
  }
})

test("the unchanged environment file commands keep their labels behind interior quotes", () => {
  for (const [label, command] of [
    [".env", "cat .env"],
    [".env", "cat config/.env"],
    [".env.bak", "cat .env.bak"],
    [".env", "cat .env|tee"],
    [".env", "ls .env/"],
  ] as Array<[string, string]>) {
    const result = runHook("safety-guard.mjs", payload({ tool_input: { command } }))
    assert.equal(result.status, 0, result.stderr)
    assert.equal(deniedReason(result.stdout), ENV_BLOCKED(label), command)
  }
  for (const command of ["cat .env.example", "cat backup.env.example", "cat my.env", "cat .envrc"]) {
    const result = runHook("safety-guard.mjs", payload({ tool_input: { command } }))
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "", command)
  }
})

test("blocks an environment file read inside the publisher subagent", () => {
  const t = transcripts()
  const result = runHook(
    "safety-guard.mjs",
    payload({ transcript_path: t.publisher, tool_input: { command: "cat .env" } }),
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(deniedReason(result.stdout), ENV_BLOCKED(".env"))
})

// --- heavy-build gate (S3) ------------------------------------------------

test("blocks docker run in the main session", () => {
  const result = runHook(
    "safety-guard.mjs",
    payload({ tool_input: { command: "docker run --rm alpine echo hi" } }),
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(deniedReason(result.stdout), HEAVY_BLOCKED("docker run"))
})

test("allows docker run inside a subagent", () => {
  const t = transcripts()
  const result = runHook(
    "safety-guard.mjs",
    payload({ transcript_path: t.runner, tool_input: { command: "docker run --rm alpine echo hi" } }),
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), "")
})

test("allows a read-only docker query in the main session", () => {
  const result = runHook("safety-guard.mjs", payload({ tool_input: { command: "docker ps" } }))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), "")
})

test("blocks the build wrapper in the main session", () => {
  const result = runHook(
    "safety-guard.mjs",
    payload({ tool_input: { command: "./scripts/dotnet-in-docker.sh test" } }),
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(deniedReason(result.stdout), HEAVY_BLOCKED("dotnet-in-docker.sh"))
})

test("an unrelated tool produces no output", () => {
  const result = runHook(
    "safety-guard.mjs",
    payload({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" } }),
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), "")
})

// --- reply-length reminder (S6) -------------------------------------------

const REPLY_RULE =
  "Reply rule for this turn: answer the human in their language, in at most 5 lines of at most 25 words each — one sentence per line, no paragraphs, no tables and no headings unless the human asks for one. " +
  "Open with the outcome and close with the next action; offer extra detail in one line, and put long content in a file, the task document or memory, with the path in the reply. " +
  "Exempt and kept verbatim: a question to the human, a provider-owned blocking prompt with its exact tokens, code and commands."

test("adds the reply-length reminder in the main session", () => {
  const result = runHook(
    "reply-length.mjs",
    payload({ hook_event_name: "UserPromptSubmit", tool_name: "", tool_input: {} }),
  )
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext?: string } }
  assert.equal(parsed.hookSpecificOutput.additionalContext, REPLY_RULE)
})

test("skips the reply-length reminder in a subagent session", () => {
  const t = transcripts()
  const result = runHook(
    "reply-length.mjs",
    payload({ hook_event_name: "UserPromptSubmit", tool_name: "", tool_input: {}, transcript_path: t.runner }),
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), "")
})

// --- rtk rewrite (S7) -----------------------------------------------------

function fakeRtk(version: string, exit: number, output: string): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-warden-rtk-"))
  const script = join(dir, "rtk")
  writeFileSync(
    script,
    `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "rtk ${version}"; exit 0; fi\nif [ "$1" = "rewrite" ]; then printf '%s' "${output}"; exit ${exit}; fi\nexit 1\n`,
  )
  chmodSync(script, 0o755)
  return dir
}

test("rewrites a Bash command through rtk", () => {
  const dir = fakeRtk("1.0.1", 3, "rtk ls -la")
  const result = runHook(
    "rtk.mjs",
    payload({ tool_input: { command: "ls -la", description: "list" } }),
    { PATH: `${dir}:${process.env.PATH ?? ""}` },
  )
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout) as {
    hookSpecificOutput: { updatedInput?: { command?: string; description?: string } }
  }
  assert.equal(parsed.hookSpecificOutput.updatedInput?.command, "rtk ls -la")
  // The whole tool input travels back, not only the changed field.
  assert.equal(parsed.hookSpecificOutput.updatedInput?.description, "list")
})

test("leaves the command alone when rtk finds no rewrite", () => {
  const dir = fakeRtk("1.0.1", 1, "")
  const result = runHook(
    "rtk.mjs",
    payload({ tool_input: { command: "ls -la" } }),
    { PATH: `${dir}:${process.env.PATH ?? ""}` },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), "")
})

test("leaves the command alone when rtk is too old", () => {
  const dir = fakeRtk("0.22.0", 3, "rtk ls -la")
  const result = runHook(
    "rtk.mjs",
    payload({ tool_input: { command: "ls -la" } }),
    { PATH: `${dir}:${process.env.PATH ?? ""}` },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), "")
})

test("leaves the command alone when the rewrite is disabled", () => {
  const dir = fakeRtk("1.0.1", 3, "rtk ls -la")
  const result = runHook(
    "rtk.mjs",
    payload({ tool_input: { command: "ls -la" } }),
    { PATH: `${dir}:${process.env.PATH ?? ""}`, RTK_DISABLED: "1" },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), "")
})

test("leaves a command that already starts with rtk alone", () => {
  const dir = fakeRtk("1.0.1", 3, "rtk rtk ls")
  const result = runHook(
    "rtk.mjs",
    payload({ tool_input: { command: "rtk ls -la" } }),
    { PATH: `${dir}:${process.env.PATH ?? ""}` },
  )
  assert.equal(result.stdout.trim(), "")
})

test("the rtk hook ignores tools other than Bash", () => {
  const dir = fakeRtk("1.0.1", 3, "rtk ls -la")
  const result = runHook(
    "rtk.mjs",
    payload({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" } }),
    { PATH: `${dir}:${process.env.PATH ?? ""}` },
  )
  assert.equal(result.stdout.trim(), "")
})
