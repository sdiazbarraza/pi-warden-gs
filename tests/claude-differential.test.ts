// Differential test — the Claude Code hook duplicates the Pi matching logic, and this
// test is what keeps the duplication honest: the same corpus runs through both
// implementations and both must return the same label.

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  destructiveMatch as piDestructiveMatch,
  heavyMatch as piHeavyMatch,
  deliveryMatch as piDeliveryMatch,
  envPathMatch as piEnvPathMatch,
} from "../extensions/safety-guard.ts"

import {
  destructiveMatch as claudeDestructiveMatch,
  heavyMatch as claudeHeavyMatch,
  deliveryMatch as claudeDeliveryMatch,
  envPathMatch as claudeEnvPathMatch,
} from "../claude/hooks/safety-guard.mjs"

const CORPUS: string[] = [
  // every destructive label
  "docker rm my-container",
  "docker rm -f my-container",
  "docker container rm my-container",
  "docker volume rm data",
  "docker system prune -af",
  "docker image prune -f",
  "docker builder prune -f",
  "docker compose down -v",
  "docker compose -f compose.yml down --volumes",
  "git reset --hard HEAD~1",
  "git reset --hard",
  "git push --force origin main",
  "git push --force-with-lease origin main",
  "git push -f origin main",
  "git clean -f",
  "git clean -fd",
  "sudo rm -rf /var/log",
  "sudo",
  "ls -la",
  "echo hello",
  // delivery
  "git push origin main",
  "git -C /tmp push --force",
  "git -C /tmp push",
  "git push",
  "gh pr create --title x",
  "gh -R a/b pr merge",
  "gh pr edit 42",
  "gh pr list",
  "gh repo view",
  // wrappers around delivery
  "timeout 30 git push origin main",
  "env FOO=1 git push origin main",
  // heavy
  "docker run --rm alpine echo hi",
  "docker build -t app .",
  "docker exec app ls",
  "docker compose up -d",
  "docker compose run app",
  "docker compose build",
  "docker compose exec app bash",
  "docker-compose up -d",
  "docker ps",
  "docker ps -a",
  "docker images",
  "./scripts/dotnet-in-docker.sh test",
  "bash scripts/dotnet-in-docker.sh build",
  "timeout 120 ./scripts/dotnet-in-docker.sh publish",
  "grep dotnet-in-docker.sh README.md",
  "cat scripts/dotnet-in-docker.sh",
  // heredocs
  "wc -l <<'EOF'\nsudo rm -rf /\nEOF",
  "grep -n docker <<'EOF'\ndocker rm -f x\nEOF",
  "bash <<'EOF'\nsudo rm -rf /\nEOF",
  "cat <<'EOF' | bash\nsudo rm -rf /\nEOF",
  // environment files
  "cat .env",
  "cat config/.env",
  "busybox cat .env",
  "git show HEAD:.env",
  "git diff -- .env",
  "cat .env.local",
  "cat .env.example.local",
  "cp .env.example .env",
  "cat .env.example",
  "cat backup.env.example",
  // quoted paths name the same file
  'cat ".env"',
  "cat '.env'",
  'cat "config/.env"',
  'cat ".env.example"',
  'cat "backup.env.example"',
  // a punctuated path names the same file
  "cat .env;",
  "(cat .env)",
  "cat .env)",
  "cat .env,",
  "('.env')",
  // the dot of a backup name is part of the name
  "cat .env.bak",
  // names that only look like an environment file
  "cat my.env",
  "cat .envrc",
]

type Matcher = (command: string) => string | null

function compare(label: string, pi: Matcher, claude: Matcher): void {
  const mismatches: string[] = []
  for (const command of CORPUS) {
    const expected = pi(command)
    const actual = claude(command)
    if (expected !== actual) {
      mismatches.push(`${JSON.stringify(command)}: pi=${JSON.stringify(expected)} claude=${JSON.stringify(actual)}`)
    }
  }
  assert.deepEqual(mismatches, [], `${label} differs between the Pi extension and the Claude Code hook`)
}

test("destructive commands match identically in both implementations", () => {
  compare("destructiveMatch", piDestructiveMatch, claudeDestructiveMatch)
})

test("heavy commands match identically in both implementations", () => {
  compare("heavyMatch", piHeavyMatch, claudeHeavyMatch)
})

test("delivery commands match identically in both implementations", () => {
  compare("deliveryMatch", piDeliveryMatch, claudeDeliveryMatch)
})

test("environment file commands match identically in both implementations", () => {
  compare("envPathMatch", piEnvPathMatch, claudeEnvPathMatch)
})

test("the corpus covers the quoted environment file commands", () => {
  for (const command of ['cat ".env"', "cat '.env'", 'cat "config/.env"']) {
    assert.equal(piEnvPathMatch(command), ".env", command)
    assert.equal(claudeEnvPathMatch(command), ".env", command)
  }
  for (const command of ['cat ".env.example"', 'cat "backup.env.example"']) {
    assert.equal(piEnvPathMatch(command), null, command)
    assert.equal(claudeEnvPathMatch(command), null, command)
  }
})

test("both hosts name the same file behind a punctuated path", () => {
  for (const command of ["cat .env;", "(cat .env)", "cat .env)", "cat .env,", "('.env')"]) {
    assert.equal(piEnvPathMatch(command), ".env", command)
    assert.equal(claudeEnvPathMatch(command), ".env", command)
  }
  assert.equal(piEnvPathMatch("cat .env.bak"), ".env.bak")
  assert.equal(claudeEnvPathMatch("cat .env.bak"), ".env.bak")
  for (const command of ["cat my.env", "cat .envrc"]) {
    assert.equal(piEnvPathMatch(command), null, command)
    assert.equal(claudeEnvPathMatch(command), null, command)
  }
})

test("the corpus keeps covering every destructive label", () => {
  const labels = new Set(CORPUS.map((command) => piDestructiveMatch(command)).filter(Boolean))
  for (const label of [
    "docker rm",
    "docker volume rm",
    "docker prune",
    "docker compose down -v",
    "git reset --hard",
    "git push --force",
    "git clean -f",
    "sudo",
  ]) {
    assert.equal(labels.has(label), true, `the corpus no longer covers ${label}`)
  }
})
