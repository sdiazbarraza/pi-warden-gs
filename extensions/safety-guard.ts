// Safety guard — tool_call checks for pi sessions and their subagents.
//
// 1. bash: blocks destructive commands (container/volume deletion, prune,
//    compose down -v, git reset --hard, force push, git clean -f, sudo).
//    Matches anywhere in the command line, so chains and `git -C <path>` forms
//    are caught. This check stays fail-open: an internal error passes the call.
// 2. subagent_run, brief approval gate (fail-closed):
//    - gentle-ai-brief-review must run with mode "task" and receive the brief
//      inline between a line `<<<BRIEF` and a line `BRIEF>>>`. On a result with
//      `VERDICT: APPROVE`, the sha256 of that exact brief becomes a single-use
//      approval, persisted as a session entry so it survives reload/resume.
//    - gentle-ai-worker and gentle-ai-worker-infra launch only
//      when the sha256 of their brief (task + context) holds an unused approval.
//      Workers may skip the model review when the brief's first line is the small-fix marker; the instant brief-guard checks still run.
//    - Workers also pass the structure check of hooks/brief-guard.sh, which the Pi side forces
//      with BRIEF_GUARD_FORCE_STRUCTURE=1 so it cannot be inert or depend on repository config.
//    - Any internal error, or a brief-guard that cannot run, BLOCKS the dispatch.
// 3. subagent_continue / subagent_send_message to a writer task are
//    always blocked: new instructions need a new reviewed brief.
// 4. bash / bash_background / monitor: delivery commands (git push,
//    gh pr create|merge|edit) run only inside gentle-ai-publisher, recognized as
//    a gentle-pi child (GENTLE_PI_AGENTS_CHILD=1) whose appended system prompt
//    carries PUBLISHER_MARKER. Everywhere else they are blocked (fail-closed).
// 5. bash / bash_background / monitor: a command that names an environment file
//    (".env" or ".env.*", except the exact ".env.example") is blocked everywhere,
//    publisher included: environment files hold secrets.
// 6. bash / bash_background / monitor: builds, test runs and container runs
//    (dotnet-in-docker.sh, docker run|build|exec, docker compose up|run|build|exec)
//    run only in a gentle-pi child (GENTLE_PI_AGENTS_CHILD=1); the orchestrator must
//    delegate them. Read-only docker queries stay allowed (fail-closed).

import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const BRIEF_GUARD_TIMEOUT_MS = 5_000
const WRITER_AGENTS = new Set(["gentle-ai-worker", "gentle-ai-worker-infra"])
const GATED_AGENTS = new Set(["gentle-ai-worker", "gentle-ai-worker-infra"])
const REVIEWER = "gentle-ai-brief-review"
const SKIP_MARKER = "<!-- review: skipped (small fix) -->"
const APPROVAL = "pi-warden-gs.brief-approval"
const APPROVAL_USED = "pi-warden-gs.brief-approval-used"
const WRITER_TASK = "pi-warden-gs.writer-task"

function resolveBriefGuard(): string {
  const override = process.env.PI_WARDEN_GS_BRIEF_GUARD
  if (override) return override
  const fallback = join(homedir(), ".claude", "hooks", "brief-guard.sh")
  try {
    const local = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "brief-guard.sh")
    return existsSync(local) ? local : fallback
  } catch {
    return fallback
  }
}

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

