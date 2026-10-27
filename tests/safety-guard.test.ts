import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import guard, {
  ApprovalStore,
  WriterTasks,
  PUBLISHER_MARKER,
  briefOf,
  briefRejection,
  deliveryMatch,
  heavyMatch,
  destructiveMatch,
  isPublisherProcess,
  extractMarkedBrief,
  isSmallFixExempt,
  taskIdFromText,
  normalizeBrief,
  parseVerdict,
  sha256,
} from "../extensions/safety-guard.ts"

const SKIP = "<!-- review: skipped (small fix) -->"

// Fixtures for the two integration tests must satisfy the brief contract now enforced on the Pi
// side, so an approvable brief is represented by all required sections in order.
const CONTRACT_BRIEF = `## Objective
Do it

## Preconditions
On expected branch feat/example; HEAD is that tip; tree is clean (git status --short).

## Steps
1. do it
If a step fails for a reason this brief does not cover, stop and report it; never change the planned design on your own.

## Allowed edit surfaces
src/a.ts

## Verification
node --test tests/safety-guard.test.ts

## Acceptance criteria
it works

## Architecture constraints
none

## Report
one line
`

test("normalizeBrief converts CRLF and trims", () => {
  assert.equal(normalizeBrief("\r\n a\r\nb \r\n"), "a\nb")
})

test("briefOf joins context only when non-empty", () => {
  assert.equal(briefOf("task", "ctx"), "task\n\nctx")
  assert.equal(briefOf("task", "   "), "task")
  assert.equal(briefOf("task", undefined), "task")
  assert.equal(briefOf("a\r\nb", ""), "a\nb")
})

test("sha256 is hex", () => {
  assert.match(sha256("x"), /^[0-9a-f]{64}$/)
})

test("extractMarkedBrief handles one pair, none and two pairs", () => {
  assert.equal(extractMarkedBrief("intro\n<<<BRIEF\r\nhello\nworld\nBRIEF>>>\nrest"), "hello\nworld")
  assert.equal(extractMarkedBrief("no markers"), null)
  assert.equal(extractMarkedBrief("<<<BRIEF\na\nBRIEF>>>\n<<<BRIEF\nb\nBRIEF>>>"), null)
})

test("parseVerdict", () => {
  const header = 'Subagent gentle-ai-brief-review (task t1, "x") finished.\n\nfindings\nVERDICT: APPROVE\n'
  assert.equal(parseVerdict(header), "APPROVE")
  assert.equal(parseVerdict("VERDICT: FIX"), "FIX")
  assert.equal(parseVerdict("nothing"), null)
})

test("isSmallFixExempt", () => {
  assert.equal(isSmallFixExempt("gentle-ai-worker", `${SKIP}\nbody`), true)
  assert.equal(isSmallFixExempt("gentle-ai-runner", `${SKIP}\nbody`), false)
  assert.equal(isSmallFixExempt("gentle-ai-worker", `body\n${SKIP}`), false)
})

test("ApprovalStore is single-use and rebuilds from entries", () => {
  const s = new ApprovalStore()
  s.add("h")
  assert.equal(s.has("h"), true)
  assert.equal(s.consume("h"), true)
  assert.equal(s.consume("h"), false)
  const r = ApprovalStore.fromEntries([
    { customType: "pi-warden-gs.brief-approval", data: { sha256: "a" } },
    { customType: "pi-warden-gs.brief-approval", data: { sha256: "b" } },
    { customType: "pi-warden-gs.brief-approval-used", data: { sha256: "a" } },
    { customType: "other", data: { sha256: "c" } },
  ])
  assert.equal(r.has("a"), false)
  assert.equal(r.has("b"), true)
  assert.equal(r.has("c"), false)
})

test("WriterTasks rebuilds from entries", () => {
  const w = WriterTasks.fromEntries([{ customType: "pi-warden-gs.writer-task", data: { taskId: "t9", agent: "x" } }])
  assert.equal(w.has("t9"), true)
  assert.equal(w.has("t1"), false)
})

test("destructiveMatch", () => {
  assert.equal(destructiveMatch("git reset --hard HEAD"), "git reset --hard")
  assert.equal(destructiveMatch("git status"), null)
})

type Handler = (event: any, ctx: any) => any
function setup(publisher = false, child = publisher) {
  const handlers = new Map<string, Handler[]>()
  const entries: Array<{ type: "custom"; customType: string; data: any }> = []
  const pi = {
    on: (name: string, h: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), h])
    },
    appendEntry: (customType: string, data: any) => {
      entries.push({ type: "custom", customType, data })
    },
  }
  const cwd = mkdtempSync(join(tmpdir(), "pi-warden-gs-"))
  const ctx = { cwd, sessionManager: { getBranch: () => entries } }
  guard(pi as any, publisher, child)
  const fire = async (name: string, event: any) => {
    let out: any
    for (const h of handlers.get(name) ?? []) out = (await h(event, ctx)) ?? out
    return out
  }
  return { fire, entries }
}

