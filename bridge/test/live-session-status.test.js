import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { acpHarnessCapabilityContract } from "../src/harness-capability-contract.js"
import { harnessProfile } from "../src/harness-profiles.js"
import {
  CLAUDE_TRANSCRIPT_STALE_MS,
  CODEX_ROLLOUT_STALE_MS,
  claudeTranscriptRecordState,
  createClaudeTranscriptStatusProbe,
  createClaudeLiveStatusProbe,
  createCodexLiveStatusProbe,
  readClaudeSessionRegistry,
  overlayLiveStatus,
  probeLiveStatuses,
  readClaudeTranscriptTurnState,
  readCodexRolloutTurnState
} from "../src/live-session-status.js"
import { CLAUDE_REPORTED_BUSY_STALE_MS, corroborateClaudeSessionStatus, createBridgeServer } from "../src/server.js"

const CODEX_ID = "01a154e8-d60b-75a3-a957-b1fbf5cd5db3"

function eventLine(type) {
  return JSON.stringify({ timestamp: "2026-10-21T10:00:00.000Z", type: "event_msg", payload: { type } })
}

function noiseLine(index) {
  return JSON.stringify({ type: "response_item", payload: { type: "message", content: [{ text: `noise ${index} ${"x".repeat(200)}` }] } })
}

async function writeRollout(root, lines, { id = CODEX_ID, mtime } = {}) {
  const directory = path.join(root, "2026", "10", "21")
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, `rollout-2026-10-21T10-00-00-${id}.jsonl`)
  await writeFile(file, `${lines.join("\n")}\n`)
  if (mtime !== undefined) await utimes(file, mtime / 1000, mtime / 1000)
  return file
}

async function withTemp(prefix, run) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  try {
    return await run(directory)
  } finally {
    // A Session snapshot can still be landing just after the server closed; on Windows that makes
    // the recursive delete fail with ENOTEMPTY or EBUSY, so retry rather than fail the test.
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

test("Codex rollout tail: dangling task_started reads working; complete and aborted read idle", async () => {
  await withTemp("hr-codex-tail-", async (root) => {
    const many = Array.from({ length: 2_000 }, (_, index) => noiseLine(index))
    const working = await writeRollout(root, [eventLine("task_started"), ...many, eventLine("task_complete"), eventLine("task_started"), noiseLine(1)])
    assert.equal((await readCodexRolloutTurnState(working)).state, "working")
    assert.equal((await readCodexRolloutTurnState(working)).event, "task_started")

    const complete = await writeRollout(root, [eventLine("task_started"), ...many, eventLine("task_complete"), noiseLine(2)])
    assert.equal((await readCodexRolloutTurnState(complete)).state, "idle")

    const aborted = await writeRollout(root, [eventLine("task_started"), noiseLine(3), eventLine("turn_aborted")])
    assert.deepEqual(
      [(await readCodexRolloutTurnState(aborted)).state, (await readCodexRolloutTurnState(aborted)).event],
      ["idle", "turn_aborted"]
    )

    // A partially appended final line must not break the scan.
    const partial = await writeRollout(root, [eventLine("task_started"), '{"type":"event_msg","payload":{"type":"task_comp'])
    assert.equal((await readCodexRolloutTurnState(partial)).state, "working")

    // Markers outside event_msg (e.g. quoted in a message) do not count.
    const quoted = await writeRollout(root, [eventLine("task_complete"), JSON.stringify({ type: "response_item", payload: { type: "task_started" } })])
    assert.equal((await readCodexRolloutTurnState(quoted)).state, "idle")
  })
})

test("Codex rollout tail: a stale rollout with a dangling task_started is a crash, not a running turn", async () => {
  await withTemp("hr-codex-stale-", async (root) => {
    const now = Date.now()
    const file = await writeRollout(root, [eventLine("task_started")], { mtime: now - CODEX_ROLLOUT_STALE_MS - 60_000 })
    assert.equal((await readCodexRolloutTurnState(file, { now })).state, "idle")
    assert.equal((await readCodexRolloutTurnState(file, { now, staleMs: CODEX_ROLLOUT_STALE_MS * 10 })).state, "working")
  })
})

test("Codex rollout tail: an open rollout with a day-old mtime is aged by its newest record (Windows)", async () => {
  await withTemp("hr-codex-open-", async (root) => {
    const now = Date.parse("2026-10-22T08:46:00.000Z")
    const fresh = (type, at) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: "event_msg", payload: { type } })
    const file = await writeRollout(root, [fresh("task_started", now - 13_000), fresh("token_count", now - 1_000)], { mtime: now - 24 * 60 * 60_000 })
    assert.equal((await readCodexRolloutTurnState(file, { now })).state, "working")

    const probe = createCodexLiveStatusProbe({ sessionRoot: root, now: () => now })
    assert.deepEqual(await probe(CODEX_ID), { type: "busy", source: "journal" })
    // The cached result still ages: the same unchanged file reads idle once its turn has gone quiet.
    const later = createCodexLiveStatusProbe({ sessionRoot: root, now: () => now + CODEX_ROLLOUT_STALE_MS + 60_000 })
    assert.equal(await later(CODEX_ID), undefined)
  })
})

