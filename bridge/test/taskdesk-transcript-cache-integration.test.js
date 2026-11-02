import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { AcpService } from "../src/acp-service.js"

class ListingAcp extends EventEmitter {
  constructor(sessions) {
    super()
    this.sessions = sessions
    this.promptCapabilities = {}
  }
  async listSessions() { return this.sessions }
  async start() {}
  async request() { throw new Error("ACP replay should not be needed for authoritative history") }
  notify() {}
}

function transcript(sessionID, text = sessionID) {
  return [{
    info: { id: `${sessionID}:1`, role: "assistant", sessionID, time: { created: 1 } },
    parts: [{ id: `${sessionID}:1:text`, type: "text", text }]
  }]
}

function sessions(count) {
  return Array.from({ length: count }, (_, index) => ({
    sessionId: `session-${index}`,
    cwd: "/repo",
    updatedAt: `2026-08-20T10:${String(index).padStart(2, "0")}:00.000Z`
  }))
}

function countingService(sessionCount) {
  const listed = sessions(sessionCount)
  const loads = new Map()
  const loader = async (sessionID) => {
    loads.set(sessionID, (loads.get(sessionID) ?? 0) + 1)
    return transcript(sessionID)
  }
  loader.authoritativeHistory = true
  return { listed, loads, service: new AcpService(new ListingAcp(listed), { historyLoader: loader }) }
}

test("AcpService retains at most the bounded number of inactive transcripts", async () => {
  // Exceed whatever the configured cap is rather than pinning its value, so the invariant is what
  // is under test and the bound can be tuned for how the product actually navigates.
  const probe = new AcpService(new ListingAcp(sessions(1)), { historyLoader: Object.assign(async () => [], { authoritativeHistory: true }) })
  const cap = probe.diagnostics().transcriptCache.maxEntries
  const { listed, loads, service } = countingService(cap + 4)

  for (const session of listed) {
    assert.equal((await service.messages(session.sessionId)).length, 1)
  }

  const stats = service.diagnostics().transcriptCache
  assert.equal(stats.entries <= stats.maxEntries, true)
  assert.equal(stats.evictions >= 4, true)
  assert.equal(stats.weight <= stats.maxWeight, true)

  assert.equal((await service.messages("session-0"))[0].info.id, "session-0:1")
  assert.equal(loads.get("session-0"), 2, "an evicted transcript must be reloadable on demand")
})

/*
 * Session-first navigation hops between many native Sessions. Dropping one the moment a user opens
 * a ninth means going back re-reads that harness's journal or re-runs session/load, which is what
 * made switching Sessions feel slow. Small transcripts must stay cached while the memory budget that
 * actually bounds this cache is still nearly empty.
 */
test("ordinary Session-first navigation does not evict transcripts while the memory budget is free", async () => {
  const { listed, loads, service } = countingService(40)

  for (const session of listed) {
    assert.equal((await service.messages(session.sessionId)).length, 1)
  }
  for (const session of listed) {
    assert.equal((await service.messages(session.sessionId)).length, 1)
  }

  const stats = service.diagnostics().transcriptCache
  assert.equal(stats.evictions, 0, `40 small Sessions must not evict (weight ${stats.weight} of ${stats.maxWeight})`)
  assert.equal(stats.weightEvictions, 0)
  assert.ok(stats.weight < stats.maxWeight / 100, "these transcripts use a negligible share of the memory budget")
  assert.ok(stats.hits >= 40, `revisits must be served from cache (hits ${stats.hits}, misses ${stats.misses})`)
  assert.ok(loads.size === 40, "every Session was read at least once")
})

test("the memory budget still evicts when transcripts are genuinely large", async () => {
  const big = "z".repeat(3 * 1024 * 1024)
  const loader = async (sessionID) => [{
    info: { id: `${sessionID}:1`, role: "assistant", sessionID, time: { created: 1 } },
    parts: [{ id: `${sessionID}:1:text`, type: "text", text: big }]
  }]
  loader.authoritativeHistory = true
  const listed = sessions(16)
  const service = new AcpService(new ListingAcp(listed), { historyLoader: loader })

  for (const session of listed) await service.messages(session.sessionId)

  const stats = service.diagnostics().transcriptCache
  assert.ok(stats.entries < 16, `the memory budget must cap large transcripts (entries ${stats.entries})`)
  assert.ok(stats.weight <= stats.maxWeight, `weight ${stats.weight} exceeded budget ${stats.maxWeight}`)
  assert.ok(stats.weightEvictions > 0, "these evictions must be attributed to the memory budget, not the entry cap")
})

