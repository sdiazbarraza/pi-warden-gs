import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const INSTALL = fileURLToPath(new URL("../install.sh", import.meta.url))

// A fake gentle-shell that reports the given home and records `install` calls.
function setup(mode: "link" | "isolated") {
  const home = mkdtempSync(join(tmpdir(), "pi-warden-gs-install-"))
  const agent = mode === "isolated" ? join(home, ".gentle-shell", "agent") : join(home, ".pi", "agent")
  mkdirSync(agent, { recursive: true })
  mkdirSync(join(home, "stub"), { recursive: true })
  const shell = join(home, "stub", "gentle-shell")
  writeFileSync(shell, `#!/usr/bin/env bash\nif [ "$1" = home ]; then echo "${mode} ${agent}"; exit 0; fi\necho "$*" >> "${home}/shell-calls"\n`)
  chmodSync(shell, 0o755)
  const env = { ...process.env, HOME: home, GENTLE_SHELL_BIN: shell, PATH: process.env.PATH ?? "" }
  delete (env as Record<string, string | undefined>).PI_CODING_AGENT_DIR
  delete (env as Record<string, string | undefined>).PI_BIN
  const rerun = (extra: Record<string, string> = {}) =>
    spawnSync("bash", [INSTALL], { encoding: "utf8", env: { ...env, ...extra } })
  const out = rerun()
  return { home, agent, out, rerun }
}

test("isolated gentle-shell home: files go to the gentle-shell agent and config homes", () => {
  const { home, agent, out } = setup("isolated")
  assert.equal(out.status, 0, out.stderr)
  assert.ok(existsSync(join(agent, "APPEND_SYSTEM.md")))
  assert.ok(existsSync(join(agent, "agents", "gentle-ai-publisher.md")))
  assert.ok(existsSync(join(home, ".gentle-shell", "gentle-ai", "profiles", "deepseek.json")))
  assert.equal(existsSync(join(home, ".pi", "agent", "APPEND_SYSTEM.md")), false)
  assert.equal(existsSync(join(home, ".pi", "gentle-ai")), false)
})

test("the package is registered with gentle-shell install, not the global pi", () => {
  const { home, out } = setup("isolated")
  assert.equal(out.status, 0, out.stderr)
  assert.match(readFileSync(join(home, "shell-calls"), "utf8"), /^install .*pi-warden-gs/m)
})

test("link gentle-shell home: files go to ~/.pi/agent and ~/.pi/gentle-ai", () => {
  const { home, out } = setup("link")
  assert.equal(out.status, 0, out.stderr)
  assert.ok(existsSync(join(home, ".pi", "agent", "APPEND_SYSTEM.md")))
  assert.ok(existsSync(join(home, ".pi", "gentle-ai", "profiles", "gpt.json")))
})

// The agent definitions ship a placeholder model: whoever installs must choose their own.
test("a fresh install writes the placeholder model so the user picks their own", () => {
  const { agent, out } = setup("link")
  assert.equal(out.status, 0, out.stderr)
  const publisher = readFileSync(join(agent, "agents", "gentle-ai-publisher.md"), "utf8")
  assert.match(publisher, /^model: provider\/model$/m)
  assert.match(publisher, /^thinking: high$/m)
  assert.match(out.stdout, /placeholder/)
})

test("an agent whose model the user chose keeps it, and takes the rest from the package", () => {
  const { agent, rerun } = setup("link")
  const file = join(agent, "agents", "gentle-ai-publisher.md")
  writeFileSync(file, readFileSync(file, "utf8").replace(/^model: .*$/m, "model: minimax/MiniMax-M3.1-Flash-Preview"))
  const out = rerun()
  assert.equal(out.status, 0, out.stderr)
  assert.match(readFileSync(file, "utf8"), /^model: minimax\/MiniMax-M3\.1-Flash-Preview$/m)
  assert.match(out.stdout, /unchanged .*gentle-ai-publisher\.md/)
  assert.equal(readdirSync(join(agent, "agents")).some((f) => f.startsWith("gentle-ai-publisher.md.bak-")), false)
})

test("thinking always comes from the package, even when the user edited it", () => {
  const { agent, rerun } = setup("link")
  const file = join(agent, "agents", "gentle-ai-runner.md")
  writeFileSync(file, readFileSync(file, "utf8").replace(/^thinking: .*$/m, "thinking: low"))
  const out = rerun()
  assert.equal(out.status, 0, out.stderr)
  assert.match(readFileSync(file, "utf8"), /^thinking: medium$/m)
})

test("an untouched placeholder is overwritten by the package text", () => {
  const { agent, rerun } = setup("link")
  const file = join(agent, "agents", "gentle-ai-runner.md")
  writeFileSync(file, readFileSync(file, "utf8") + "\nlocal edit\n")
  const out = rerun()
  assert.equal(out.status, 0, out.stderr)
  const after = readFileSync(file, "utf8")
  assert.doesNotMatch(after, /local edit/)
  assert.match(after, /^model: provider\/model$/m)
})

test("PI_WARDEN_GS_MODEL overrides a model the user had chosen", () => {
  const { agent, rerun } = setup("link")
  const file = join(agent, "agents", "gentle-ai-publisher.md")
  writeFileSync(file, readFileSync(file, "utf8").replace(/^model: .*$/m, "model: minimax/MiniMax-M3.1-Flash-Preview"))
  const out = rerun({ PI_WARDEN_GS_MODEL: "deepseek/deepseek-v4-pro" })
  assert.equal(out.status, 0, out.stderr)
  assert.match(readFileSync(file, "utf8"), /^model: deepseek\/deepseek-v4-pro$/m)
})