test("Codex probe locates rollouts once, caches by (mtime,size) and tolerates broken or missing files", async () => {
  await withTemp("hr-codex-probe-", async (root) => {
    const file = await writeRollout(root, [eventLine("task_started")])
    const probe = createCodexLiveStatusProbe({ sessionRoot: root })
    assert.deepEqual(await probe(CODEX_ID), { type: "busy", source: "journal" })
    assert.equal(await probe("00000000-0000-0000-0000-000000000000"), undefined)
    assert.equal(await probe("../../etc/passwd"), undefined)

    await writeFile(file, `${eventLine("task_started")}\n${eventLine("task_complete")}\n`)
    assert.equal(await probe(CODEX_ID), undefined)

    await rm(file)
    assert.equal(await probe(CODEX_ID), undefined)

    const missingRoot = createCodexLiveStatusProbe({ sessionRoot: path.join(root, "missing") })
    assert.equal(await missingRoot(CODEX_ID), undefined)
  })
})

const CLAUDE_ID = "a5c2dfb5-15fa-494d-8a65-dc25393517aa"

const claude = {
  prompt: (text = "do it") => ({ type: "user", message: { role: "user", content: text } }),
  toolResult: () => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
  interrupted: () => ({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } }),
  assistant: (stopReason) => ({ type: "assistant", message: { role: "assistant", stop_reason: stopReason, content: [{ type: "text", text: "hi" }] } }),
  system: (subtype) => ({ type: "system", subtype }),
  attachment: () => ({ type: "attachment", attachment: { type: "file" } })
}

async function writeTranscript(root, records, { id = CLAUDE_ID, project = "-home-user-project", mtime } = {}) {
  const directory = path.join(root, project)
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, `${id}.jsonl`)
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)
  if (mtime !== undefined) await utimes(file, mtime / 1000, mtime / 1000)
  return file
}

test("Claude transcript record rules", () => {
  assert.equal(claudeTranscriptRecordState(claude.system("stop_hook_summary")), "idle")
  assert.equal(claudeTranscriptRecordState(claude.system("turn_duration")), "idle")
  assert.equal(claudeTranscriptRecordState(claude.system("compact_boundary")), undefined)
  for (const reason of ["end_turn", "stop_sequence", "max_tokens", "refusal"]) {
    assert.equal(claudeTranscriptRecordState(claude.assistant(reason)), "idle", reason)
  }
  assert.equal(claudeTranscriptRecordState(claude.assistant("tool_use")), "working")
  assert.equal(claudeTranscriptRecordState(claude.assistant(null)), "working")
  assert.equal(claudeTranscriptRecordState({ type: "assistant", message: {} }), "working")
  assert.equal(claudeTranscriptRecordState(claude.prompt()), "working")
  assert.equal(claudeTranscriptRecordState(claude.toolResult()), "working")
  assert.equal(claudeTranscriptRecordState(claude.interrupted()), "idle")
  assert.equal(claudeTranscriptRecordState(claude.prompt("[Request interrupted by user]")), "idle")
  assert.equal(claudeTranscriptRecordState({ ...claude.assistant("tool_use"), isSidechain: true }), undefined)
  assert.equal(claudeTranscriptRecordState({ ...claude.prompt(), isMeta: true }), undefined)
  assert.equal(claudeTranscriptRecordState(claude.attachment()), undefined)
  assert.equal(claudeTranscriptRecordState(undefined), undefined)
})

