#!/usr/bin/env node
// Brief approval — the Claude Code PostToolUse hook.
//
// It runs after an Agent launch. When the launched agent was gentle-ai-brief-review and the
// result carries `VERDICT: APPROVE`, the sha256 of the reviewed brief becomes an unused
// approval for the session, so the writer can be launched with that exact brief.
//
// A result with `VERDICT: FIX`, an errored result, a reviewer run whose task had no marked
// brief, or a launch of another agent registers nothing. The hook never fails the turn.

import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

import { add, normalizeBrief, sha256 } from "./lib/approvals.mjs"
import { extractMarkedBrief, parseVerdict } from "./safety-guard.mjs"

const REVIEWER = "gentle-ai-brief-review"

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

function blockText(block) {
  if (typeof block === "string") return block
  if (block && typeof block === "object" && typeof block.text === "string") return block.text
  return ""
}

/** The text of a tool response: a string, an object with content/result/text, or content blocks. */
export function responseText(response) {
  if (typeof response === "string") return response
  if (Array.isArray(response)) return response.map(blockText).join("\n")
  if (response && typeof response === "object") {
    if (typeof response.content === "string") return response.content
    if (Array.isArray(response.content)) return response.content.map(blockText).join("\n")
    if (typeof response.result === "string") return response.result
    if (typeof response.text === "string") return response.text
  }
  return ""
}

function isErrored(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) return false
  return response.is_error === true || response.isError === true || response.is_error === "true"
}

export function main() {
  const payload = readPayload()
  if (!payload) return

  try {
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : ""
    if (toolName !== "Agent" && toolName !== "Task") return

    const input = payload.tool_input ?? {}
    if (input.subagent_type !== REVIEWER) return

    const marked = extractMarkedBrief(typeof input.prompt === "string" ? input.prompt : "")
    if (marked === null) return

    const response = payload.tool_response
    if (isErrored(response)) return
    if (parseVerdict(responseText(response)) !== "APPROVE") return

    const sessionId = typeof payload.session_id === "string" ? payload.session_id : ""
    if (!sessionId) return

    add(sha256(normalizeBrief(marked)), sessionId)
  } catch {
    // Never fail the turn: a missing approval only blocks the next writer launch.
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) main()
