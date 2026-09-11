import assert from "node:assert/strict"
import { loadNativeSessionAttentionIndex } from "./native-session-attention-index.ts"
import { startNativeSessionAttentionLiveRefresh } from "./native-session-attention-live.ts"

const baseConfig = {
  backend: "codex",
  host: "127.0.0.1",
  port: 4097,
  username: "harness",
  password: "secret"
}

function agent(id, capabilities) {
  return {
    id,
    label: id,
    backend: id,
    transport: id === "opencode" ? "http" : "acp",
    managed: true,
    state: "available",
    capabilities
  }
}

function liveAgent(id, backend, capabilities) {
  return {
    id,
    label: id,
    backend,
    transport: backend === "opencode" ? "http" : "acp",
    managed: true,
    state: "available",
    capabilities
  }
}

const question = (id, sessionID) => ({
  id,
  sessionID,
  questions: [{ question: `Question ${id}`, header: "Choice", options: [] }]
})

const permission = (id, sessionID) => ({
  id,
  sessionID,
  permission: "edit",
  patterns: ["src/**"],
  metadata: {},
  always: []
})

const tick = (milliseconds = 5) => new Promise((resolve) => setTimeout(resolve, milliseconds))

{
  let calls = 0
  const result = await loadNativeSessionAttentionIndex(baseConfig, agent("codex", { questions: false, permissions: false }), {
    loadQuestions: async () => { calls += 1; throw new Error("must not run") },
    loadPermissions: async () => { calls += 1; throw new Error("must not run") }
  })
  assert.equal(calls, 0, "unsupported capabilities must never be probed")
  assert.deepEqual(result.queried, { questions: false, permissions: false })
  assert.equal(result.complete, true)
  assert.deepEqual(result.items, [])
}

{
  let questionCalls = 0
  let permissionCalls = 0
  const seenConfigs = []
  const result = await loadNativeSessionAttentionIndex(baseConfig, agent("opencode", { questions: true, permissions: true }), {
    loadQuestions: async (config) => {
      questionCalls += 1
      seenConfigs.push(config)
      return [question("q-1", "session-a"), question("q-2", "session-b")]
    },
    loadPermissions: async (config) => {
      permissionCalls += 1
      seenConfigs.push(config)
      return [permission("p-1", "session-a")]
    }
  })

  assert.equal(questionCalls, 1, "questions are fetched once per capable harness, not once per Session")
  assert.equal(permissionCalls, 1, "permissions are fetched once per capable harness, not once per Session")
  assert.ok(seenConfigs.every((config) => config.agentId === "opencode" && config.backend === "opencode"), "attention reads must route to the exact harness")
  assert.equal(result.complete, true)
  assert.equal(result.items.length, 2)
  assert.equal(result.items.find((item) => item.sessionID === "session-a").attention.kind, "authorization", "permission must outrank a question for the same Session")
  assert.equal(result.items.find((item) => item.sessionID === "session-b").attention.kind, "recoverable")
}

{
  let permissionCalls = 0
  const result = await loadNativeSessionAttentionIndex(baseConfig, agent("opencode", { questions: true, permissions: true }), {
    loadQuestions: async () => { throw new Error("question endpoint unavailable") },
    loadPermissions: async () => {
      permissionCalls += 1
      return [permission("p-2", "session-c")]
    }
  })

  assert.equal(permissionCalls, 1)
  assert.equal(result.complete, false, "one failed capability read must be visible instead of being flattened into an empty inbox")
  assert.match(result.errors.questions, /question endpoint unavailable/)
  assert.equal(result.errors.permissions, undefined)
  assert.equal(result.items[0].sessionID, "session-c")
  assert.equal(result.items[0].attention.kind, "authorization", "successful capability data must survive a sibling endpoint failure")
}

{
  let questionCalls = 0
  let permissionCalls = 0
  const result = await loadNativeSessionAttentionIndex(baseConfig, agent("opencode", { questions: true, permissions: false }), {
    loadQuestions: async () => {
      questionCalls += 1
      return [question("q-3", "session-d")]
    },
    loadPermissions: async () => {
      permissionCalls += 1
      return []
    }
  })

  assert.equal(questionCalls, 1)
  assert.equal(permissionCalls, 0, "a capability that is false must stay entirely out of the request path")
  assert.equal(result.items[0].attention.kind, "recoverable")
}

{
  const subscriptions = []
  const controller = startNativeSessionAttentionLiveRefresh({
    targets: [
      { key: "open", baseConfig, agent: liveAgent("opencode", "opencode", { questions: true, permissions: true }) },
      { key: "codex", baseConfig, agent: liveAgent("codex", "codex", { questions: false, permissions: false }) }
    ],
    onRefresh: () => {},
    subscribe: (input) => {
      subscriptions.push(input)
      return { close() {} }
    },
    delayMs: 0
  })

  assert.equal(subscriptions.length, 1, "only capability-enabled harnesses should consume a live stream")
  assert.equal(subscriptions[0].config.agentId, "opencode")
  assert.equal(subscriptions[0].config.backend, "opencode")
  controller.close()
}

{
  const subscriptions = []
  const refreshed = []
  const target = { key: "machine:opencode", baseConfig, agent: liveAgent("opencode", "opencode", { questions: true }) }
  const controller = startNativeSessionAttentionLiveRefresh({
    targets: [target],
    onRefresh: (value) => refreshed.push(value.key),
    subscribe: (input) => {
      subscriptions.push(input)
      return { close() {} }
    },
    delayMs: 0
  })

  subscriptions[0].onEvent({ type: "message.updated", sessionID: "s1" })
  subscriptions[0].onEvent({ type: "permission.updated", sessionID: "s1" })
  subscriptions[0].onEvent({ type: "permission.replied", sessionID: "s1" })
  subscriptions[0].onEvent({ type: "question.asked", sessionID: "s2" })
  await tick()

  assert.deepEqual(refreshed, ["machine:opencode"], "bursty attention edges must become one small index refresh")
  controller.close()
}

{
  let subscription
  const refreshed = []
  const target = { key: "machine:opencode", baseConfig, agent: liveAgent("opencode", "opencode", { permissions: true }) }
  const controller = startNativeSessionAttentionLiveRefresh({
    targets: [target],
    onRefresh: (value) => refreshed.push(value.key),
    subscribe: (input) => {
      subscription = input
      return { close() {} }
    },
    delayMs: 0
  })

  subscription.onStatus({ type: "reconnecting" })
  await tick()
  assert.deepEqual(refreshed, [])
  subscription.onStatus({ type: "connected" })
  await tick()
  assert.deepEqual(refreshed, ["machine:opencode"], "reconnect must recover attention edges that may have been missed")
  controller.close()
}

{
  const subscriptions = []
  let refreshes = 0
  const controller = startNativeSessionAttentionLiveRefresh({
    targets: [
      { key: "a", baseConfig, agent: liveAgent("open-a", "opencode", { questions: true }) },
      { key: "b", baseConfig, agent: liveAgent("open-b", "opencode", { permissions: true }) }
    ],
    onRefresh: () => { refreshes += 1 },
    subscribe: (input) => {
      const record = { input, closed: false }
      subscriptions.push(record)
      return { close() { record.closed = true } }
    },
    delayMs: 20
  })

  subscriptions[0].input.onEvent({ type: "question.asked", sessionID: "s1" })
  controller.close()
  await tick(30)

  assert.equal(refreshes, 0, "closing the workspace must cancel a pending attention refresh")
  assert.equal(subscriptions.every((record) => record.closed), true, "every capability stream must be closed")
}

console.log("native Session capability-driven attention index and live refresh tests passed")