test("Claude transcript tail: the newest decisive record decides", async () => {
  await withTemp("hr-claude-tail-", async (root) => {
    const cases = [
      ["end_turn", [claude.prompt(), claude.assistant("tool_use"), claude.toolResult(), claude.assistant("end_turn")], "idle"],
      ["stop_hook_summary", [claude.prompt(), claude.assistant("end_turn"), claude.system("stop_hook_summary")], "idle"],
      ["turn_duration after skipped system", [claude.prompt(), claude.system("turn_duration"), claude.system("informational")], "idle"],
      ["tool_use", [claude.prompt(), claude.assistant("tool_use"), claude.attachment()], "working"],
      ["streaming assistant", [claude.prompt(), claude.assistant(null)], "working"],
      ["user prompt", [claude.prompt(), claude.assistant("end_turn"), claude.system("stop_hook_summary"), claude.prompt("next")], "working"],
      ["tool_result", [claude.prompt(), claude.assistant("tool_use"), claude.toolResult()], "working"],
      ["interrupted", [claude.prompt(), claude.assistant("tool_use"), claude.interrupted()], "idle"],
      ["sidechain skipped", [claude.prompt(), claude.assistant("end_turn"), { ...claude.assistant("tool_use"), isSidechain: true }, { ...claude.toolResult(), isSidechain: true }], "idle"],
      ["meta skipped", [claude.prompt(), claude.assistant("end_turn"), claude.system("stop_hook_summary"), { ...claude.prompt("<command-name>/x</command-name>"), isMeta: true }], "idle"]
    ]
    for (const [name, records, expected] of cases) {
      const file = await writeTranscript(root, records, { id: name.replace(/[^A-Za-z0-9]+/g, "-") })
      assert.equal((await readClaudeTranscriptTurnState(file)).state, expected, name)
    }
    const empty = await writeTranscript(root, [claude.attachment()], { id: "only-attachments" })
    assert.equal((await readClaudeTranscriptTurnState(empty)).state, "idle")
  })
})

test("Claude transcript tail: a stale transcript never reads working", async () => {
  await withTemp("hr-claude-stale-", async (root) => {
    const now = Date.now()
    const file = await writeTranscript(root, [claude.prompt(), claude.assistant("tool_use")], { mtime: now - CLAUDE_TRANSCRIPT_STALE_MS - 60_000 })
    const result = await readClaudeTranscriptTurnState(file, { now })
    // The open turn is still found, but nobody has written to it for longer than the stale window.
    assert.deepEqual([result.state, result.decidedBy], ["idle", "assistant:tool_use"])
    const probe = createClaudeTranscriptStatusProbe({ projectsRoot: root })
    assert.equal(await probe(CLAUDE_ID), undefined)
  })
})

