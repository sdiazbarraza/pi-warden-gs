import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const FILTER = fileURLToPath(new URL("../pi/models-minimax.jq", import.meta.url))
const ID = "MiniMax-M3.1-Flash-Preview"

function apply(input: unknown) {
  const out = spawnSync("jq", ["-f", FILTER], { input: JSON.stringify(input), encoding: "utf8" })
  assert.equal(out.status, 0, out.stderr)
  return JSON.parse(out.stdout)
}

test("adds the M3.1 preview model to the minimax provider and keeps other providers and keys", () => {
  const original = {
    providers: { "minimax-openai": { baseUrl: "https://api.minimax.io/v1", apiKey: "secret", models: [{ id: "MiniMax-M3" }] } },
  }
  const result = apply(original)
  assert.deepEqual(result.providers["minimax-openai"], original.providers["minimax-openai"])
  const models = result.providers.minimax.models
  assert.equal(models.length, 1)
  assert.equal(models[0].id, ID)
  assert.equal(models[0].contextWindow, 1000000)
  assert.equal(models[0].reasoning, true)
})

test("is idempotent and never replaces an existing entry", () => {
  const custom = { id: ID, name: "custom", contextWindow: 5 }
  const result = apply({ providers: { minimax: { apiKey: "k", models: [{ id: "other" }, custom] } } })
  assert.deepEqual(result.providers.minimax, { apiKey: "k", models: [{ id: "other" }, custom] })
  assert.deepEqual(apply(apply({})), apply({}))
})

test("works on an empty models.json", () => {
  assert.equal(apply({}).providers.minimax.models[0].id, ID)
})
