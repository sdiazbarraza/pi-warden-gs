import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import guard, {
  PUBLISHER_MARKER,
  deliveryMatch,
  destructiveMatch,
  envPathMatch,
  heavyMatch,
  isPublisherProcess,
} from "../extensions/safety-guard.ts"


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

// The execution-time environment-file rule: a command that names a .env file is blocked
// in every host, publisher included.
const ENV_BLOCKED_CASES: Array<[string, string]> = [
  [".env", "cat .env"],
  [".env", "cat config/.env"],
  [".env", "busybox cat .env"],
  [".env", "git show HEAD:.env"],
  [".env", "git diff -- .env"],
  [".env.local", "cat .env.local"],
  [".env.example.local", "cat .env.example.local"],
  [".env", "cp .env.example .env"],
  // Quoted paths name the same file: the quotes are shell syntax, not part of the path.
  [".env", 'cat ".env"'],
  [".env", "cat '.env'"],
  [".env", 'cat "config/.env"'],
  // Punctuated paths name the same file: the punctuation is shell syntax, not part of the path.
  [".env", "cat .env;"],
  [".env", "(cat .env)"],
  [".env", "cat .env)"],
  [".env", "cat .env,"],
  [".env", "('.env')"],
  // The dot of a backup name is part of the name: ".env.bak" is still an environment file.
  [".env.bak", "cat .env.bak"],
  // A shell operator or a trailing slash still names the file: the operators separate
  // tokens, so "cat .env|tee" names the same file as "cat .env".
  [".env", "cat .env|tee"],
  [".env", "cat .env&&echo"],
  [".env", "cat .env>"],
  [".env", "ls .env/"],
]

const ENV_ALLOWED_CASES = [
  "cat .env.example",
  "cat backup.env.example",
  'cat ".env.example"',
  'cat "backup.env.example"',
  // Names that only look like an environment file stay readable.
  "cat my.env",
  "cat .envrc",
]

test("envPathMatch names the environment file a command reads", () => {
  for (const [label, command] of ENV_BLOCKED_CASES) {
    assert.equal(envPathMatch(command), label, command)
  }
  for (const command of ENV_ALLOWED_CASES) {
    assert.equal(envPathMatch(command), null, command)
  }
})

// The acceptance cases of the environment-path rule: a punctuated path names the
// same file, and a name that only looks like one stays readable.
const ENV_PATH_CASES: Array<[string | null, string]> = [
  [".env", "cat .env"],
  [".env", "cat '.env'"],
  [".env.bak", "cat .env.bak"],
  [null, "cat .env.example"],
  [null, "cat backup.env.example"],
  [null, "cat my.env"],
  [null, "cat .envrc"],
  [".env", "cat .env;"],
  [".env", "(cat .env)"],
  [".env", "cat .env)"],
  [".env", "cat .env,"],
  [".env", "('.env')"],
]

test("envPathMatch names the environment file behind shell punctuation", () => {
  for (const [expected, command] of ENV_PATH_CASES) {
    assert.equal(envPathMatch(command), expected, command)
  }
})

// The acceptance cases of the operator rule: a shell operator or a trailing slash still
// names the environment file, and the commands without them keep their labels.
const ENV_OPERATOR_CASES: Array<[string | null, string]> = [
  [".env", "cat .env|tee"],
  [".env", "cat .env&&echo"],
  [".env", "cat .env>"],
  [".env", "ls .env/"],
  [".env", "cat .env"],
  [".env", "cat .env;"],
  [".env", "(cat .env)"],
  [".env.bak", "cat .env.bak"],
  [null, "cat .env.example"],
  [null, "cat backup.env.example"],
  [null, "cat my.env"],
  [null, "cat .envrc"],
]

test("envPathMatch names the environment file behind an operator or a trailing slash", () => {
  for (const [expected, command] of ENV_OPERATOR_CASES) {
    assert.equal(envPathMatch(command), expected, command)
  }
})

// The acceptance cases of the interior-quote rule: the quotes inside a token are
// removed before the name is compared, so "cat .e''nv" names .env, and the
// commands without interior quotes keep their labels.
const ENV_QUOTE_CASES: Array<[string | null, string]> = [
  [".env", "cat .e''nv"],
  [".env", 'cat .e""nv'],
  [".env", "cat .env"],
  [".env", "cat config/.env"],
  [".env.bak", "cat .env.bak"],
  [".env", "cat .env|tee"],
  [".env", "ls .env/"],
  [null, "cat .env.example"],
  [null, "cat backup.env.example"],
  [null, "cat my.env"],
  [null, "cat .envrc"],
]

test("envPathMatch names the environment file behind quotes inside a token", () => {
  for (const [expected, command] of ENV_QUOTE_CASES) {
    assert.equal(envPathMatch(command), expected, command)
  }
})

test("integration: an environment file read with quotes inside the token is blocked", async () => {
  const { fire } = setup()
  for (const command of ["cat .e''nv", 'cat .e""nv']) {
    const out = await fire("tool_call", shell("bash", command))
    assert.equal(out?.block, true, command)
    assert.match(out?.reason ?? "", /Environment files hold secrets/)
  }
  for (const command of ["cat .env.example", "cat backup.env.example", "cat my.env", "cat .envrc"]) {
    assert.equal((await fire("tool_call", shell("bash", command)))?.block, undefined, command)
  }
})

test("integration: commands that name an environment file are blocked", async () => {
  const { fire } = setup()
  for (const [label, command] of ENV_BLOCKED_CASES) {
    const out = await fire("tool_call", shell("bash", command))
    assert.equal(out?.block, true, command)
    assert.match(out?.reason ?? "", /Environment files hold secrets/)
  }
})

test("integration: the example environment file stays readable", async () => {
  const { fire } = setup()
  for (const command of ENV_ALLOWED_CASES) {
    assert.equal((await fire("tool_call", shell("bash", command)))?.block, undefined, command)
  }
})

test("integration: the publisher may deliver but cannot read an environment file", async () => {
  const { fire } = setup(true)
  assert.equal((await fire("tool_call", shell("bash", "git push -u origin issue/5-a")))?.block, undefined)
  const out = await fire("tool_call", shell("bash", "cat .env"))
  assert.equal(out?.block, true)
  assert.match(out?.reason ?? "", /Environment files hold secrets/)
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