const call = (id: string, input: any) => ({ type: "tool_call", toolName: "subagent_run", toolCallId: id, input })
const result = (id: string, input: any, text: string, details?: any) => ({
  type: "tool_result",
  toolName: "subagent_run",
  toolCallId: id,
  input,
  isError: false,
  content: [{ type: "text", text }],
  details,
})

test("integration: review gate", async () => {
  const { fire, entries } = setup()
  const brief = CONTRACT_BRIEF
  const reviewInput = { agent: "gentle-ai-brief-review", mode: "task", task: `review\n<<<BRIEF\n${brief}\nBRIEF>>>` }
  assert.equal((await fire("tool_call", call("c1", reviewInput)))?.block, undefined)
  await fire(
    "tool_result",
    result("c1", reviewInput, 'Subagent gentle-ai-brief-review (task r1, "x") finished.\n\nok\nVERDICT: APPROVE'),
  )
  assert.equal(entries.filter((e) => e.customType === "pi-warden-gs.brief-approval").length, 1)

  const worker = { agent: "gentle-ai-worker", mode: "task", task: brief }
  assert.equal((await fire("tool_call", call("w1", worker)))?.block, undefined)
  assert.equal(entries.filter((e) => e.customType === "pi-warden-gs.brief-approval-used").length, 1)
  const second = await fire("tool_call", call("w2", worker))
  assert.equal(second?.block, true)
  assert.match(second.reason, /brief not approved/)
  const changed = await fire("tool_call", call("w3", { ...worker, task: brief + "!" }))
  assert.equal(changed?.block, true)

  await fire(
    "tool_result",
    result("w1", worker, 'Subagent gentle-ai-worker (task t42, "x") finished.\n\ndone', { gentleAgents: { taskId: "t42" } }),
  )
  const cont = await fire("tool_call", { type: "tool_call", toolName: "subagent_continue", toolCallId: "k", input: { task_id: "t42", prompt: "more" } })
  assert.equal(cont?.block, true)
  const send = await fire("tool_call", { type: "tool_call", toolName: "subagent_send_message", toolCallId: "k2", input: { task_id: "t42", message: "more" } })
  assert.equal(send?.block, true)
  const other = await fire("tool_call", { type: "tool_call", toolName: "subagent_continue", toolCallId: "k3", input: { task_id: "zzz", prompt: "more" } })
  assert.equal(other?.block, undefined)

  const bg = await fire("tool_call", call("c2", { ...reviewInput, mode: "background" }))
  assert.equal(bg?.block, true)
  const nomark = await fire("tool_call", call("c3", { agent: "gentle-ai-brief-review", mode: "task", task: "no markers" }))
  assert.equal(nomark?.block, true)
})

test("integration: approval survives session_start rebuild", async () => {
  const { fire } = setup()
  const brief = CONTRACT_BRIEF
  const reviewInput = { agent: "gentle-ai-brief-review", mode: "task", task: `<<<BRIEF\n${brief}\nBRIEF>>>` }
  await fire("tool_call", call("c1", reviewInput))
  await fire("tool_result", result("c1", reviewInput, "VERDICT: APPROVE"))
  await fire("session_start", { type: "session_start", reason: "reload" })
  const out = await fire("tool_call", call("w1", { agent: "gentle-ai-worker-infra", mode: "task", task: brief }))
  assert.equal(out?.block, undefined)
  const again = await fire("tool_call", call("w2", { agent: "gentle-ai-worker-infra", mode: "task", task: brief }))
  assert.equal(again?.block, true)
})

test("small-fix marker exempts workers only", async () => {
  const { fire } = setup()
  const task = `${SKIP}\n${CONTRACT_BRIEF}`
  assert.equal((await fire("tool_call", call("a", { agent: "gentle-ai-worker", mode: "task", task })))?.block, undefined)
})

test("runner launches without brief approval", async () => {
  const { fire } = setup()
  const out = await fire("tool_call", call("r1", { agent: "gentle-ai-runner", mode: "task", task: "## Objective\nrun the documented recipe" }))
  assert.equal(out?.block, undefined)
})