test("Claude transcript probe: index by readdir, rescan only on miss and rate-limited, cache by (mtime,size)", async () => {
  await withTemp("hr-claude-probe-", async (root) => {
    let clock = Date.now()
    const probe = createClaudeTranscriptStatusProbe({ projectsRoot: root, now: () => clock })
    // Whole-second mtime so it can be restored exactly after an in-place rewrite below.
    const pinnedMtime = Math.floor(clock / 1000) * 1000 - 5_000
    const file = await writeTranscript(root, [claude.prompt(), claude.assistant("tool_use")], { mtime: pinnedMtime })
    // Subagent transcripts one level deeper are not Sessions.
    await mkdir(path.join(root, "-home-user-project", CLAUDE_ID, "subagents"), { recursive: true })
    await writeFile(path.join(root, "-home-user-project", CLAUDE_ID, "subagents", "agent-1.jsonl"), `${JSON.stringify(claude.prompt())}\n`)
    await writeFile(path.join(root, "not-a-dir.txt"), "")
    assert.deepEqual(await probe(CLAUDE_ID), { type: "busy", source: "journal" })
    assert.equal(await probe("agent-1"), undefined)
    assert.equal(await probe("../escape"), undefined)

    // Same (mtime,size) -> cached; the file is unreadable as JSON now but the cache still answers.
    const { size } = await import("node:fs/promises").then(({ stat }) => stat(file))
    await writeFile(file, "x".repeat(size))
    await utimes(file, pinnedMtime / 1000, pinnedMtime / 1000)
    assert.deepEqual(await probe(CLAUDE_ID), { type: "busy", source: "journal" })

    // A real change is re-read.
    await writeTranscript(root, [claude.prompt(), claude.assistant("end_turn"), claude.system("stop_hook_summary")])
    assert.equal(await probe(CLAUDE_ID), undefined)

    // A Session created after the scan is a miss until the rescan interval allows another scan.
    const lateID = "11111111-2222-3333-4444-555555555555"
    await writeTranscript(root, [claude.prompt()], { id: lateID, project: "-other" })
    clock += 1_000
    assert.equal(await probe(lateID), undefined)
    clock += 30_000
    assert.deepEqual(await probe(lateID), { type: "busy", source: "journal" })

    // Removed transcript -> no evidence, no throw.
    await rm(file)
    assert.equal(await probe(CLAUDE_ID), undefined)
    assert.equal(await createClaudeTranscriptStatusProbe({ projectsRoot: path.join(root, "missing") })(CLAUDE_ID), undefined)
  })
})

async function writeRegistryEntry(registryDir, pid, entry) {
  await mkdir(registryDir, { recursive: true })
  await writeFile(path.join(registryDir, `${pid}.json`), JSON.stringify({ pid, ...entry }))
}

test("Claude process registry: live processes only, and any busy process makes the Session busy", async () => {
  await withTemp("hr-claude-registry-", async (registryDir) => {
    await writeRegistryEntry(registryDir, 101, { sessionId: "running", status: "busy" })
    await writeRegistryEntry(registryDir, 102, { sessionId: "waiting", status: "idle" })
    await writeRegistryEntry(registryDir, 103, { sessionId: "crashed", status: "busy" })
    await writeRegistryEntry(registryDir, 104, { sessionId: "shared", status: "busy" })
    await writeRegistryEntry(registryDir, 105, { sessionId: "shared", status: "idle" })
    await writeRegistryEntry(registryDir, 106, { sessionId: "../escape", status: "busy" })
    await writeFile(path.join(registryDir, "107.json"), "{ partial")
    await writeFile(path.join(registryDir, "107.abc.key"), "secret")
    const alive = new Set([101, 102, 104, 105, 106, 107])
    const sessions = await readClaudeSessionRegistry(registryDir, { isAlive: (pid) => alive.has(pid) })
    assert.deepEqual(Object.fromEntries(sessions), { running: "busy", waiting: "idle", shared: "busy" })
    assert.equal(await readClaudeSessionRegistry(path.join(registryDir, "missing")), undefined)
  })
})

test("Claude probe: the registry is authoritative where it exists; the transcript is only a fallback", async () => {
  await withTemp("hr-claude-live-", async (root) => {
    const projectsRoot = path.join(root, "projects")
    const registryDir = path.join(root, "sessions")
    // A resume appends a task notification for orphaned shells and then stops: the transcript alone
    // reads that as a turn in flight.
    await writeTranscript(projectsRoot, [claude.assistant("end_turn"), claude.system("stop_hook_summary"), claude.prompt("<task-notification>")])
    await writeTranscript(projectsRoot, [claude.prompt()], { id: "terminal-busy" })
    const transcriptOnly = createClaudeLiveStatusProbe({ projectsRoot, registryDir })
    assert.deepEqual(await transcriptOnly(CLAUDE_ID), { type: "busy", source: "journal" })

    await writeRegistryEntry(registryDir, 201, { sessionId: CLAUDE_ID, status: "idle" })
    await writeRegistryEntry(registryDir, 202, { sessionId: "terminal-busy", status: "busy" })
    let clock = 0
    const probe = createClaudeLiveStatusProbe({ projectsRoot, registryDir, isAlive: () => true, now: () => clock })
    assert.equal(await probe(CLAUDE_ID), undefined)
    assert.deepEqual(await probe("terminal-busy"), { type: "busy", source: "claude-session-registry" })
    assert.equal(await probe("no-live-process"), undefined)

    // Re-read after the TTL, not before.
    await writeRegistryEntry(registryDir, 201, { sessionId: CLAUDE_ID, status: "busy" })
    clock = 1_000
    assert.equal(await probe(CLAUDE_ID), undefined)
    clock = 5_000
    assert.deepEqual(await probe(CLAUDE_ID), { type: "busy", source: "claude-session-registry" })
  })
})

