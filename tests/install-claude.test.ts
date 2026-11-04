import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const INSTALL = fileURLToPath(new URL("../install.sh", import.meta.url))

// A fake home with a stub gentle-shell, so the installer never touches the real machine.
// `seed` runs against the fake ~/.claude before the installer does.
function setup(seed?: (claude: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "pi-warden-gs-claude-"))
  mkdirSync(join(home, ".pi", "agent"), { recursive: true })
  mkdirSync(join(home, ".claude"), { recursive: true })
  mkdirSync(join(home, "stub"), { recursive: true })
  const shell = join(home, "stub", "gentle-shell")
  writeFileSync(shell, `#!/usr/bin/env bash\nif [ "$1" = home ]; then echo "link ${home}/.pi/agent"; exit 0; fi\necho "$*" >> "${home}/shell-calls"\n`)
  chmodSync(shell, 0o755)
  const claude = join(home, ".claude")
  seed?.(claude)
  const env = { ...process.env, HOME: home, GENTLE_SHELL_BIN: shell, PATH: process.env.PATH ?? "" }
  delete (env as Record<string, string | undefined>).PI_CODING_AGENT_DIR
  delete (env as Record<string, string | undefined>).PI_BIN
  const rerun = (extra: Record<string, string> = {}) =>
    spawnSync("bash", [INSTALL], { encoding: "utf8", env: { ...env, ...extra } })
  const out = rerun()
  return { home, claude, out, rerun }
}

const HOOKS = ["safety-guard.mjs", "reply-length.mjs", "rtk.mjs"]

const AGENTS = [
  "gentle-ai-runner.md",
  "gentle-ai-worker-infra.md",
  "gentle-ai-publisher.md",
  "gentle-ai-prompt-refine.md",
]

test("the Claude Code hooks, subagents and global prompt are installed", () => {
  const { claude, out } = setup()
  assert.equal(out.status, 0, out.stderr)
  for (const hook of HOOKS) {
    assert.ok(existsSync(join(claude, "hooks", hook)), `${hook} is missing`)
  }
  assert.ok(existsSync(join(claude, "hooks", "lib", "agent-context.mjs")))
  for (const agent of AGENTS) {
    assert.ok(existsSync(join(claude, "agents", agent)), `${agent} is missing`)
  }
  assert.ok(existsSync(join(claude, "APPEND_SYSTEM.md")))
})

