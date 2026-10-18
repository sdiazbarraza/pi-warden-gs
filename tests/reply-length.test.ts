import { test } from "node:test"
import assert from "node:assert/strict"
import guard, { REPLY_LENGTH_REMINDER } from "../extensions/reply-length.ts"

type Handler = (event: unknown, ctx: unknown) => unknown
function setup(child = false) {
  const handlers: Record<string, Handler> = {}
  guard({ on: (name: string, h: Handler) => (handlers[name] = h) } as never, child)
  return (event: unknown) => handlers.before_agent_start(event, {}) as Promise<{ message?: { customType: string; content: string; display: boolean } } | undefined>
}

test("adds a hidden reply-length reminder to every user turn of the main session", async () => {
  const result = await setup()({ messageType: "user", prompt: "que le digo ahora?" })
  assert.equal(result?.message?.customType, "pi-warden-gs.reply-length")
  assert.equal(result?.message?.display, false)
  assert.equal(result?.message?.content, REPLY_LENGTH_REMINDER)
  assert.match(REPLY_LENGTH_REMINDER, /5 líneas|5 lines/)
  assert.match(REPLY_LENGTH_REMINDER, /25 palabras|25 words/)
  assert.match(REPLY_LENGTH_REMINDER, /un archivo|a file/)
})

test("skips runs started by custom messages and subagent sessions", async () => {
  assert.equal(await setup()({ messageType: "custom" }), undefined)
  assert.equal(await setup(true)({ messageType: "user", prompt: "x" }), undefined)
})