test("messagePage uses an authoritative branch pager without materializing full history", async () => {
  const sessionID = "omp-paged-session"
  let fullLoads = 0
  let pageOptions
  const loader = async () => {
    fullLoads += 1
    return transcript(sessionID, "full history should not be read")
  }
  loader.pageRequiresActiveLeaf = true
  loader.page = async (_sessionID, options) => {
    pageOptions = options
    return {
      messages: transcript(sessionID, "bounded page"),
      before: "older-cursor",
      hasMore: true
    }
  }
  const actionProviders = [{
    id: "test-authoritative-leaf",
    requiredCommands: [],
    actions: [],
    loadState: async () => ({
      actions: [],
      sessionRevision: "rev-1",
      activeSessionLeaf: "leaf-42"
    })
  }]
  // The first page request starts from a cold service, so session metadata must be listed
  // without opening ACP replay or loading the full journal transcript.
  const service = new AcpService(new ListingAcp([{
    sessionId: sessionID,
    cwd: "/repo",
    updatedAt: "2026-08-20T10:00:00.000Z"
  }]), { historyLoader: loader, actionProviders })

  const page = await service.messagePage(sessionID, { limit: 25 })
  assert.equal(fullLoads, 0, "a bounded page must not call the full journal loader")
  assert.equal(page.messages[0].parts[0].text, "bounded page")
  assert.equal(page.hasMore, true)
  assert.deepEqual(pageOptions, { limit: 25, before: undefined, activeSessionLeaf: "leaf-42" })
})

test("authoritative journal transcripts are not duplicated into bridge snapshots", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "taskdesk-transcript-snapshot-"))
  try {
    const sessionID = "journal-session"
    const loader = async () => transcript(sessionID, "journal owns this transcript")
    loader.authoritativeHistory = true
    const service = new AcpService(new ListingAcp([{ sessionId: sessionID, cwd: "/repo", updatedAt: "2026-08-20T10:00:00.000Z" }]), {
      historyLoader: loader,
      snapshotDirectory: stateDirectory
    })

    assert.equal((await service.messages(sessionID)).length, 1)
    await service.flushSnapshots()

    const snapshotName = `${Buffer.from(sessionID).toString("base64url")}.json`
    const snapshot = JSON.parse(await readFile(path.join(stateDirectory, snapshotName), "utf8"))
    assert.deepEqual(snapshot.messages, [])
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("prompting a Session whose history is over the memory budget does not leave it busy", async () => {
  const acp = new EventEmitter()
  let prompted
  Object.assign(acp, {
    promptCapabilities: {},
    async start() {},
    async listSessions() { return [{ sessionId: "claude-long", cwd: "/repo" }] },
    notify() {},
    async request(method) {
      if (method !== "session/load") {
        // Read while the turn runs: once it ends, the budget may evict this transcript as usual.
        prompted = (await service.messages("claude-long")).find((message) => message.info.role === "user")
        return { stopReason: "end_turn" }
      }
      acp.emit("notification", { method: "session/update", params: { sessionId: "claude-long", update: { sessionUpdate: "agent_message_chunk", messageId: "msg_1", content: { type: "text", text: "x".repeat(25 * 1024 * 1024) } } } })
      return {}
    }
  })
  const service = new AcpService(acp)
  await service.messages("claude-long")
  await service.prompt("claude-long", "y".repeat(2_000))
  for (let wait = 0; wait < 200 && service.status("claude-long").type === "busy"; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(service.status("claude-long").type, "idle", "the Session stayed busy")
  assert.equal(prompted?.parts[0].text, "y".repeat(2_000), "the prompt was lost")
})

test("a queued prompt that starts on a Session over the memory budget keeps its history", async () => {
  const acp = new EventEmitter()
  let release
  const firstTurn = new Promise((resolve) => { release = resolve })
  let prompts = 0
  let secondTurnPrompts
  Object.assign(acp, {
    promptCapabilities: {},
    async start() {},
    async listSessions() { return [{ sessionId: "claude-long", cwd: "/repo" }] },
    notify() {},
    async request(method) {
      if (method === "session/load") {
        acp.emit("notification", { method: "session/update", params: { sessionId: "claude-long", update: { sessionUpdate: "agent_message_chunk", messageId: "msg_1", content: { type: "text", text: "x".repeat(25 * 1024 * 1024) } } } })
        return {}
      }
      prompts += 1
      if (prompts === 1) await firstTurn
      else secondTurnPrompts = (await service.messages("claude-long")).filter((message) => message.info.role === "user").map((message) => message.parts[0].text)
      return { stopReason: "end_turn" }
    }
  })
  const service = new AcpService(acp)
  await service.messages("claude-long")
  await service.prompt("claude-long", "first")
  await service.prompt("claude-long", "second")
  release()
  for (let wait = 0; wait < 200 && (prompts < 2 || service.status("claude-long").type === "busy"); wait += 1) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(secondTurnPrompts, ["first", "second"])
})
