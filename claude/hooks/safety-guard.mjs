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
//
// The matching logic is a port of the Pi extension, not a rewrite: the labels and the
// patterns are identical, and tests/claude-differential.test.ts runs the same corpus through
// both implementations.

import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

import { agentTypeOf } from "./lib/agent-context.mjs"

const PUBLISHER = "gentle-ai-publisher"

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

/** Quotes are shell syntax, not part of the path: "cat .e''nv" names .env. */
function removeQuotes(token) {
  return token.replace(/["']/g, "")
}

/**
 * The name of the environment file the command reads, or null.
 * A token ending in ".env" or ".env.*" names one; the exact ".env.example"
 * is the template, not a secret, and stays allowed.
 * The rule matches a literal path: the quotes inside a token are removed before
 * the name is compared, and a path assembled by shell expansion is not detected.
 */
export function envPathMatch(command) {
  for (const token of String(command ?? "").split(ENV_TOKEN_SEPARATORS)) {
    if (!token) continue
    const base = trimShellPunctuation(baseName(trimTrailingSlash(trimShellPunctuation(removeQuotes(token)))))
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

export function main() {
  const payload = readPayload()
  if (!payload) return

  const toolName = text(payload.tool_name)
  if (toolName === "Bash") {
    handleBash(payload)
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url
if (invokedDirectly) main()