test("overlay precedence: bridge-owned busy wins, evidence only upgrades idle", () => {
  assert.deepEqual(overlayLiveStatus({ type: "busy" }, { type: "attention", source: "journal" }), { type: "busy" })
  assert.equal(overlayLiveStatus("busy", { type: "busy", source: "journal" }), "busy")
  assert.deepEqual(overlayLiveStatus({ type: "idle" }, { type: "busy", source: "journal" }), { type: "busy", source: "journal" })
  assert.deepEqual(overlayLiveStatus("idle", { type: "attention", source: "journal" }), { type: "attention", source: "journal" })
  assert.deepEqual(overlayLiveStatus({ type: "idle" }, undefined), { type: "idle" })
  assert.deepEqual(overlayLiveStatus({ type: "idle" }, { type: "idle" }), { type: "idle" })
})

test("probeLiveStatuses isolates per-Session failures", async () => {
  const evidence = await probeLiveStatuses(async (sessionID) => {
    if (sessionID === "broken") throw new Error("EACCES")
    return sessionID === "live" ? { type: "busy", source: "journal" } : undefined
  }, ["broken", "live", "quiet", "live", "../bad"])
  assert.deepEqual([...evidence], [["live", { type: "busy", source: "journal" }]])
})

test("Claude corroboration keeps transcript evidence of a turn the bridge never sent", () => {
  const now = 1_800_000_000_000
  const journal = { type: "busy", source: "journal" }
  // Bridge reports idle; the transcript proves a terminal turn is running.
  assert.deepEqual(corroborateClaudeSessionStatus({ type: "idle" }, "s", [], 0, now, journal), journal)
  // Stale bridge busy flag without a pending prompt: transcript evidence replaces the forced idle.
  assert.deepEqual(corroborateClaudeSessionStatus({ type: "busy" }, "s", [], 0, now, journal), journal)
  assert.deepEqual(corroborateClaudeSessionStatus({ type: "busy" }, "s", [], 0, now), { type: "idle" })
  // Stale pending prompt: still idle without transcript evidence, transcript evidence when present.
  const stalePrompt = [{ method: "session/prompt", sessionID: "s", idleMs: CLAUDE_REPORTED_BUSY_STALE_MS + 1 }]
  assert.deepEqual(corroborateClaudeSessionStatus({ type: "busy" }, "s", stalePrompt, 0, now), { type: "idle" })
  assert.deepEqual(corroborateClaudeSessionStatus({ type: "busy" }, "s", stalePrompt, 0, now, journal), journal)
  // A live bridge-owned prompt wins over any transcript state.
  const livePrompt = [{ method: "session/prompt", sessionID: "s", idleMs: 1_000 }]
  assert.deepEqual(
    corroborateClaudeSessionStatus({ type: "busy" }, "s", livePrompt, 0, now, { type: "attention", source: "journal" }),
    { type: "busy" }
  )
  // Idle transcript evidence never manufactures a status.
  assert.deepEqual(corroborateClaudeSessionStatus({ type: "idle" }, "s", [], 0, now, undefined), { type: "idle" })
})

test("harness contracts declare where live status comes from", () => {
  assert.equal(harnessProfile("codex").liveStatusSource, "codex-journal")
  assert.equal(harnessProfile("claude").liveStatusSource, "claude-journal")
  assert.equal(acpHarnessCapabilityContract(harnessProfile("codex")).sessions.liveStatus, "native-runtime-state")
  assert.equal(acpHarnessCapabilityContract(harnessProfile("claude")).sessions.liveStatus, "native-runtime-state")
  assert.equal(acpHarnessCapabilityContract(harnessProfile("omp")).sessions.liveStatus, "bridge-owned-only")
  assert.equal(acpHarnessCapabilityContract(harnessProfile("pi")).sessions.liveStatus, "bridge-owned-only")
})

