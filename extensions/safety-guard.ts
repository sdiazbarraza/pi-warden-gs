// Safety guard — tool_call checks for pi sessions and their subagents.
//
// 1. bash: blocks destructive commands (container/volume deletion, prune,
//    compose down -v, git reset --hard, force push, git clean -f, sudo).
//    Matches anywhere in the command line, so chains and `git -C <path>` forms
//    are caught. This check stays fail-open: an internal error passes the call.
// 2. bash / bash_background / monitor: delivery commands (git push,
//    gh pr create|merge|edit) run only inside gentle-ai-publisher, recognized as
//    a gentle-pi child (GENTLE_PI_AGENTS_CHILD=1) whose appended system prompt
//    carries PUBLISHER_MARKER. Everywhere else they are blocked (fail-closed).
// 3. bash / bash_background / monitor: a command that names an environment file
//    (".env" or ".env.*", except the exact ".env.example") is blocked everywhere,
//    publisher included: environment files hold secrets.
// 4. bash / bash_background / monitor: builds, test runs and container runs
//    (dotnet-in-docker.sh, docker run|build|exec, docker compose up|run|build|exec)
//    run only in a gentle-pi child (GENTLE_PI_AGENTS_CHILD=1); the orchestrator must
//    delegate them. Read-only docker queries stay allowed (fail-closed).

import { existsSync, readFileSync } from "node:fs"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

