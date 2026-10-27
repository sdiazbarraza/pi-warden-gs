#!/usr/bin/env node
// Safety guard — the Claude Code PreToolUse hook.
//
// It carries the guard layer Pi has in extensions/safety-guard.ts:
//
// 1. Bash: destructive commands (container/volume deletion, prune, compose down -v,
//    git reset --hard, force push, git clean -f, sudo) are blocked. The check is fail-open:
//    an internal error lets the command through.
// 2. Bash: builds, test runs and container runs (docker run|build|exec, docker compose
//    up|run|build|exec, the dotnet-in-docker.sh wrapper) run only in a subagent. Read-only
//    docker queries stay allowed. Fail-closed.
// 3. Bash: delivery commands (git push, gh pr create|merge|edit) run only inside
//    gentle-ai-publisher. Everywhere else they are blocked. Fail-closed.
// 4. Bash: a command that names an environment file (".env" or ".env.*", except the
//    exact ".env.example") is blocked everywhere, publisher included: environment
//    files hold secrets. Fail-closed.
// 5. Agent: gentle-ai-brief-review must run in the foreground with the brief inline between
//    a line `<<<BRIEF` and a line `BRIEF>>>` (exactly one pair), and the brief must not carry
//    a `VERDICT:` line.
// 6. Agent: gentle-ai-worker and gentle-ai-worker-infra need an approved brief — the brief
//    must pass the structural contract of hooks/brief-guard.sh and the sha256 of the
//    normalized brief must hold an unused approval for this session. Fail-closed.
// 7. SendMessage: new instructions to a writer task are blocked.
//
// The matching logic is a port of the Pi extension, not a rewrite: the labels and the
// patterns are identical, and tests/claude-differential.test.ts runs the same corpus through
// both implementations.

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { agentTypeOf } from "./lib/agent-context.mjs"
import { consume, normalizeBrief, sha256 } from "./lib/approvals.mjs"

const BRIEF_GUARD_TIMEOUT_MS = 5_000
const WRITER_AGENTS = new Set(["gentle-ai-worker", "gentle-ai-worker-infra"])
const REVIEWER = "gentle-ai-brief-review"
const PUBLISHER = "gentle-ai-publisher"
const SKIP_MARKER = "<!-- review: skipped (small fix) -->"

