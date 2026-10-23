// Subagent detection for the Claude Code hooks.
//
// Pi recognized a subagent through the `GENTLE_PI_AGENTS_CHILD` environment variable and the
// publisher through the marker in the appended system prompt. Claude Code has neither: a
// subagent's transcript lives next to a `.meta.json` sibling that names the agent.
//
//   main session    ~/.claude/projects/<slug>/<session-id>.jsonl
//   subagent        ~/.claude/projects/<slug>/subagents/agent-<id>.jsonl
//                   ~/.claude/projects/<slug>/subagents/agent-<id>.meta.json
//
// The sibling holds {"agentType": "<name>", "description": "...", "spawnDepth": 1, ...}.

import { readFileSync } from "node:fs"

/**
 * The agent type of the session that owns `transcriptPath`, or null for the main session.
 * A missing or unreadable sibling means "main session" — never an exception.
 */
export function agentTypeOf(transcriptPath) {
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) return null
  try {
    const metaPath = transcriptPath.replace(/\.jsonl$/, "") + ".meta.json"
    const parsed = JSON.parse(readFileSync(metaPath, "utf8"))
    const agentType = parsed?.agentType
    return typeof agentType === "string" && agentType.length > 0 ? agentType : null
  } catch {
    return null
  }
}

/** True when the session is the main session (no subagent sibling). */
export function isMainSession(transcriptPath) {
  return agentTypeOf(transcriptPath) === null
}
