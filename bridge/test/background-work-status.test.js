import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import {
  CLAUDE_BACKGROUND_WORK_MAX_AGE_MS,
  createClaudeLiveStatusProbe,
  createClaudeSessionIdleGuard,
  overlayLiveStatus,
  readClaudeBackgroundWork
} from "../src/live-session-status.js"
import { QUIET_TURN_MS, corroborateClaudeSessionStatus, withQuietSince } from "../src/server.js"

const SESSION = "77a5d53c-dee4-4c2a-876e-38cd62b8f3d3"
const NOW = Date.parse("2026-11-16T14:00:00.000Z")
const at = (offsetMs) => new Date(NOW + offsetMs).toISOString()

// Records shaped like Claude Code 2.1's journal for a turn that starts background work.
const journal = {
  start: (id, { tool = "Bash", offsetMs = -60_000, background = true } = {}) => ({
    type: "assistant",
    timestamp: at(offsetMs),
    message: {
      role: "assistant",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id, name: tool, input: { command: "sleep 40", ...(background ? { run_in_background: true } : {}) } }]
    }
  }),
  started: (id) => ({
    type: "user",
    timestamp: at(-59_000),
    message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: `Command running in background with ID: b${id}.` }] }
  }),
  refused: (id) => ({
    type: "user",
    timestamp: at(-59_000),
    message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", is_error: true, content: "Blocked" }] }
  }),
  reply: () => ({ type: "assistant", timestamp: at(-58_000), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "STARTED" }] } }),
  notification: (id, status = "completed") => {
    const text = `<task-notification>\n<task-id>b${id}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`
    return [
      { type: "queue-operation", operation: "enqueue", timestamp: at(-10_000), content: text },
      { type: "user", timestamp: at(-10_000), message: { role: "user", content: text } }
    ]
  }
}

async function withTemp(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "hr-background-work-"))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

async function writeJournal(projectsRoot, records, id = SESSION) {
  const directory = path.join(projectsRoot, "C--Software-project")
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, `${id}.jsonl`)
  await writeFile(file, `${records.flat().map((record) => JSON.stringify(record)).join("\n")}\n`)
  return file
}

async function writeRegistry(registryDir, pid, entry) {
  await mkdir(registryDir, { recursive: true })
  await writeFile(path.join(registryDir, `${pid}.json`), JSON.stringify({ pid, ...entry }))
}

test("background work stays pending until its task notification arrives", async () => {
  await withTemp(async (root) => {
    const file = await writeJournal(root, [
      journal.start("toolu_a"), journal.started("toolu_a"),
      journal.start("toolu_b", { tool: "Agent" }), journal.started("toolu_b"),
      journal.start("toolu_c"), journal.refused("toolu_c"),
      journal.start("toolu_d", { background: false }), journal.started("toolu_d"),
      journal.reply(),
      journal.notification("toolu_a", "stopped")
    ])
    const { pending } = await readClaudeBackgroundWork(file, { now: NOW })
    // a finished, c never started, d ran in the foreground: only the subagent is still out.
    assert.deepEqual(pending.map((work) => [work.toolUseID, work.tool]), [["toolu_b", "Agent"]])
  })
})

test("a still-running notification does not close background work, and old work is not waited on", async () => {
  await withTemp(async (root) => {
    const file = await writeJournal(root, [
      journal.start("toolu_old", { offsetMs: -CLAUDE_BACKGROUND_WORK_MAX_AGE_MS - 60_000 }), journal.started("toolu_old"),
      journal.start("toolu_new"), journal.started("toolu_new"),
      journal.notification("toolu_new", "running")
    ])
    const { pending } = await readClaudeBackgroundWork(file, { now: NOW })
    assert.deepEqual(pending.map((work) => work.toolUseID), ["toolu_new"])
  })
})

test("an idle Claude process with background work out reads as listening, not finished", async () => {
  await withTemp(async (root) => {
    const projectsRoot = path.join(root, "projects")
    const registryDir = path.join(root, "sessions")
    await writeJournal(projectsRoot, [journal.start("toolu_a"), journal.started("toolu_a"), journal.reply()])
    await writeRegistry(registryDir, 401, { sessionId: SESSION, status: "idle" })
    let clock = NOW
    const probe = createClaudeLiveStatusProbe({ projectsRoot, registryDir, isAlive: () => true, now: () => clock })
    assert.deepEqual(await probe(SESSION), { type: "listening", background: 1, source: "claude-journal" })

    // The work reports back: the Session is finished for real.
    await writeJournal(projectsRoot, [journal.start("toolu_a"), journal.started("toolu_a"), journal.reply(), journal.notification("toolu_a")])
    clock += 3_000
    assert.equal(await probe(SESSION), undefined)
  })
})