test("taskIdFromText reads background launches", () => {
  assert.equal(
    taskIdFromText("Started gentle-ai-worker in the background as task mv1abc-2-xyz. Retain that id; completion is pushed automatically."),
    "mv1abc-2-xyz",
  )
  assert.equal(taskIdFromText("Subagent gentle-ai-worker finished."), null)
})

test("destructiveMatch ignores heredoc bodies fed to read-only text tools", () => {
  assert.equal(destructiveMatch("wc -c <<'BRIEF'\nNever run docker compose down -v here\nBRIEF"), null)
  assert.equal(destructiveMatch("grep -c x <<-EOF\n\tgit reset --hard origin/main\n\tEOF"), null)
})

test("destructiveMatch keeps checking heredocs that can run or persist text", () => {
  assert.equal(destructiveMatch("bash <<'EOF'\ndocker rm web\nEOF"), "docker rm")
  assert.equal(destructiveMatch("cat > run.sh <<EOF\ndocker volume rm data\nEOF"), "docker volume rm")
  assert.equal(destructiveMatch("ssh host <<EOF\nsudo reboot\nEOF"), "sudo")
})

test("destructiveMatch still checks commands after a read-only heredoc", () => {
  assert.equal(destructiveMatch("wc -c <<'B'\ntext\nB\ndocker rm web"), "docker rm")
  assert.equal(destructiveMatch("wc -c <<'B'\nunterminated docker rm web"), "docker rm")
})

test("deliveryMatch finds push and PR mutations", () => {
  assert.equal(deliveryMatch("git push -u origin issue/5-a issue/5-b"), "git push")
  assert.equal(deliveryMatch("cd /w && git -C /w push origin main"), "git push")
  assert.equal(deliveryMatch("gh pr create --repo o/r --base master --head x --title t --body-file b.md"), "gh pr create")
  assert.equal(deliveryMatch("gh pr merge 59 --merge"), "gh pr merge")
  assert.equal(deliveryMatch("gh -R o/r pr edit 60 --body-file b.md"), "gh pr edit")
})

test("deliveryMatch ignores reads and other git or gh commands", () => {
  assert.equal(deliveryMatch("git status --short"), null)
  assert.equal(deliveryMatch("git log --grep push"), null)
  assert.equal(deliveryMatch("git fetch origin"), null)
  assert.equal(deliveryMatch("gh pr list --state open"), null)
  assert.equal(deliveryMatch("gh pr view 59"), null)
  assert.equal(deliveryMatch("wc -c <<'B'\nthen git push origin main\nB"), null)
})

test("isPublisherProcess requires a child process with the publisher marker", () => {
  const child = { GENTLE_PI_AGENTS_CHILD: "1" }
  const inline = ["node", "pi", "--append-system-prompt", `intro\n${PUBLISHER_MARKER}\nrules`]
  assert.equal(isPublisherProcess(child, inline), true)
  assert.equal(isPublisherProcess({}, inline), false)
  assert.equal(isPublisherProcess(child, ["node", "pi", "--append-system-prompt", "You are a worker."]), false)
  assert.equal(isPublisherProcess(child, ["node", "pi"]), false)
  const dir = mkdtempSync(join(tmpdir(), "pi-warden-gs-publisher-"))
  const file = join(dir, "instructions.md")
  writeFileSync(file, `---\nname: x\n---\n${PUBLISHER_MARKER}\n`)
  assert.equal(isPublisherProcess(child, ["node", "pi", "--append-system-prompt", file]), true)
})

test("publisher definition carries the marker", () => {
  const definition = readFileSync(new URL("../pi/agents/gentle-ai-publisher.md", import.meta.url), "utf8")
  assert.ok(definition.includes(PUBLISHER_MARKER))
})

const shell = (tool: string, command: string) => ({ type: "tool_call", toolName: tool, toolCallId: "s", input: { command } })

test("integration: delivery commands are blocked outside the publisher", async () => {
  const { fire } = setup()
  const pushed = await fire("tool_call", shell("bash", "git push -u origin issue/5-a"))
  assert.equal(pushed?.block, true)
  assert.match(pushed?.reason ?? "", /gentle-ai-publisher/)
  assert.equal((await fire("tool_call", shell("bash_background", "gh pr create --base master --head x")))?.block, true)
  assert.equal((await fire("tool_call", shell("bash", "git status --short")))?.block, undefined)
})

test("integration: the publisher may push but never force-push", async () => {
  const { fire } = setup(true)
  assert.equal((await fire("tool_call", shell("bash", "git push -u origin issue/5-a")))?.block, undefined)
  assert.equal((await fire("tool_call", shell("bash", "gh pr merge 59 --merge")))?.block, undefined)
  assert.equal((await fire("tool_call", shell("bash", "git push --force origin main")))?.block, true)
})

