import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AcpService } from "../src/acp-service.js"
import { createOmpHistoryLoader } from "../src/omp-session-history.js"
import { createPiHistoryLoader } from "../src/pi-session-history.js"

const SESSION = "01a01000-0000-7000-8000-000000000000"

async function journal(prefix, separator, records) {
  const root = await mkdtemp(path.join(tmpdir(), `harness-${prefix}-`))
  const file = path.join(root, `2026-08-17T16-48-44-623Z${separator}${SESSION}.jsonl`)
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n"), "utf8")
  return root
}

const failedTurn = [
  { type: "message", id: "m1", parentId: null, timestamp: "2026-08-17T16:48:45.000Z", message: { role: "user", content: "ciao" } },
  {
    type: "message",
    id: "m2",
    parentId: "m1",
    timestamp: "2026-08-17T16:49:07.000Z",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 Rate limit exceeded" }
  }
]

test("an OMP turn that failed stays in the transcript with the provider's reason", async () => {
  const root = await journal("omp", "_", failedTurn)
  const messages = await createOmpHistoryLoader(root)(SESSION, { activeSessionLeaf: "m2" })
  assert.deepEqual(messages.map((message) => message.info.role), ["user", "assistant"])
  assert.deepEqual(messages[1].parts, [])
  assert.equal(messages[1].info.error?.message, "429 Rate limit exceeded")
  assert.equal(messages[0].info.error, undefined)
})

test("a PI turn that failed stays in the transcript with the provider's reason", async () => {
  const root = await journal("pi", "_", failedTurn)
  const messages = await createPiHistoryLoader(root)(SESSION)
  assert.deepEqual(messages.map((message) => message.info.role), ["user", "assistant"])
  assert.equal(messages[1].info.error?.message, "429 Rate limit exceeded")
})

test("a blank errorMessage is not mistaken for a failure worth showing", async () => {
  const root = await journal("pi-blank", "_", [
    failedTurn[0],
    { ...failedTurn[1], message: { role: "assistant", content: [], errorMessage: "   " } }
  ])
  const messages = await createPiHistoryLoader(root)(SESSION)
  assert.deepEqual(messages.map((message) => message.info.role), ["user"])
})

class FailingAcp extends EventEmitter {
  async listSessions() {
    return [{ sessionId: SESSION, cwd: process.cwd(), title: "Failing", updatedAt: new Date().toISOString() }]
  }

  async request(method, params) {
    if (method === "session/load") return { configOptions: [] }
    if (method === "session/prompt") throw new Error("Internal error: provider rejected the request")
    throw new Error(`Unexpected request: ${method}`)
  }

  notify() {}
}

class SilentAcp extends EventEmitter {
  async listSessions() {
    return [{ sessionId: SESSION, cwd: process.cwd(), title: "Silent", updatedAt: new Date().toISOString() }]
  }

  async request(method) {
    if (method === "session/load") return { configOptions: [] }
    if (method === "session/prompt") return { stopReason: "end_turn" }
    throw new Error(`Unexpected request: ${method}`)
  }

  notify() {}
}

test("a live ACP turn failure is recorded on the transcript, not only announced once", async () => {
  const service = new AcpService(new FailingAcp())
  const errors = []
  service.subscribe((event) => {
    if (event.type === "session.error") errors.push(event.message)
  })
  await service.prompt(SESSION, "ciao")
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.deepEqual(errors, ["Internal error: provider rejected the request"])
  const messages = await service.messages(SESSION)
  assert.deepEqual(messages.map((message) => message.info.role), ["user", "assistant"])
  assert.equal(messages[1].info.error?.message, "Internal error: provider rejected the request")
})

test("a configured ACP harness cannot settle Ready without an assistant response", async () => {
  const service = new AcpService(new SilentAcp(), { requireAssistantResponse: true })
  const errors = []
  service.subscribe((event) => {
    if (event.type === "session.error") errors.push(event.message)
  })

  await assert.rejects(service.promptAndWait(SESSION, "silent turn"), /without an assistant response/)
  assert.deepEqual(errors, ["Harness completed the prompt without an assistant response"])
  const messages = await service.messages(SESSION)
  assert.equal(messages.at(-1).info.error?.message, "Harness completed the prompt without an assistant response")
  assert.equal(service.status(SESSION).type, "idle")
})