// [pattern, label] — a match blocks the command.
const DESTRUCTIVE: Array<[RegExp, string]> = [
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

function heredocConsumer(line: string, at: number): string {
  const segment = line.slice(0, at).split(/[;&|(]|\$\(/).pop() ?? ""
  const words = segment.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
  return (words[0] ?? "").split("/").pop() ?? ""
}

// Removes heredoc bodies whose consumer only reads text; everything else stays checkable.
export function stripReadOnlyHeredocs(command: string): string {
  const lines = command.split("\n")
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    kept.push(line)
    for (const m of line.matchAll(HEREDOC)) {
      const [, dash, , delimiter] = m
      let end = i + 1
      while (end < lines.length && (dash ? lines[end].replace(/^\t+/, "") : lines[end]) !== delimiter) end++
      if (TEXT_ONLY_CONSUMERS.has(heredocConsumer(line, m.index ?? 0)) && end < lines.length) {
        kept.push(lines[end])
        i = end
        break
      }
    }
  }
  return kept.join("\n")
}

export function destructiveMatch(command: string): string | null {
  const checked = stripReadOnlyHeredocs(command)
  for (const [pattern, label] of DESTRUCTIVE) {
    if (pattern.test(checked)) return label
  }
  return null
}

// Shell tools whose command input is checked (gentle-pi SHELL_COMMAND_TOOLS).
const SHELL_TOOLS = new Set(["bash", "bash_background", "monitor"])

// Git and gh global options may sit between the binary and the subcommand.
const GIT_GLOBALS = String.raw`(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*`
const GH_GLOBALS = String.raw`(?:\s+(?:-R\s+\S+|--repo(?:=|\s+)\S+))*`
const DELIVERY: Array<[RegExp, string]> = [
  [new RegExp(String.raw`\bgit${GIT_GLOBALS}\s+push\b`), "git push"],
  [new RegExp(String.raw`\bgh${GH_GLOBALS}\s+pr\s+(create|merge|edit)\b`), "gh pr"],
]

export const PUBLISHER_MARKER = "<!-- pi-warden-gs:agent=gentle-ai-publisher -->"

// Builds, test runs and container runs belong to subagents; read-only docker queries stay allowed.
const HEAVY: Array<[RegExp, string]> = [
  [/\bdocker\s+(run|build|exec)\b/, "docker"],
  [/\bdocker(?:\s+compose|-compose)\b[^;&|\n]*\s(up|run|build|exec)\b/, "docker compose"],
]

const WRAPPERS = new Set(["timeout", "time", "exec", "nohup", "env", "bash", "sh", "zsh"])

// True when a shell segment executes the build wrapper; reading or diffing it does not count.
function runsBuildWrapper(command: string): boolean {
  for (const segment of command.split(/&&|\|\||[;|(\n]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean)
    let i = 0
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || WRAPPERS.has(words[i]) || /^-/.test(words[i]) || /^\d+[smh]?$/.test(words[i]))) i++
    if (i < words.length && /(^|\/)dotnet-in-docker\.sh$/.test(words[i])) return true
  }
  return false
}

export function heavyMatch(command: string): string | null {
  const checked = stripReadOnlyHeredocs(command)
  if (runsBuildWrapper(checked)) return "dotnet-in-docker.sh"
  for (const [pattern, label] of HEAVY) {
    const m = pattern.exec(checked)
    if (m) return `${label} ${m[1]}`
  }
  return null
}

const HEAVY_BLOCKED = (label: string) =>
  `safety-guard: "${label}" runs only in a subagent. Delegate it to gentle-ai-runner (commands only) or gentle-ai-worker-infra (when it also edits files). If they are unavailable, stop and tell the human instead of running it here.`

export function deliveryMatch(command: string): string | null {
  const checked = stripReadOnlyHeredocs(command)
  for (const [pattern, label] of DELIVERY) {
    const m = pattern.exec(checked)
    if (m) return m[1] ? `${label} ${m[1]}` : label
  }
  return null
}

// The basename of a token: the last component after the "/" and ":" separators.
function baseName(token: string): string {
  return token.split(/[/:]/).pop() ?? ""
}

// Shell punctuation is syntax, not part of the path: "('.env')" names .env.
const SHELL_PUNCTUATION = new Set(['"', "'", "`", ";", ",", "(", ")", "[", "]", "{", "}"])

// Shell operators are token separators, not part of a path: "cat .env|tee" names .env.
const ENV_TOKEN_SEPARATORS = /[\s|;&<>]+/

// A trailing slash belongs to the path syntax, not to the name: "ls .env/" names .env.
function trimTrailingSlash(token: string): string {
  return token.replace(/\/+$/, "")
}

// Removes the leading and trailing shell punctuation of a name; its own dots stay.
function trimShellPunctuation(token: string): string {
  let out = token
  for (;;) {
    const first = out.length > 0 && SHELL_PUNCTUATION.has(out[0]) ? 1 : 0
    const last = out.length > 0 && SHELL_PUNCTUATION.has(out[out.length - 1]) ? out.length - 1 : out.length
    if (first === 0 && last === out.length) return out
    out = out.slice(first, last)
  }
}

// Quotes are shell syntax, not part of the path: "cat .e''nv" names .env.
function removeQuotes(token: string): string {
  return token.replace(/["']/g, "")
}

// An environment file is named when a token ends in ".env" or ".env.*".
// The exact ".env.example" is the template, not a secret, and stays allowed.
// The rule matches a literal path: the quotes inside a token are removed before
// the name is compared, and a path assembled by shell expansion is not detected.
export function envPathMatch(command: string): string | null {
  for (const token of command.split(ENV_TOKEN_SEPARATORS)) {
    if (!token) continue
    const base = trimShellPunctuation(baseName(trimTrailingSlash(trimShellPunctuation(removeQuotes(token)))))
    if (base === ".env.example") continue
    if (base === ".env" || base.startsWith(".env.")) return base
  }
  return null
}

// True only in a gentle-pi child whose appended system prompt (inline or a file path) has the publisher marker.
export function isPublisherProcess(env: Record<string, string | undefined>, argv: string[]): boolean {
  if (env.GENTLE_PI_AGENTS_CHILD !== "1") return false
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== "--append-system-prompt") continue
    const value = argv[i + 1]
    let prompt = value
    try {
      if (!value.includes("\n") && existsSync(value)) prompt = readFileSync(value, "utf8")
    } catch {
      continue
    }
    if (prompt.includes(PUBLISHER_MARKER)) return true
  }
  return false
}

const DELIVERY_BLOCKED = (label: string) =>
  `safety-guard: "${label}" runs only inside gentle-ai-publisher. Delegate the exact git/gh commands to gentle-ai-publisher (mode "task") with the human's authorization.`

const ENV_BLOCKED = (label: string) =>
  `safety-guard: "${label}" is blocked. Environment files hold secrets and must not be read by an agent. If the human explicitly authorized it, ask them to run it themselves.`

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default function (
  pi: ExtensionAPI,
  publisher = isPublisherProcess(process.env, process.argv),
  child = process.env.GENTLE_PI_AGENTS_CHILD === "1",
) {
  pi.on("tool_call", async (event) => {
    if (!SHELL_TOOLS.has(event.toolName)) return
    const command = text((event.input as { command?: unknown }).command)
    try {
      const label = destructiveMatch(command)
      if (label) {
        return {
          block: true,
          reason: `safety-guard: "${label}" is blocked. If the human explicitly authorized it, ask them to run it themselves.`,
        }
      }
    } catch (err) {
      console.warn("[safety-guard] unexpected error; passing the call through", err)
    }
    if (!child) {
      try {
        const label = heavyMatch(command)
        if (label) return { block: true, reason: HEAVY_BLOCKED(label) }
      } catch (err) {
        return { block: true, reason: `safety-guard: internal error (${errMessage(err)}); command check blocked (fail-closed).` }
      }
    }
    // Environment files hold secrets: blocked everywhere, publisher included.
    try {
      const label = envPathMatch(command)
      if (label) return { block: true, reason: ENV_BLOCKED(label) }
    } catch (err) {
      return { block: true, reason: `safety-guard: internal error (${errMessage(err)}); command check blocked (fail-closed).` }
    }
    if (publisher) return
    try {
      const label = deliveryMatch(command)
      if (label) return { block: true, reason: DELIVERY_BLOCKED(label) }
    } catch (err) {
      return { block: true, reason: `safety-guard: internal error (${errMessage(err)}); delivery check blocked (fail-closed).` }
    }
  })
}
