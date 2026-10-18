import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"])

for (const name of ["deepseek", "deepseek-minimax", "go-minimax", "gpt", "opencode-go", "plan-minimax-m3"]) {
  test(`bundled profile ${name} is a gentle-pi routing export for gentle-ai and review agents only`, () => {
    const profile = JSON.parse(readFileSync(new URL(`../pi/profiles/${name}.json`, import.meta.url), "utf8"))
    assert.equal(profile.kind, "gentle-pi.agent_model_routing")
    assert.equal(profile.version, 1)
    const agents = Object.entries(profile.agents as Record<string, { model: string; thinking: string }>)
    assert.ok(agents.length > 0)
    for (const [agent, route] of agents) {
      assert.match(agent, /^(gentle-ai|review)-/)
      assert.match(route.model, /^[\w.-]+\/[\w.:-]+$/)
      assert.ok(THINKING.has(route.thinking), `${agent} thinking ${route.thinking}`)
    }
  })
}

test("plan-minimax-m3 routes every agent to MiniMax", () => {
  const profile = JSON.parse(readFileSync(new URL("../pi/profiles/plan-minimax-m3.json", import.meta.url), "utf8"))
  for (const route of Object.values(profile.agents as Record<string, { model: string }>)) {
    assert.match(route.model, /^minimax\//)
  }
})

test("deepseek routes every gentle-ai and review agent to DeepSeek only", () => {
  const profile = JSON.parse(readFileSync(new URL("../pi/profiles/deepseek.json", import.meta.url), "utf8"))
  const agents = profile.agents as Record<string, { model: string }>
  assert.equal(Object.keys(agents).length, 14)
  for (const route of Object.values(agents)) assert.match(route.model, /^deepseek\/deepseek-(v4-pro|flash)$/)
})

test("gpt routes every gentle-ai and review agent to GPT only", () => {
  const profile = JSON.parse(readFileSync(new URL("../pi/profiles/gpt.json", import.meta.url), "utf8"))
  const agents = profile.agents as Record<string, { model: string }>
  assert.equal(Object.keys(agents).length, 14)
  for (const route of Object.values(agents)) assert.match(route.model, /^openai-codex\//)
})

test("opencode-go routes every agent to DeepSeek v4-pro or v4.1-flash through OpenCode Go", () => {
  const profile = JSON.parse(readFileSync(new URL("../pi/profiles/opencode-go.json", import.meta.url), "utf8"))
  const agents = profile.agents as Record<string, { model: string }>
  assert.equal(Object.keys(agents).length, 14)
  for (const route of Object.values(agents)) assert.match(route.model, /^opencode-go\/deepseek-(v4-pro|v4\.1-flash)$/)
})

test("go-minimax uses MiniMax for explore, runner, publisher and the four review lenses, DeepSeek via Go for the rest", () => {
  const profile = JSON.parse(readFileSync(new URL("../pi/profiles/go-minimax.json", import.meta.url), "utf8"))
  const agents = profile.agents as Record<string, { model: string }>
  assert.equal(Object.keys(agents).length, 14)
  for (const [agent, route] of Object.entries(agents)) {
    if (["gentle-ai-explore", "gentle-ai-runner", "gentle-ai-publisher", "review-risk", "review-resilience", "review-reliability", "review-readability"].includes(agent)) assert.equal(route.model, "minimax/MiniMax-M3", agent)
    else assert.match(route.model, /^opencode-go\/deepseek-(v4-pro|v4\.1-flash)$/, agent)
  }
})