// An environment file is named when a token ends in ".env" or ".env.*".
// The exact ".env.example" is the template, not a secret, and stays allowed.
export function envPathMatch(command: string): string | null {
  for (const token of command.split(ENV_TOKEN_SEPARATORS)) {
    if (!token) continue
    const base = trimShellPunctuation(baseName(trimTrailingSlash(trimShellPunctuation(token))))
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

export function normalizeBrief(text: string): string {
  return text.replace(/\r\n/g, "\n").trim()
}

export function briefOf(task: unknown, context: unknown): string {
  const t = typeof task === "string" ? task : ""
  const c = typeof context === "string" ? context : ""
  return normalizeBrief(c.trim() ? `${t}\n\n${c}` : t)
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

// The normalized text between a line `<<<BRIEF` and a line `BRIEF>>>`; null unless exactly one pair.
export function extractMarkedBrief(task: string): string | null {
  const lines = task.replace(/\r\n/g, "\n").split("\n")
  const starts = lines.flatMap((l, i) => (l === "<<<BRIEF" ? [i] : []))
  const ends = lines.flatMap((l, i) => (l === "BRIEF>>>" ? [i] : []))
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) return null
  return normalizeBrief(lines.slice(starts[0] + 1, ends[0]).join("\n"))
}

export function parseVerdict(text: string): "APPROVE" | "FIX" | null {
  const m = /^VERDICT:\s*(APPROVE|FIX)\b/m.exec(text)
  return m ? (m[1] as "APPROVE" | "FIX") : null
}

// Background launches report only "Started <agent> in the background as task <id>. ..." in text.
export function taskIdFromText(text: string): string | null {
  const m = /\bas task (\S+?)\.(?:\s|$)/.exec(text)
  return m ? m[1] : null
}

export function isSmallFixExempt(agent: string, brief: string): boolean {
  if (!WRITER_AGENTS.has(agent)) return false
  return normalizeBrief(brief).split("\n")[0] === SKIP_MARKER
}

/** Writer named outside <<<BRIEF / BRIEF>>> in a reviewer task; default gentle-ai-worker. */
export function writerAgentOfReviewTask(task: string): string {
  const lines = task.replace(/\r\n/g, "\n").split("\n")
  const start = lines.indexOf("<<<BRIEF")
  const end = lines.indexOf("BRIEF>>>")
  const outer =
    start >= 0 && end > start ? [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n") : task
  if (/\bgentle-ai-worker-infra\b/.test(outer)) return "gentle-ai-worker-infra"
  if (/\bgentle-ai-worker\b/.test(outer)) return "gentle-ai-worker"
  return "gentle-ai-worker"
}

type Entry = { customType?: string; data?: unknown }

function dataField(entry: Entry, key: string): string | null {
  const v = (entry.data as Record<string, unknown> | undefined)?.[key]
  return typeof v === "string" ? v : null
}

export class ApprovalStore {
  private counts = new Map<string, number>()
  add(hash: string): void {
    this.counts.set(hash, (this.counts.get(hash) ?? 0) + 1)
  }
  has(hash: string): boolean {
    return (this.counts.get(hash) ?? 0) > 0
  }
  consume(hash: string): boolean {
    const n = this.counts.get(hash) ?? 0
    if (n <= 0) return false
    if (n === 1) this.counts.delete(hash)
    else this.counts.set(hash, n - 1)
    return true
  }
  static fromEntries(entries: Entry[]): ApprovalStore {
    const store = new ApprovalStore()
    for (const e of entries) {
      const h = dataField(e, "sha256")
      if (!h) continue
      if (e.customType === APPROVAL) store.add(h)
      else if (e.customType === APPROVAL_USED) store.consume(h)
    }
    return store
  }
}

export class WriterTasks {
  private ids = new Set<string>()
  add(id: string): void {
    this.ids.add(id)
  }
  has(id: string): boolean {
    return this.ids.has(id)
  }
  static fromEntries(entries: Entry[]): WriterTasks {
    const tasks = new WriterTasks()
    for (const e of entries) {
      const id = e.customType === WRITER_TASK ? dataField(e, "taskId") : null
      if (id) tasks.add(id)
    }
    return tasks
  }
}

// Returns the rejection text, or null when the brief passes. Fail-closed.
export function briefRejection(agent: string, brief: string, cwd: string): string | null {
  if (!WRITER_AGENTS.has(agent)) return null
  const guard = resolveBriefGuard()
  const payload = JSON.stringify({ cwd, tool_input: { subagent_type: agent, prompt: brief } })
  const result = spawnSync(guard, [], {
    input: payload,
    encoding: "utf8",
    timeout: BRIEF_GUARD_TIMEOUT_MS,
    // The Pi side owns the brief contract for every project, so the structure check is forced
    // here instead of depending on a repository heading that made it silently inert.
    env: { ...process.env, BRIEF_GUARD_FORCE_STRUCTURE: "1" },
  })
  if (result.error) return `brief-guard could not run: ${result.error.message}`
  if (result.status === null) return `brief-guard could not run: terminated by ${result.signal ?? "unknown signal"}`
  if (result.status === 2) return (result.stderr ?? "").trim() || "brief-guard rejected the brief."
  return null
}

type SubagentInput = {
  agent?: unknown
  task?: unknown
  context?: unknown
  mode?: unknown
  task_id?: unknown
  workspace_root?: unknown
  repository_root?: unknown
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const NOT_APPROVED =
  'safety-guard: brief not approved. Run gentle-ai-brief-review with mode "task" and this exact text between <<<BRIEF and BRIEF>>>, then relaunch the identical text. Approvals are single-use.'
const WRITER_FOLLOWUP =
  "safety-guard: new instructions to a writer task are blocked; launch a new reviewed brief instead."

export default function (
  pi: ExtensionAPI,
  publisher = isPublisherProcess(process.env, process.argv),
  child = process.env.GENTLE_PI_AGENTS_CHILD === "1",
) {
  let approvals = new ApprovalStore()
  let writerTasks = new WriterTasks()
  const pendingReviews = new Map<string, string>()

  const rebuild = (ctx: unknown) => {
    try {
      const entries = ((ctx as { sessionManager: { getBranch(): Entry[] } }).sessionManager.getBranch() ?? []) as Entry[]
      approvals = ApprovalStore.fromEntries(entries)
      writerTasks = WriterTasks.fromEntries(entries)
    } catch (err) {
      console.warn("[safety-guard] could not rebuild state from the session", err)
    }
  }
  pi.on("session_start", async (_event, ctx) => rebuild(ctx))
  pi.on("session_tree", async (_event, ctx) => rebuild(ctx))

  pi.on("tool_call", async (event, ctx) => {
    if (SHELL_TOOLS.has(event.toolName)) {
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
      return
    }

    if (event.toolName === "subagent_run") {
      try {
        const input = event.input as SubagentInput
        const agent = text(input.agent)
        const task = text(input.task)

        if (agent === REVIEWER) {
          if (input.mode !== "task") {
            return { block: true, reason: 'safety-guard: gentle-ai-brief-review must run with mode "task".' }
          }
          const marked = extractMarkedBrief(task)
          if (marked === null) {
            return {
              block: true,
              reason:
                "safety-guard: put the exact brief inline in the task, between a line `<<<BRIEF` and a line `BRIEF>>>` (exactly one pair).",
            }
          }
          if (/^VERDICT:/m.test(marked)) {
            return { block: true, reason: "safety-guard: the brief text must not contain a line starting with `VERDICT:`." }
          }
          const cwd =
            text(input.workspace_root) || text(input.repository_root) || text((ctx as { cwd?: unknown }).cwd) || process.cwd()
          const rejection = briefRejection(writerAgentOfReviewTask(task), marked, cwd)
          if (rejection) return { block: true, reason: rejection }
          pendingReviews.set(event.toolCallId, sha256(marked))
          return
        }

        if (WRITER_AGENTS.has(agent) || GATED_AGENTS.has(agent)) {
          const brief = briefOf(task, input.context)
          const cwd =
            text(input.workspace_root) || text(input.repository_root) || text((ctx as { cwd?: unknown }).cwd) || process.cwd()
          if (WRITER_AGENTS.has(agent)) {
            const rejection = briefRejection(agent, brief, cwd)
            if (rejection) return { block: true, reason: rejection }
          }
          // Small-fix skips the model review only; the instant guard still runs above.
          if (isSmallFixExempt(agent, brief)) return
          const hash = sha256(brief)
          if (!approvals.consume(hash)) return { block: true, reason: NOT_APPROVED }
          pi.appendEntry(APPROVAL_USED, { sha256: hash })
        }
      } catch (err) {
        return {
          block: true,
          reason: `safety-guard: internal error (${errMessage(err)}); writer dispatch blocked (fail-closed).`,
        }
      }
      return
    }

    if (event.toolName === "subagent_continue" || event.toolName === "subagent_send_message") {
      try {
        const id = text((event.input as SubagentInput).task_id)
        if (id && writerTasks.has(id)) return { block: true, reason: WRITER_FOLLOWUP }
      } catch (err) {
        return {
          block: true,
          reason: `safety-guard: internal error (${errMessage(err)}); follow-up blocked (fail-closed).`,
        }
      }
    }
  })

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "subagent_run") return
    try {
      const input = event.input as SubagentInput
      const agent = text(input.agent)
      if (agent === REVIEWER) {
        const hash = pendingReviews.get(event.toolCallId)
        pendingReviews.delete(event.toolCallId)
        if (!hash || event.isError) return
        const body = (event.content ?? [])
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("\n")
        if (parseVerdict(body) === "APPROVE") {
          approvals.add(hash)
          pi.appendEntry(APPROVAL, { sha256: hash, at: new Date().toISOString() })
        }
        return
      }
      if (GATED_AGENTS.has(agent)) {
        const details = (event as { details?: { gentleAgents?: { taskId?: unknown } } }).details
        const body = (event.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n")
        const taskId = typeof details?.gentleAgents?.taskId === "string" ? details.gentleAgents.taskId : taskIdFromText(body)
        if (typeof taskId === "string" && taskId) {
          writerTasks.add(taskId)
          pi.appendEntry(WRITER_TASK, { taskId, agent })
        }
      }
    } catch (err) {
      console.warn("[safety-guard] tool_result handling failed", err)
    }
  })
}
