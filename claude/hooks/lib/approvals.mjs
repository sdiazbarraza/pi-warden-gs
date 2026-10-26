// The file-backed approval store.
//
// Pi keeps brief approvals as session entries, which survive reload and resume. Claude Code
// gives hooks no session-entry API, so the approvals live in a JSON file:
//
//   {"version": 1, "sessions": {"<session_id>": {"approved": ["<sha256>", ...]}}}
//
// Approvals are scoped to the session that requested them, so one session never approves a
// brief for another. Writes are atomic (temp file + rename) and serialized by a lock file, so
// concurrent hook runs cannot corrupt the store. The store never grows without bound: the
// approved list of a session keeps the 50 most recent hashes and old sessions are dropped when
// the file is rewritten.
//
// The brief normalization and its hash live here because the approval identity is the hash of
// the normalized brief.

import { createHash } from "node:crypto"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const MAX_APPROVALS_PER_SESSION = 50
const MAX_SESSIONS = 10
const LOCK_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 10_000

/** CRLF folded to LF and trimmed — the normalized form of a brief. */
export function normalizeBrief(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").trim()
}

/** The sha256 of a brief; the identity of an approval. */
export function sha256(text) {
  return createHash("sha256").update(text).digest("hex")
}

/** Where the store lives. */
export function approvalsPath() {
  const override = (process.env.CLAUDE_WARDEN_STATE_DIR ?? "").trim()
  const dir = override || join(homedir(), ".claude", ".warden")
  return join(dir, "approvals.json")
}

function emptyStore() {
  return { version: 1, sessions: {} }
}

function readStoreFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (!parsed || typeof parsed !== "object") return emptyStore()
    const rawSessions = parsed.sessions
    if (!rawSessions || typeof rawSessions !== "object") return emptyStore()
    const sessions = {}
    for (const [sessionId, value] of Object.entries(rawSessions)) {
      const approved = Array.isArray(value?.approved)
        ? value.approved.filter((hash) => typeof hash === "string" && hash.length > 0)
        : []
      sessions[sessionId] = { approved }
    }
    return { version: 1, sessions }
  } catch {
    return emptyStore()
  }
}

/** The store as it is on disk (an unreadable file reads as an empty store). */
export function readStore() {
  return readStoreFile(approvalsPath())
}

function writeStoreFile(path, store) {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const temp = join(dir, `.approvals.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
  try {
    writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    renameSync(temp, path)
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch {
      // The temp file is already gone.
    }
    throw err
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Serializes read-modify-write cycles across hook processes. The lock is a file created
 * exclusively; a lock older than the stale window is broken so a killed process cannot wedge
 * the store forever.
 */
function withLock(path, fn) {
  const lockPath = `${path}.lock`
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let handle = null
  while (handle === null) {
    try {
      handle = openSync(lockPath, "wx")
    } catch (err) {
      if (err?.code !== "EEXIST") break // proceed without the lock rather than fail the call
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        // The lock vanished between the open and the stat; retry immediately.
      }
      if (Date.now() >= deadline) break
      sleep(15)
    }
  }
  try {
    return fn()
  } finally {
    if (handle !== null) {
      try {
        closeSync(handle)
      } catch {
        // Already closed.
      }
      try {
        unlinkSync(lockPath)
      } catch {
        // Already removed.
      }
    }
  }
}

/**
 * Keeps the store bounded: the most recent sessions survive, the touched one is the most
 * recent of them.
 */
function pruneSessions(store, touchedSessionId) {
  const ordered = Object.keys(store.sessions).filter((id) => id !== touchedSessionId)
  ordered.push(touchedSessionId)
  const kept = ordered.slice(-MAX_SESSIONS)
  const sessions = {}
  for (const sessionId of kept) sessions[sessionId] = store.sessions[sessionId]
  store.sessions = sessions
}

/** Registers an unused approval for a session. */
export function add(hash, sessionId) {
  if (typeof hash !== "string" || !hash) return false
  if (typeof sessionId !== "string" || !sessionId) return false
  const path = approvalsPath()
  return withLock(path, () => {
    const store = readStoreFile(path)
    const session = store.sessions[sessionId] ?? { approved: [] }
    session.approved = session.approved.filter((entry) => entry !== hash)
    session.approved.push(hash)
    if (session.approved.length > MAX_APPROVALS_PER_SESSION) {
      session.approved = session.approved.slice(-MAX_APPROVALS_PER_SESSION)
    }
    store.sessions[sessionId] = session
    pruneSessions(store, sessionId)
    writeStoreFile(path, store)
    return true
  })
}

/** True when the session holds an unused approval for the hash. */
export function has(hash, sessionId) {
  if (typeof hash !== "string" || !hash) return false
  if (typeof sessionId !== "string" || !sessionId) return false
  const session = readStoreFile(approvalsPath()).sessions[sessionId]
  return Boolean(session) && session.approved.includes(hash)
}

/**
 * Consumes one unused approval for the hash. True only the first time: the hash is removed
 * from the store, so a second launch of the same brief needs a new review.
 */
export function consume(hash, sessionId) {
  if (typeof hash !== "string" || !hash) return false
  if (typeof sessionId !== "string" || !sessionId) return false
  const path = approvalsPath()
  return withLock(path, () => {
    const store = readStoreFile(path)
    const session = store.sessions[sessionId]
    if (!session) return false
    const index = session.approved.indexOf(hash)
    if (index === -1) return false
    session.approved.splice(index, 1)
    pruneSessions(store, sessionId)
    writeStoreFile(path, store)
    return true
  })
}

/** The store directory, created on demand. */
export function ensureStoreDir() {
  const dir = dirname(approvalsPath())
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