test("listening needs a live Claude process: work whose process is gone is not waited on", async () => {
  await withTemp(async (root) => {
    const projectsRoot = path.join(root, "projects")
    const registryDir = path.join(root, "sessions")
    await writeJournal(projectsRoot, [journal.start("toolu_a"), journal.started("toolu_a"), journal.reply()])
    await writeRegistry(registryDir, 402, { sessionId: SESSION, status: "idle" })
    const probe = createClaudeLiveStatusProbe({ projectsRoot, registryDir, isAlive: () => false, now: () => NOW })
    assert.equal(await probe(SESSION), undefined)
  })
})

test("idle unload leaves a Session alone while its background work is still out", async () => {
  await withTemp(async (root) => {
    const projectsRoot = path.join(root, "projects")
    const registryDir = path.join(root, "sessions")
    await writeJournal(projectsRoot, [journal.start("toolu_a"), journal.started("toolu_a"), journal.reply()])
    await writeRegistry(registryDir, 403, { sessionId: SESSION, status: "idle" })
    let clock = NOW
    const guard = createClaudeSessionIdleGuard({ projectsRoot, registryDir, isAlive: () => true, now: () => clock })
    assert.equal(await guard(SESSION), false)

    await writeJournal(projectsRoot, [journal.start("toolu_a"), journal.started("toolu_a"), journal.reply(), journal.notification("toolu_a")])
    clock += 3_000
    assert.equal(await guard(SESSION), true)
  })
})

test("listening evidence shows on an idle Session, and a bridge-owned turn still wins", () => {
  const listening = { type: "listening", background: 2, source: "claude-journal" }
  assert.deepEqual(overlayLiveStatus({ type: "idle" }, listening), listening)
  assert.deepEqual(overlayLiveStatus({ type: "busy" }, listening), { type: "busy" })
  assert.deepEqual(corroborateClaudeSessionStatus({ type: "idle" }, SESSION, [], 0, NOW, listening), listening)
  // A stale bridge busy flag with no prompt in flight falls back to what Claude itself reports.
  assert.deepEqual(corroborateClaudeSessionStatus({ type: "busy" }, SESSION, [], 0, NOW, listening), listening)
})

test("a turn silent for QUIET_TURN_MS carries quietSince; a turn that is producing does not", () => {
  const prompt = (idleMs) => [{ method: "session/prompt", sessionID: SESSION, idleMs }]
  assert.deepEqual(withQuietSince({ type: "busy" }, SESSION, prompt(60_000), NOW), { type: "busy" })
  assert.deepEqual(withQuietSince({ type: "busy" }, SESSION, prompt(QUIET_TURN_MS + 5_000), NOW), { type: "busy", quietSince: NOW - QUIET_TURN_MS - 5_000 })
  assert.deepEqual(withQuietSince({ type: "idle" }, SESSION, prompt(QUIET_TURN_MS + 5_000), NOW), { type: "idle" })
  assert.deepEqual(withQuietSince({ type: "busy" }, SESSION, [{ method: "session/prompt", sessionID: "other", idleMs: QUIET_TURN_MS * 2 }], NOW), { type: "busy" })
})

test("a Session that started after the last index scan is found through its registry cwd at once", async () => {
  await withTemp(async (root) => {
    const projectsRoot = path.join(root, "projects")
    const registryDir = path.join(root, "sessions")
    await mkdir(projectsRoot, { recursive: true })
    await writeRegistry(registryDir, 404, { sessionId: SESSION, status: "idle", cwd: "C:\\Software\\project" })
    let clock = NOW
    const probe = createClaudeLiveStatusProbe({ projectsRoot, registryDir, isAlive: () => true, now: () => clock })
    // First read: no transcript yet, and the index scan that miss triggers finds nothing.
    assert.equal(await probe(SESSION), undefined)

    // The turn starts background work and ends; the index will not rescan for another 30 s.
    await writeJournal(projectsRoot, [journal.start("toolu_a"), journal.started("toolu_a"), journal.reply()])
    clock += 3_000
    assert.deepEqual(await probe(SESSION), { type: "listening", background: 1, source: "claude-journal" })
  })
})