test("a live PI provider failure remains visible until the authoritative journal catches up, then deduplicates", async () => {
  let persisted = []
  const historyLoader = async () => persisted
  historyLoader.page = async () => ({ messages: persisted, before: null, hasMore: false })
  historyLoader.authoritativeHistory = true
  historyLoader.claimOnLoad = true

  const service = new AcpService(new FailingAcp(), { historyLoader })
  await service.prompt(SESSION, "bad model turn")
  await new Promise((resolve) => setTimeout(resolve, 20))

  const live = (await service.messagePage(SESSION, { limit: 100 })).messages
  assert.equal(live.filter((message) => message.info.role === "user").length, 1)
  assert.equal(live.filter((message) => message.info.error?.message).length, 1)
  assert.match(live.find((message) => message.info.error)?.info.error.message, /provider rejected/)

  // PI can write a provider-specific sentence and a different message id into JSONL after ACP has
  // already rejected the request. That persisted turn must replace, not sit beside, the bridge copy.
  persisted = [
    {
      info: { id: "pi-journal-user", role: "user", sessionID: SESSION, time: { created: Date.now() - 5 } },
      parts: [{ id: "pi-journal-user-text", messageID: "pi-journal-user", type: "text", text: "bad model turn" }]
    },
    {
      info: {
        id: "pi-journal-error",
        role: "assistant",
        sessionID: SESSION,
        time: { created: Date.now() },
        error: { name: "HarnessTurnError", message: "Model is no longer available" }
      },
      parts: []
    }
  ]

  const durable = (await service.messagePage(SESSION, { limit: 100 })).messages
  assert.equal(durable.filter((message) => message.info.role === "user").length, 1)
  assert.equal(durable.filter((message) => message.info.error?.message).length, 1)
  assert.equal(durable.find((message) => message.info.error)?.info.error.message, "Model is no longer available")
})

class QueuedModelFailureAcp extends EventEmitter {
  promptCalls = 0
  #releaseFirst

  async listSessions() {
    return [{ sessionId: SESSION, cwd: process.cwd(), title: "Queued model failure", updatedAt: new Date().toISOString() }]
  }

  async request(method, params) {
    if (method === "session/load") {
      return {
        configOptions: [{
          id: "model",
          currentValue: "provider/good",
          options: [
            { value: "provider/good", name: "Good" },
            { value: "provider/bad", name: "Bad" }
          ]
        }]
      }
    }
    if (method === "session/prompt") {
      this.promptCalls += 1
      if (this.promptCalls === 1) return new Promise((resolve) => { this.#releaseFirst = resolve })
      throw new Error("a queued prompt must not reach session/prompt after model setup failed")
    }
    if (method === "session/set_config_option") {
      if (params?.value === "provider/bad") throw new Error("Harness model is no longer usable")
      return { configOptions: [] }
    }
    throw new Error(`Unexpected request: ${method}`)
  }

  releaseFirst() {
    this.#releaseFirst?.({})
  }

  notify() {}
}

test("a queued prompt whose model switch fails is terminated instead of running on the previous model", async () => {
  const acp = new QueuedModelFailureAcp()
  const service = new AcpService(acp)
  const errors = []
  service.subscribe((event) => {
    if (event.type === "session.error") errors.push(event.message)
  })

  await service.prompt(SESSION, "first turn")
  await service.prompt(SESSION, "queued bad-model turn", "provider/bad")
  assert.equal(acp.promptCalls, 1, "queued turn must wait for the active prompt")

  acp.releaseFirst()
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(acp.promptCalls, 1, "failed queued model setup must not dispatch on the previous model")
  assert.deepEqual(errors, ["Harness model is no longer usable"])
  const messages = await service.messages(SESSION)
  const queuedPromptIndex = messages.findIndex((message) =>
    message.info.role === "user" && message.parts?.some((part) => part.text === "queued bad-model turn")
  )
  assert.ok(queuedPromptIndex >= 0)
  assert.equal(messages.slice(queuedPromptIndex + 1).filter((message) => message.info.error?.message === "Harness model is no longer usable").length, 1)
})
