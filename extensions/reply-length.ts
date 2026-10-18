// Reply-length reminder — keeps main-session replies short.
//
// Length rules otherwise live far above the long gentle-pi instructions and models answer with
// multi-section reports anyway. Before every run started by the user in the main session, this
// adds one hidden message with the rule, so it is the most recent instruction the model reads.
// Subagent sessions and custom-message runs are skipped.
//
// This reminder is the single home of the reply-length policy: no AGENTS.md or APPEND_SYSTEM.md
// declares it, and it must stay bounded in words as well as lines, or "5 lines" is satisfiable
// with paragraph-long lines.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export const REPLY_LENGTH_REMINDER =
  "Reply rule for this turn: answer the human in their language, in at most 5 lines of at most 25 words each — one sentence per line, no paragraphs, no tables and no headings unless the human asks for one. " +
  "Open with the outcome and close with the next action; offer extra detail in one line, and put long content in a file, the task document or memory, with the path in the reply. " +
  "Exempt and kept verbatim: a question to the human, a provider-owned blocking prompt with its exact tokens, code and commands."

export default function (pi: ExtensionAPI, child = process.env.GENTLE_PI_AGENTS_CHILD === "1") {
  pi.on("before_agent_start", async (event) => {
    if (child || (event as { messageType?: unknown }).messageType !== "user") return
    return { message: { customType: "pi-warden-gs.reply-length", content: REPLY_LENGTH_REMINDER, display: false } }
  })
}