class StatusFakeAcp extends EventEmitter {
  agentInfo = { version: "1.0.0" }
  pendingPrompts = []

  async start() {}

  async listSessions() {
    return [
      { sessionId: "external-live", title: "Terminal", cwd: process.cwd(), updatedAt: "2026-10-21T10:00:00.000Z" },
      { sessionId: "external-attention", title: "Waiting", cwd: process.cwd(), updatedAt: "2026-10-21T10:00:00.000Z" },
      { sessionId: "broken", title: "Broken", cwd: process.cwd(), updatedAt: "2026-10-21T10:00:00.000Z" },
      { sessionId: "quiet", title: "Quiet", cwd: process.cwd(), updatedAt: "2026-10-21T10:00:00.000Z" },
      { sessionId: "bridge-owned", title: "Owned", cwd: process.cwd(), updatedAt: "2026-10-21T10:00:00.000Z" }
    ]
  }

  async request(method) {
    if (method === "session/prompt") return new Promise((resolve) => this.pendingPrompts.push(resolve))
    return {}
  }

  notify() {}

  diagnostics() {
    return { pendingRequests: this.pendingPrompts.map(() => ({ method: "session/prompt", sessionID: "bridge-owned", idleMs: 10 })) }
  }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

for (const backend of ["omp", "claude"]) {
  test(`${backend} Session list overlays external evidence and keeps bridge-owned busy on top`, async () => {
    await withTemp(`hr-live-server-${backend}-`, async (stateDirectory) => {
      const acp = new StatusFakeAcp()
      const probed = []
      const liveStatusProbe = async (sessionID) => {
        probed.push(sessionID)
        if (sessionID === "broken") throw new Error("corrupt journal")
        if (sessionID === "external-live") return { type: "busy", source: "journal" }
        if (sessionID === "external-attention" || sessionID === "bridge-owned") return { type: "attention", source: "journal" }
        return undefined
      }
      const server = createBridgeServer({
        config: { backend, username: "", password: "", corsOrigins: [], roots: [process.cwd()] },
        acp,
        serviceOptions: { snapshotDirectory: path.join(stateDirectory, backend) },
        liveStatusProbe
      })
      const base = await listen(server)
      try {
        const prompt = await fetch(`${base}/session/bridge-owned/prompt_async`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] })
        })
        assert.ok(prompt.status < 300, `prompt_async returned ${prompt.status}`)
        for (let attempt = 0; attempt < 50 && acp.pendingPrompts.length === 0; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }

        const response = await fetch(`${base}/session/status`)
        assert.equal(response.status, 200)
        const statuses = await response.json()
        assert.deepEqual(statuses["external-live"], { type: "busy", source: "journal" })
        assert.deepEqual(statuses["external-attention"], { type: "attention", source: "journal" })
        assert.deepEqual(statuses.broken, { type: "idle" })
        assert.deepEqual(statuses.quiet, { type: "idle" })
        assert.equal(statuses["bridge-owned"].type, "busy")
        assert.equal(statuses["bridge-owned"].source, undefined)
        if (backend !== "claude") assert.equal(probed.includes("bridge-owned"), false, "bridge-owned busy needs no probe")
      } finally {
        for (const resolve of acp.pendingPrompts) resolve({ stopReason: "end_turn" })
        await close(server)
      }
    })
  })
}

test("a null liveStatusProbe disables external evidence", async () => {
  await withTemp("hr-live-server-off-", async (stateDirectory) => {
    const server = createBridgeServer({
      config: { backend: "codex", username: "", password: "", corsOrigins: [], roots: [process.cwd()] },
      acp: new StatusFakeAcp(),
      serviceOptions: { snapshotDirectory: path.join(stateDirectory, "codex") },
      liveStatusProbe: null
    })
    const base = await listen(server)
    try {
      const statuses = await (await fetch(`${base}/session/status`)).json()
      assert.deepEqual(statuses["external-live"], { type: "idle" })
    } finally {
      await close(server)
    }
  })
})
