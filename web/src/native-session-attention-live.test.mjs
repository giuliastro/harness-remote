import assert from "node:assert/strict"
import test from "node:test"
import { startNativeSessionAttentionLiveRefresh } from "./native-session-attention-live.ts"

const baseConfig = {
  backend: "codex",
  host: "127.0.0.1",
  port: 9000,
  username: "user",
  password: "secret"
}

function agent(id, backend, capabilities) {
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

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

test("subscribes only to harnesses that advertise question or permission attention", () => {
  const subscriptions = []
  const controller = startNativeSessionAttentionLiveRefresh({
    targets: [
      { key: "open", baseConfig, agent: agent("opencode", "opencode", { questions: true, permissions: true }) },
      { key: "codex", baseConfig, agent: agent("codex", "codex", { questions: false, permissions: false }) }
    ],
    onRefresh: () => {},
    subscribe: (input) => {
      subscriptions.push(input)
      return { close() {} }
    },
    delayMs: 0
  })

  assert.equal(subscriptions.length, 1)
  assert.equal(subscriptions[0].config.agentId, "opencode")
  assert.equal(subscriptions[0].config.backend, "opencode")
  controller.close()
})

test("attention events coalesce per harness and unrelated events do not refresh", async () => {
  const subscriptions = []
  const refreshed = []
  const target = { key: "machine:opencode", baseConfig, agent: agent("opencode", "opencode", { questions: true }) }
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
})

test("reconnect schedules an authoritative attention refresh", async () => {
  let subscription
  const refreshed = []
  const target = { key: "machine:opencode", baseConfig, agent: agent("opencode", "opencode", { permissions: true }) }
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
  assert.deepEqual(refreshed, ["machine:opencode"])
  controller.close()
})

test("close cancels pending refreshes and closes every capability subscription", async () => {
  const subscriptions = []
  let refreshes = 0
  const controller = startNativeSessionAttentionLiveRefresh({
    targets: [
      { key: "a", baseConfig, agent: agent("open-a", "opencode", { questions: true }) },
      { key: "b", baseConfig, agent: agent("open-b", "opencode", { permissions: true }) }
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
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(refreshes, 0)
  assert.equal(subscriptions.every((record) => record.closed), true)
})
