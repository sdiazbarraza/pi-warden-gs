#!/usr/bin/env node
// RTK hook — the Claude Code PreToolUse hook that rewrites Bash commands.
//
// This is a thin delegating hook: all rewrite logic lives in `rtk rewrite`, which is the single
// source of truth. The contract is the one of extensions/rtk.ts:
//
//   exit 0 + stdout  Rewrite found      → use the rewritten command
//   exit 1           No RTK equivalent  → pass through unchanged
//   exit 3 + stdout  Rewrite (advisory) → use the rewritten command
//
// A missing binary, a timeout or any other exit code leaves the command alone, and so does
// RTK_DISABLED=1, a command that already starts with `rtk `, or an rtk older than 0.23.0.
// The hook is fail-open: it never blocks a command.

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const REWRITE_TIMEOUT_MS = 2_000
const MIN_SUPPORTED_RTK_MINOR = 23

/** Parse "X.Y.Z" semver, return [major, minor, patch] or null. */
export function parseSemver(raw) {
  const match = String(raw ?? "").trim().match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)]
}

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

/** True when the installed rtk supports `rtk rewrite`. */
export function rtkIsSupported() {
  const version = spawnSync("rtk", ["--version"], { encoding: "utf8", timeout: REWRITE_TIMEOUT_MS })
  if (version.error || version.status !== 0) return false
  const parsed = parseSemver((version.stdout ?? "").replace(/^rtk\s+/, ""))
  if (parsed && parsed[0] === 0 && parsed[1] < MIN_SUPPORTED_RTK_MINOR) return false
  return true
}

/** The rewritten command, or null when the command must stay as it is. */
export function rewriteCommand(command) {
  const result = spawnSync("rtk", ["rewrite", command], {
    encoding: "utf8",
    timeout: REWRITE_TIMEOUT_MS,
  })
  if (result.error || result.status === null) return null
  if (result.status !== 0 && result.status !== 3) return null
  return (result.stdout ?? "").trim() || null
}

export function main() {
  const payload = readPayload()
  if (!payload) return

  try {
    if (payload.tool_name !== "Bash") return

    const toolInput = payload.tool_input ?? {}
    const command = typeof toolInput.command === "string" ? toolInput.command : ""
    if (!command.trim()) return

    if (command.startsWith("rtk ")) return
    if (process.env.RTK_DISABLED === "1") return
    if (!rtkIsSupported()) return

    const rewritten = rewriteCommand(command)
    if (!rewritten || rewritten === command) return

    // The whole tool input travels back, with the command changed.
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: { ...toolInput, command: rewritten },
        },
      })}\n`,
    )
  } catch {
    // Fail open: never block a command on an unexpected error.
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) main()