// [pattern, label] — a match blocks the command.
const DESTRUCTIVE = [
  [/\bdocker\s+(container\s+)?rm\b/, "docker rm"],
  [/\bdocker\s+volume\s+rm\b/, "docker volume rm"],
  [/\bdocker\s+(system|container|image|volume|network|builder)\s+prune\b/, "docker prune"],
  [/\bdocker\s+compose\b[^;&|]*\bdown\b[^;&|]*\s(-v|--volumes)\b/, "docker compose down -v"],
  [/\bgit\b[^;&|]*\breset\s+--hard\b/, "git reset --hard"],
  [/\bgit\b[^;&|]*\bpush\b[^;&|]*\s(--force\b|--force-with-lease\b|-f\b)/, "git push --force"],
  [/\bgit\b[^;&|]*\bclean\s+-\w*f/, "git clean -f"],
  [/(^|[;&|(]|\s)sudo\s/, "sudo"],
]

// Heredoc bodies fed to these read-only text tools are data, not commands.
// Shells, interpreters, cat and tee keep their bodies checked: they can run or persist the text.
const TEXT_ONLY_CONSUMERS = new Set(["wc", "grep", "egrep", "fgrep", "head", "tail", "jq", "diff", "cmp", "sort", "uniq"])
const HEREDOC = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g

function heredocConsumer(line, at) {
  const segment = line.slice(0, at).split(/[;&|(]|\$\(/).pop() ?? ""
  const words = segment.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
  return (words[0] ?? "").split("/").pop() ?? ""
}

/** Removes heredoc bodies whose consumer only reads text; everything else stays checkable. */
export function stripReadOnlyHeredocs(command) {
  const lines = command.split("\n")
  const kept = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    kept.push(line)
    for (const match of line.matchAll(HEREDOC)) {
      const [, dash, , delimiter] = match
      let end = i + 1
      while (end < lines.length && (dash ? lines[end].replace(/^\t+/, "") : lines[end]) !== delimiter) end++
      if (TEXT_ONLY_CONSUMERS.has(heredocConsumer(line, match.index ?? 0)) && end < lines.length) {
        kept.push(lines[end])
        i = end
        break
      }
    }
  }
  return kept.join("\n")
}

/** The label of the first destructive pattern the command hits, or null. */
export function destructiveMatch(command) {
  const checked = stripReadOnlyHeredocs(command)
  for (const [pattern, label] of DESTRUCTIVE) {
    if (pattern.test(checked)) return label
  }
  return null
}

// Git and gh global options may sit between the binary and the subcommand.
const GIT_GLOBALS = String.raw`(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*`
const GH_GLOBALS = String.raw`(?:\s+(?:-R\s+\S+|--repo(?:=|\s+)\S+))*`
const DELIVERY = [
  [new RegExp(String.raw`\bgit${GIT_GLOBALS}\s+push\b`), "git push"],
  [new RegExp(String.raw`\bgh${GH_GLOBALS}\s+pr\s+(create|merge|edit)\b`), "gh pr"],
]

// Builds, test runs and container runs belong to subagents; read-only docker queries stay allowed.
const HEAVY = [
  [/\bdocker\s+(run|build|exec)\b/, "docker"],
  [/\bdocker(?:\s+compose|-compose)\b[^;&|\n]*\s(up|run|build|exec)\b/, "docker compose"],
]

const WRAPPERS = new Set(["timeout", "time", "exec", "nohup", "env", "bash", "sh", "zsh"])

/** True when a shell segment executes the build wrapper; reading or diffing it does not count. */
function runsBuildWrapper(command) {
  for (const segment of command.split(/&&|\|\||[;|(\n]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean)
    let i = 0
    while (
      i < words.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || WRAPPERS.has(words[i]) || /^-/.test(words[i]) || /^\d+[smh]?$/.test(words[i]))
    ) {
      i++
    }
    if (i < words.length && /(^|\/)dotnet-in-docker\.sh$/.test(words[i])) return true
  }
  return false
}

/** The label of the first heavy pattern the command hits, or null. */
export function heavyMatch(command) {
  const checked = stripReadOnlyHeredocs(command)
  if (runsBuildWrapper(checked)) return "dotnet-in-docker.sh"
  for (const [pattern, label] of HEAVY) {
    const match = pattern.exec(checked)
    if (match) return `${label} ${match[1]}`
  }
  return null
}

/** The label of the first delivery pattern the command hits, or null. */
export function deliveryMatch(command) {
  const checked = stripReadOnlyHeredocs(command)
  for (const [pattern, label] of DELIVERY) {
    const match = pattern.exec(checked)
    if (match) return match[1] ? `${label} ${match[1]}` : label
  }
  return null
}

/** The basename of a token: the last component after the "/" and ":" separators. */
function baseName(token) {
  return token.split(/[/:]/).pop() ?? ""
}

/** Shell punctuation is syntax, not part of the path: "('.env')" names .env. */
const SHELL_PUNCTUATION = new Set(['"', "'", "`", ";", ",", "(", ")", "[", "]", "{", "}"])

/** Shell operators are token separators, not part of a path: "cat .env|tee" names .env. */
const ENV_TOKEN_SEPARATORS = /[\s|;&<>]+/

/** A trailing slash belongs to the path syntax, not to the name: "ls .env/" names .env. */
function trimTrailingSlash(token) {
  return token.replace(/\/+$/, "")
}

/** Removes the leading and trailing shell punctuation of a name; its own dots stay. */
function trimShellPunctuation(token) {
  let out = token
  for (;;) {
    const first = out.length > 0 && SHELL_PUNCTUATION.has(out[0]) ? 1 : 0
    const last = out.length > 0 && SHELL_PUNCTUATION.has(out[out.length - 1]) ? out.length - 1 : out.length
    if (first === 0 && last === out.length) return out
    out = out.slice(first, last)
  }
}

/**
 * The name of the environment file the command reads, or null.
 * A token ending in ".env" or ".env.*" names one; the exact ".env.example"
 * is the template, not a secret, and stays allowed.
 */
export function envPathMatch(command) {
  for (const token of String(command ?? "").split(ENV_TOKEN_SEPARATORS)) {
    if (!token) continue
    const base = trimShellPunctuation(baseName(trimTrailingSlash(trimShellPunctuation(token))))
    if (base === ".env.example") continue
    if (base === ".env" || base.startsWith(".env.")) return base
  }
  return null
}

// --- messages (the Pi wording, kept verbatim) ------------------------------

export const destructiveBlocked = (label) =>
  `safety-guard: "${label}" is blocked. If the human explicitly authorized it, ask them to run it themselves.`
export const heavyBlocked = (label) =>
  `safety-guard: "${label}" runs only in a subagent. Delegate it to gentle-ai-runner (commands only) or gentle-ai-worker-infra (when it also edits files). If they are unavailable, stop and tell the human instead of running it here.`
export const deliveryBlocked = (label) =>
  `safety-guard: "${label}" runs only inside gentle-ai-publisher. Delegate the exact git/gh commands to gentle-ai-publisher (mode "task") with the human's authorization.`
export const envBlocked = (label) =>
  `safety-guard: "${label}" is blocked. Environment files hold secrets and must not be read by an agent. If the human explicitly authorized it, ask them to run it themselves.`
export const NOT_APPROVED =
  'safety-guard: brief not approved. Run gentle-ai-brief-review with mode "task" and this exact text between <<<BRIEF and BRIEF>>>, then relaunch the identical text. Approvals are single-use.'
export const WRITER_FOLLOWUP =
  "safety-guard: new instructions to a writer task are blocked; launch a new reviewed brief instead."
export const REVIEWER_MODE = 'safety-guard: gentle-ai-brief-review must run with mode "task".'
export const MISSING_MARKERS =
  "safety-guard: put the exact brief inline in the task, between a line `<<<BRIEF` and a line `BRIEF>>>` (exactly one pair)."
export const VERDICT_IN_BRIEF = "safety-guard: the brief text must not contain a line starting with `VERDICT:`."

// --- brief helpers ---------------------------------------------------------

/** The normalized text between a line `<<<BRIEF` and a line `BRIEF>>>`; null unless exactly one pair. */
export function extractMarkedBrief(task) {
  const lines = String(task ?? "").replace(/\r\n/g, "\n").split("\n")
  const starts = lines.flatMap((line, i) => (line === "<<<BRIEF" ? [i] : []))
  const ends = lines.flatMap((line, i) => (line === "BRIEF>>>" ? [i] : []))
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) return null
  return normalizeBrief(lines.slice(starts[0] + 1, ends[0]).join("\n"))
}

/** The verdict a reviewer reported, or null. */
export function parseVerdict(text) {
  const match = /^VERDICT:\s*(APPROVE|FIX)\b/m.exec(String(text ?? ""))
  return match ? match[1] : null
}

/** True when the brief opts out of the review with the small-fix marker. */
export function isSmallFixExempt(agent, brief) {
  if (!WRITER_AGENTS.has(agent)) return false
  return normalizeBrief(brief).split("\n")[0] === SKIP_MARKER
}

/** Writer named outside <<<BRIEF / BRIEF>>> in a reviewer task; default gentle-ai-worker. */
export function writerAgentOfReviewTask(task) {
  const lines = String(task ?? "").replace(/\r\n/g, "\n").split("\n")
  const start = lines.indexOf("<<<BRIEF")
  const end = lines.indexOf("BRIEF>>>")
  const outer =
    start >= 0 && end > start ? [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n") : String(task ?? "")
  if (/\bgentle-ai-worker-infra\b/.test(outer)) return "gentle-ai-worker-infra"
  if (/\bgentle-ai-worker\b/.test(outer)) return "gentle-ai-worker"
  return "gentle-ai-worker"
}

function resolveBriefGuard() {
  const override = (process.env.CLAUDE_WARDEN_BRIEF_GUARD ?? "").trim()
  if (override) return override
  const shared = join(homedir(), ".claude", "hooks", "brief-guard.sh")
  try {
    const local = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "brief-guard.sh")
    return existsSync(shared) ? shared : local
  } catch {
    return shared
  }
}

/**
 * The rejection of the structural contract, or null when the brief passes. Fail-closed:
 * a guard that cannot run rejects the brief.
 */
export function briefRejection(agent, brief, cwd) {
  if (!WRITER_AGENTS.has(agent)) return null
  const guard = resolveBriefGuard()
  const payload = JSON.stringify({ cwd, tool_input: { subagent_type: agent, prompt: brief } })
  const result = spawnSync(guard, [], {
    input: payload,
    encoding: "utf8",
    timeout: BRIEF_GUARD_TIMEOUT_MS,
    // The brief contract belongs to the package for every project, so the structure check is
    // forced here instead of depending on a repository heading that made it silently inert.
    env: { ...process.env, BRIEF_GUARD_FORCE_STRUCTURE: "1" },
  })
  if (result.error) return `brief-guard could not run: ${result.error.message}`
  if (result.status === null) return `brief-guard could not run: terminated by ${result.signal ?? "unknown signal"}`
  if (result.status === 2) return (result.stderr ?? "").trim() || "brief-guard rejected the brief."
  return null
}

// --- hook plumbing ---------------------------------------------------------

function errMessage(err) {
  return err instanceof Error ? err.message : String(err)
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

function deny(reason) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })}\n`,
  )
}

function text(value) {
  return typeof value === "string" ? value : ""
}

function handleBash(payload) {
  const command = text(payload?.tool_input?.command)

  try {
    const label = destructiveMatch(command)
    if (label) {
      deny(destructiveBlocked(label))
      return
    }
  } catch (err) {
    // Fail-open: an internal error lets the command through.
    process.stderr.write(`[safety-guard] unexpected error; passing the command through: ${errMessage(err)}\n`)
  }

  const agentType = agentTypeOf(payload?.transcript_path)
  if (agentType === null) {
    // Builds, test runs and container runs belong to a subagent.
    try {
      const label = heavyMatch(command)
      if (label) {
        deny(heavyBlocked(label))
        return
      }
    } catch (err) {
      deny(`safety-guard: internal error (${errMessage(err)}); command check blocked (fail-closed).`)
      return
    }
  }

  // Environment files hold secrets: blocked everywhere, publisher included.
  try {
    const label = envPathMatch(command)
    if (label) {
      deny(envBlocked(label))
      return
    }
  } catch (err) {
    deny(`safety-guard: internal error (${errMessage(err)}); command check blocked (fail-closed).`)
    return
  }

  if (agentType === PUBLISHER) return

  try {
    const label = deliveryMatch(command)
    if (label) {
      deny(deliveryBlocked(label))
      return
    }
  } catch (err) {
    deny(`safety-guard: internal error (${errMessage(err)}); delivery check blocked (fail-closed).`)
  }
}

function handleAgent(payload) {
  const input = payload?.tool_input ?? {}
  const agent = text(input.subagent_type)

  if (agent === REVIEWER) {
    // The reviewer must run in the foreground: a background launch has no result to read.
    if (input.run_in_background === true || input.run_in_background === "true") {
      deny(REVIEWER_MODE)
      return
    }
    const marked = extractMarkedBrief(text(input.prompt))
    if (marked === null) {
      deny(MISSING_MARKERS)
      return
    }
    if (/^VERDICT:/m.test(marked)) {
      deny(VERDICT_IN_BRIEF)
      return
    }
    const cwd = text(payload?.cwd) || process.cwd()
    const rejection = briefRejection(writerAgentOfReviewTask(text(input.prompt)), marked, cwd)
    if (rejection) {
      deny(rejection)
      return
    }
    return
  }

  if (!WRITER_AGENTS.has(agent)) return

  try {
    const brief = normalizeBrief(text(input.prompt))
    const cwd = text(payload?.cwd) || process.cwd()
    const rejection = briefRejection(agent, brief, cwd)
    if (rejection) {
      deny(rejection)
      return
    }
    // Small-fix skips the model review only; the instant guard still runs above.
    if (isSmallFixExempt(agent, brief)) return

    const hash = sha256(brief)
    if (!consume(hash, text(payload?.session_id))) {
      deny(NOT_APPROVED)
      return
    }
  } catch (err) {
    deny(`safety-guard: internal error (${errMessage(err)}); writer dispatch blocked (fail-closed).`)
  }
}

/** The target of a SendMessage: a name, or an id that says nothing about the agent. */
function sendMessageTarget(input) {
  for (const field of ["to", "agent", "target", "name", "recipient"]) {
    const value = input?.[field]
    if (typeof value === "string" && value.trim()) return value
  }
  return ""
}

function isWriterTarget(target) {
  const name = target.replace(/\s*\[[^\]]*\]\s*$/, "").trim()
  return WRITER_AGENTS.has(name)
}

function handleSendMessage(payload) {
  try {
    const target = sendMessageTarget(payload?.tool_input ?? {})
    // Fail-open: a target that cannot be determined is not blocked.
    if (target && isWriterTarget(target)) {
      deny(WRITER_FOLLOWUP)
    }
  } catch (err) {
    // Fail-closed, like the Pi side: an internal error blocks the follow-up.
    deny(`safety-guard: internal error (${errMessage(err)}); follow-up blocked (fail-closed).`)
  }
}

export function main() {
  const payload = readPayload()
  if (!payload) return

  const toolName = text(payload.tool_name)
  if (toolName === "Bash") {
    handleBash(payload)
    return
  }
  if (toolName === "Agent" || toolName === "Task") {
    handleAgent(payload)
    return
  }
  if (toolName === "SendMessage") {
    handleSendMessage(payload)
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) main()
