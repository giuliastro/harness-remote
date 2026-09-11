import assert from "node:assert/strict"
import { loadNativeSessionAttentionIndex } from "./native-session-attention-index.ts"

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

console.log("native Session capability-driven attention index tests passed")
