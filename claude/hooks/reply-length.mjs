#!/usr/bin/env node
// Reply-length reminder — the Claude Code UserPromptSubmit hook.
//
// Length rules otherwise live far above the long instructions and models answer with
// multi-section reports anyway. Before every run started by the user in the main session, this
// adds one hidden reminder with the rule, so it is the most recent instruction the model reads.
// Subagent sessions are skipped.
//
// This reminder is the single home of the reply-length policy: no agent definition and no
// prompt file restates it, and it must stay bounded in words as well as lines, or "5 lines" is
// satisfiable with paragraph-long lines.

import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

import { agentTypeOf } from "./lib/agent-context.mjs"

export const REPLY_LENGTH_REMINDER =
  "Reply rule for this turn: answer the human in their language, in at most 5 lines of at most 25 words each — one sentence per line, no paragraphs, no tables and no headings unless the human asks for one. " +
  "Open with the outcome and close with the next action; offer extra detail in one line, and put long content in a file, the task document or memory, with the path in the reply. " +
  "Exempt and kept verbatim: a question to the human, a provider-owned blocking prompt with its exact tokens, code and commands."

function readPayload() {
  try {
    const raw = readFileSync(0, "utf8")
    if (!raw.trim()) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

export function main() {
  const payload = readPayload()
  if (!payload) return

  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : ""
  if (event && event !== "UserPromptSubmit") return

  // Subagent sessions are skipped: the reminder belongs to the conversation with the human.
  if (agentTypeOf(payload.transcript_path) !== null) return

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: REPLY_LENGTH_REMINDER,
      },
    })}\n`,
  )
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) main()