test("integration: destructive commands are also checked in bash_background", async () => {
  const { fire } = setup()
  assert.equal((await fire("tool_call", shell("bash_background", "docker volume rm data")))?.block, true)
})

test("heavyMatch finds builds, tests and container runs", () => {
  assert.equal(heavyMatch("bash backend/scripts/dotnet-in-docker.sh test backend/MoreauITSM.slnx --no-build"), "dotnet-in-docker.sh")
  assert.equal(heavyMatch("cd /w && ./backend/scripts/dotnet-in-docker.sh build x"), "dotnet-in-docker.sh")
  assert.equal(heavyMatch("set -e; sh backend/scripts/dotnet-in-docker.sh restore x"), "dotnet-in-docker.sh")
  assert.equal(heavyMatch("timeout 600 bash ./backend/scripts/dotnet-in-docker.sh test x"), "dotnet-in-docker.sh")
  assert.equal(heavyMatch("docker run --rm node:22 npm test"), "docker run")
  assert.equal(heavyMatch("docker build -t x ."), "docker build")
  assert.equal(heavyMatch("docker exec web npm run lint"), "docker exec")
  assert.equal(heavyMatch("docker compose -f compose.dev.yaml up -d"), "docker compose up")
  assert.equal(heavyMatch("docker-compose run --rm api"), "docker compose run")
})

test("heavyMatch allows read-only docker queries", () => {
  for (const command of ["docker ps -a", "docker inspect web", "docker logs --tail 20 web", "docker images", "docker volume ls",
    "docker compose -f compose.dev.yaml config --quiet", "docker compose ps", "git status --short",
    "wc -c <<'B'\nrun dotnet-in-docker.sh later\nB", "cat backend/scripts/dotnet-in-docker.sh",
    "sed -n '1,40p' backend/scripts/dotnet-in-docker.sh", "grep -n restore backend/scripts/dotnet-in-docker.sh", "git diff -- backend/scripts/dotnet-in-docker.sh"]) {
    assert.equal(heavyMatch(command), null, command)
  }
})

test("integration: the orchestrator must delegate builds and container runs", async () => {
  const { fire } = setup()
  for (const [tool, command] of [["bash", "bash backend/scripts/dotnet-in-docker.sh build backend/MoreauITSM.slnx"], ["bash_background", "docker compose up -d"]]) {
    const out = await fire("tool_call", shell(tool, command))
    assert.equal(out?.block, true, command)
    assert.match(out?.reason ?? "", /gentle-ai-runner/)
    assert.match(out?.reason ?? "", /tell the human/)
  }
  assert.equal((await fire("tool_call", shell("bash", "docker ps -a")))?.block, undefined)
})

test("integration: subagents may run builds and containers", async () => {
  const { fire } = setup(false, true)
  assert.equal((await fire("tool_call", shell("bash", "bash backend/scripts/dotnet-in-docker.sh test x")))?.block, undefined)
  assert.equal((await fire("tool_call", shell("bash", "docker run --rm alpine true")))?.block, undefined)
  assert.equal((await fire("tool_call", shell("bash", "docker volume rm data")))?.block, true)
})

test("briefRejection forces the structural check on the guard it spawns", () => {
  const dir = mkdtempSync(join(tmpdir(), "brief-gate-"))
  const fake = join(dir, "fake-guard.sh")
  const flag = join(dir, "flag")
  writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s' "\${BRIEF_GUARD_FORCE_STRUCTURE:-unset}" > "${flag}"\nexit 0\n`)
  spawnSync("chmod", ["755", fake])
  const previous = process.env.PI_WARDEN_GS_BRIEF_GUARD
  process.env.PI_WARDEN_GS_BRIEF_GUARD = fake
  try {
    assert.equal(briefRejection("gentle-ai-worker", "## Objective\nx\n", dir), null)
    assert.equal(readFileSync(flag, "utf8"), "1")
  } finally {
    if (previous === undefined) delete process.env.PI_WARDEN_GS_BRIEF_GUARD
    else process.env.PI_WARDEN_GS_BRIEF_GUARD = previous
  }
})

test("integration: a structurally invalid writer brief is blocked by the real guard", async () => {
  const { fire } = setup()
  const malformed = "## Objective\nonly one heading\n"
  const reviewInput = { agent: "gentle-ai-brief-review", mode: "task", task: `<<<BRIEF\n${malformed}\nBRIEF>>>` }
  await fire("tool_call", call("c1", reviewInput))
  await fire("tool_result", result("c1", reviewInput, "VERDICT: APPROVE"))
  const out = await fire("tool_call", call("w1", { agent: "gentle-ai-worker", mode: "task", task: malformed }))
  assert.equal(out?.block, true)
  assert.match(out.reason, /brief-guard/)
})