test("CLAUDE.md includes the global prompt and keeps the content it already had", () => {
  const { claude, out } = setup((c) => writeFileSync(join(c, "CLAUDE.md"), "# My rules\n\nkeep me\n"))
  assert.equal(out.status, 0, out.stderr)
  const md = readFileSync(join(claude, "CLAUDE.md"), "utf8")
  assert.match(md, /^# My rules$/m)
  assert.match(md, /keep me/)
  assert.match(md, /<!-- pi-warden-gs:append-system -->/)
  assert.ok(md.includes(`@${claude}/APPEND_SYSTEM.md`))
  assert.match(md, /<!-- \/pi-warden-gs:append-system -->/)
  assert.ok(readdirSync(claude).some((f) => f.startsWith("CLAUDE.md.bak-")))
})

test("the hooks are registered in settings.json and foreign entries survive", () => {
  const { claude, out } = setup((c) =>
    writeFileSync(
      join(c, "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "my-own-hook" }] }] } }, null, 2),
    ),
  )
  assert.equal(out.status, 0, out.stderr)
  const settings = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"))
  const commands = (event: string): string[] =>
    (settings.hooks[event] ?? []).flatMap((entry: { hooks: { command: string }[] }) => entry.hooks.map((h) => h.command))
  const registered = [...commands("PreToolUse"), ...commands("PostToolUse"), ...commands("UserPromptSubmit")]
  for (const command of [
    "node ~/.claude/hooks/safety-guard.mjs",
    "node ~/.claude/hooks/rtk.mjs",
    "node ~/.claude/hooks/reply-length.mjs",
  ]) {
    assert.ok(registered.includes(command), `${command} is not registered`)
  }
  assert.deepEqual(commands("Stop"), ["my-own-hook"])
})

test("running the installer again changes nothing", () => {
  const { claude, rerun } = setup()
  const before = readFileSync(join(claude, "settings.json"), "utf8")
  const mdBefore = readFileSync(join(claude, "CLAUDE.md"), "utf8")
  const backupsBefore = readdirSync(claude).filter((f) => f.startsWith("CLAUDE.md.bak-"))
  const out = rerun()
  assert.equal(out.status, 0, out.stderr)
  assert.equal(readFileSync(join(claude, "settings.json"), "utf8"), before)
  assert.equal(readFileSync(join(claude, "CLAUDE.md"), "utf8"), mdBefore)
  assert.equal(mdBefore.match(/<!-- pi-warden-gs:append-system -->/g)?.length, 1)
  // The first run legitimately leaves a backup behind; a second run must not add one.
  assert.deepEqual(
    readdirSync(claude).filter((f) => f.startsWith("CLAUDE.md.bak-")),
    backupsBefore,
  )
})

test("a model the user chose for a Claude subagent is preserved", () => {
  const { claude, rerun } = setup()
  const file = join(claude, "agents", "gentle-ai-publisher.md")
  writeFileSync(file, readFileSync(file, "utf8").replace(/^model: .*$/m, "model: sonnet"))
  const out = rerun()
  assert.equal(out.status, 0, out.stderr)
  assert.match(readFileSync(file, "utf8"), /^model: sonnet$/m)
})

test("CLAUDE_WARDEN_MODEL overrides the model of every Claude subagent", () => {
  const { claude, rerun } = setup()
  const out = rerun({ CLAUDE_WARDEN_MODEL: "opus" })
  assert.equal(out.status, 0, out.stderr)
  assert.match(readFileSync(join(claude, "agents", "gentle-ai-runner.md"), "utf8"), /^model: opus$/m)
})

test("installing 3.0.0 removes the retired brief-review assets and reports each one", () => {
  const retiredClaude = [
    join("hooks", "brief-guard.sh"),
    join("hooks", "brief-approval.mjs"),
    join("hooks", "lib", "approvals.mjs"),
    join("agents", "gentle-ai-brief-review.md"),
  ]
  const { claude, out } = setup((claude) => {
    mkdirSync(join(claude, "hooks", "lib"), { recursive: true })
    mkdirSync(join(claude, "agents"), { recursive: true })
    for (const rel of retiredClaude) writeFileSync(join(claude, rel), "previous install")
    const piAgent = join(claude, "..", ".pi", "agent", "agents")
    mkdirSync(piAgent, { recursive: true })
    writeFileSync(join(piAgent, "gentle-ai-brief-review.md"), "previous install")
    writeFileSync(
      join(claude, "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Agent",
              hooks: [
                { type: "command", command: "~/.claude/hooks/brief-guard.sh", timeout: 10 },
                { type: "command", command: "my-own-hook", timeout: 5 },
              ],
            },
          ],
          PostToolUse: [
            { matcher: "Agent", hooks: [{ type: "command", command: "node ~/.claude/hooks/brief-approval.mjs", timeout: 5 }] },
          ],
          Stop: [{ matcher: "", hooks: [{ type: "command", command: "my-stop-hook", timeout: 5 }] }],
        },
      }),
    )
  })

  assert.equal(out.status, 0, out.stderr)
  for (const rel of retiredClaude) {
    assert.equal(existsSync(join(claude, rel)), false, `${rel} survived the migration`)
    assert.match(out.stdout, new RegExp(`removed ${join(claude, rel).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
  }
  assert.equal(existsSync(join(claude, "..", ".pi", "agent", "agents", "gentle-ai-brief-review.md")), false)

  const settings = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"))
  const commands = Object.values(settings.hooks as Record<string, { hooks: { command: string }[] }[]>)
    .flat()
    .flatMap((entry) => entry.hooks.map((h) => h.command))
  assert.ok(commands.includes("my-own-hook"), "a foreign PreToolUse hook was dropped")
  assert.ok(commands.includes("my-stop-hook"), "a foreign event was dropped")
  assert.doesNotMatch(commands.join("\n"), /brief-guard|brief-approval/)
})
