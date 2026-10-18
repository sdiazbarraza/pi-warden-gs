import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT = fileURLToPath(new URL("../bin/pi-perfil", import.meta.url))
const AGENTS = { "gentle-ai-verify": { model: "minimax/MiniMax-M3", thinking: "high" } }
const ROUTING = JSON.stringify({ kind: "gentle-pi.agent_model_routing", version: 1, agents: AGENTS }) + "\n"

function home() {
  const dir = mkdtempSync(join(tmpdir(), "pi-perfil-"))
  mkdirSync(join(dir, ".pi", "gentle-ai", "profiles"), { recursive: true })
  return dir
}
const gentle = (dir: string, ...parts: string[]) => join(dir, ".pi", "gentle-ai", ...parts)
const saveProfile = (dir: string, name: string, text = ROUTING) => writeFileSync(gentle(dir, "profiles", `${name}.json`), text)
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"))
const run = (dir: string, ...args: string[]) =>
  spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, HOME: dir, GENTLE_SHELL_BIN: "/nonexistent" } })

test("activates a profile in a new profiles.json and still writes models.export.json", () => {
  const dir = home()
  saveProfile(dir, "plan-minimax-m3")
  const out = run(dir, "plan-minimax-m3")
  assert.equal(out.status, 0, out.stderr)
  assert.deepEqual(readJson(gentle(dir, "profiles.json")), {
    kind: "gentle-pi.agent_model_profiles",
    version: 1,
    active: "plan-minimax-m3",
    profiles: { "plan-minimax-m3": AGENTS },
  })
  assert.equal(readFileSync(gentle(dir, "models.export.json"), "utf8"), ROUTING)
  assert.match(out.stdout, /Perfil 'plan-minimax-m3' activo/)
  assert.match(out.stdout, /\/gentle:profiles/)
})

test("keeps other profiles, replaces the same name, switches active and backs up profiles.json", () => {
  const dir = home()
  const current = { "gentle-ai-verify": { model: "openai-codex/gpt-6.1-sol", thinking: "high" } }
  const original = { kind: "gentle-pi.agent_model_profiles", version: 1, active: "current", profiles: { current, "deepseek-minimax": {} } }
  writeFileSync(gentle(dir, "profiles.json"), JSON.stringify(original))
  saveProfile(dir, "deepseek-minimax")
  assert.equal(run(dir, "deepseek-minimax").status, 0)
  const result = readJson(gentle(dir, "profiles.json"))
  assert.equal(result.active, "deepseek-minimax")
  assert.deepEqual(result.profiles.current, current)
  assert.deepEqual(result.profiles["deepseek-minimax"], AGENTS)
  const backups = readdirSync(gentle(dir)).filter((f) => f.startsWith("profiles.json.bak-"))
  assert.equal(backups.length, 1)
  assert.deepEqual(readJson(gentle(dir, backups[0])), original)
})

test("rejects a profile that is not a routing export and changes nothing", () => {
  const dir = home()
  saveProfile(dir, "gpt", "{}\n")
  const out = run(dir, "gpt")
  assert.equal(out.status, 1)
  assert.match(out.stdout + out.stderr, /no es un perfil válido/)
  assert.equal(existsSync(gentle(dir, "profiles.json")), false)
  assert.equal(existsSync(gentle(dir, "models.export.json")), false)
})

test("fails with guidance when a known profile file is missing", () => {
  const out = run(home(), "gpt")
  assert.equal(out.status, 1)
  assert.match(out.stdout, /No existe: .*gpt\.json/)
})

test("prints usage and fails for an unknown name or no arguments", () => {
  const dir = home()
  for (const args of [["nope"], []]) {
    const out = run(dir, ...args)
    assert.equal(out.status, 1)
    assert.match(out.stdout, /^Uso: pi-perfil/)
  }
})

test("list shows saved profiles", () => {
  const dir = home()
  saveProfile(dir, "deepseek-minimax")
  const out = run(dir, "list")
  assert.equal(out.status, 0)
  assert.match(out.stdout, /deepseek-minimax\.json/)
})

test("with an isolated gentle-shell home, profiles are read from and activated in ~/.gentle-shell/gentle-ai", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-perfil-isolated-"))
  const config = join(dir, ".gentle-shell", "gentle-ai")
  mkdirSync(join(config, "profiles"), { recursive: true })
  writeFileSync(join(config, "profiles", "gpt.json"), ROUTING)
  const shell = join(dir, "gentle-shell")
  writeFileSync(shell, `#!/usr/bin/env bash\necho "isolated ${dir}/.gentle-shell/agent"\n`)
  chmodSync(shell, 0o755)
  const out = spawnSync("bash", [SCRIPT, "gpt"], { encoding: "utf8", env: { ...process.env, HOME: dir, GENTLE_SHELL_BIN: shell } })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(readJson(join(config, "profiles.json")).active, "gpt")
  assert.equal(existsSync(join(dir, ".pi", "gentle-ai")), false)
})