test("briefRejection rejects a brief of 3072 bytes or more", () => {
  const brief = CONTRACT_BRIEF.replace("one line", "x".repeat(3072))
  const out = briefRejection("gentle-ai-worker", brief, mkdtempSync(join(tmpdir(), "brief-gate-")))
  assert.match(out ?? "", /brief must be smaller than 3072 bytes/)
})

test("briefRejection rejects Strict TDD that is not the first Steps line", () => {
  const brief = CONTRACT_BRIEF.replace(
    "## Steps\n1. do it\n",
    "## Steps\n1. do it\nStrict TDD is active.\n",
  )
  const out = briefRejection("gentle-ai-worker", brief, mkdtempSync(join(tmpdir(), "brief-gate-")))
  assert.match(out ?? "", /must start with: Strict TDD is active/)
})

test("briefRejection rejects preferred, may, or if possible in Steps", () => {
  const brief = CONTRACT_BRIEF.replace("1. do it", "1. you may edit")
  const out = briefRejection("gentle-ai-worker", brief, mkdtempSync(join(tmpdir(), "brief-gate-")))
  assert.match(out ?? "", /must not contain "preferred", "may", or "if possible"/)
})

test("briefRejection rejects Preconditions that omit branch, HEAD, or git status --short", () => {
  const brief = CONTRACT_BRIEF.replace(
    "On expected branch feat/example; HEAD is that tip; tree is clean (git status --short).",
    "repo is ready",
  )
  const out = briefRejection("gentle-ai-worker", brief, mkdtempSync(join(tmpdir(), "brief-gate-")))
  assert.match(out ?? "", /must reference the expected branch, HEAD, and git status --short/)
})

test("briefRejection rejects Allowed edit surfaces that are not paths or globs", () => {
  const brief = CONTRACT_BRIEF.replace("src/a.ts", "- src/a.ts")
  const out = briefRejection("gentle-ai-worker", brief, mkdtempSync(join(tmpdir(), "brief-gate-")))
  assert.match(out ?? "", /not a repository-relative path or narrow glob/)
})

test("briefRejection rejects Verification commands that hide failures", () => {
  const brief = CONTRACT_BRIEF.replace(
    "node --test tests/safety-guard.test.ts",
    "export OUT=$(node --test tests/safety-guard.test.ts)\nls | while read f; do echo f; done",
  )
  const out = briefRejection("gentle-ai-worker", brief, mkdtempSync(join(tmpdir(), "brief-gate-")))
  assert.match(out ?? "", /must not hide failures with export VAR=\$\( or \| while read/)
})

test("briefRejection rejects delivery commands and .env reads anywhere in the brief", () => {
  const brief = CONTRACT_BRIEF.replace("one line", "then git push origin main and cat .env")
  const out = briefRejection("gentle-ai-worker", brief, mkdtempSync(join(tmpdir(), "brief-gate-")))
  assert.match(out ?? "", /must not contain git push, gh pr create\|merge\|edit, or \.env file reads/)
})

test("briefRejection accepts a valid contract brief", () => {
  const out = briefRejection("gentle-ai-worker", CONTRACT_BRIEF, mkdtempSync(join(tmpdir(), "brief-gate-")))
  assert.equal(out, null, out ?? "")
})

test("integration: reviewer launch is blocked when the marked brief fails the guard", async () => {
  const { fire } = setup()
  const malformed = "## Objective\nonly one heading\n"
  const out = await fire(
    "tool_call",
    call("c1", { agent: "gentle-ai-brief-review", mode: "task", task: `for gentle-ai-worker\n<<<BRIEF\n${malformed}\nBRIEF>>>` }),
  )
  assert.equal(out?.block, true)
  assert.match(out?.reason ?? "", /brief-guard/)
})

test("integration: small-fix skips model review and still runs instant guard checks", async () => {
  const { fire } = setup()
  const bad = `${SKIP}\n## Objective\nx`
  const blocked = await fire("tool_call", call("a", { agent: "gentle-ai-worker", mode: "task", task: bad }))
  assert.equal(blocked?.block, true)
  assert.match(blocked?.reason ?? "", /brief-guard/)
  const ok = await fire("tool_call", call("b", { agent: "gentle-ai-worker", mode: "task", task: `${SKIP}\n${CONTRACT_BRIEF}` }))
  assert.equal(ok?.block, undefined)
})
