import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import test from "node:test"
import { CopilotModelCatalog, CopilotSdkClient } from "../src/copilot-model-catalog.js"

function packet(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8")
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body])
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = { writable: true, write: () => true }
  killed = false
  kill() { this.killed = true }
}

function spawnFake({ respond = () => {}, onSpawn } = {}) {
  const calls = []
  let child
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options })
    child = new FakeChild()
    child.stdin.write = (frame, callback) => {
      const bytes = Buffer.isBuffer(frame) ? frame : Buffer.from(frame)
      const headerEnd = bytes.indexOf("\r\n\r\n")
      const message = JSON.parse(bytes.subarray(headerEnd + 4).toString("utf8"))
      respond(message, child)
      callback?.()
      return true
    }
    onSpawn?.(child)
    queueMicrotask(() => child.emit("spawn"))
    return child
  }
  return { spawnProcess, calls, get child() { return child } }
}

test("Copilot SDK client writes framed requests and parses fragmented Unicode replies by byte length", async () => {
  const fake = spawnFake({
    respond: (request, child) => {
      assert.equal(request.method, "models.list")
      const response = packet({
        jsonrpc: "2.0",
        id: request.id,
        result: { models: [{ id: "gpt-4.1", name: "Copilot 你好 🌍" }] }
      })
      child.stdout.write(response.subarray(0, 9))
      child.stdout.write(response.subarray(9, 27))
      child.stdout.write(response.subarray(27))
    }
  })
  const client = new CopilotSdkClient({ spawnProcess: fake.spawnProcess })
  const response = await client.request("models.list")
  assert.equal(response.models[0].name, "Copilot 你好 🌍")
  assert.deepEqual(fake.calls[0].args, ["--headless", "--stdio", "--no-auto-update"])
  assert.deepEqual(fake.calls[0].options.stdio, ["pipe", "pipe", "pipe"])
  await assert.rejects(client.request("session/new", {}), /not allowed/)
  client.close()
  assert.equal(fake.child.killed, true)
})

test("Copilot SDK client rejects pending requests on child exit and bounds request waits", async () => {
  const fake = spawnFake()
  const client = new CopilotSdkClient({ spawnProcess: fake.spawnProcess, timeoutMs: 1000 })
  const pending = client.request("models.list")
  await new Promise((resolve) => setImmediate(resolve))
  fake.child.emit("exit", 2, null)
  await assert.rejects(pending, /Copilot CLI exited/)

  const timeoutFake = spawnFake()
  const timeoutClient = new CopilotSdkClient({ spawnProcess: timeoutFake.spawnProcess, timeoutMs: 15 })
  await assert.rejects(timeoutClient.request("models.list"), /request timed out: models.list/)
  timeoutClient.close()
})

test("Copilot model catalog filters disabled entries and preserves native IDs and known metadata", async () => {
  const client = {
    async start() {},
    async request(method) {
      assert.equal(method, "models.list")
      return { models: [
        {
          id: "gpt-4.1-native/id",
          name: "GPT 4.1",
          description: "Native description",
          enabled: true,
          capabilities: { supports: { vision: true }, limits: { max_context_window_tokens: 128000, max_output_tokens: 16000 } },
          billing: { multiplier: 0 }
        },
        { id: "disabled-model", enabled: false },
        { id: "policy-disabled", policy: { state: "disabled" } },
        { name: "missing native id", enabled: true }
      ] }
    },
    diagnostics: () => ({ state: "running" }),
    close() {}
  }
  const catalog = new CopilotModelCatalog({ client })
  const result = await catalog.list({ allowStale: false })
  assert.equal(result.models.length, 1)
  assert.deepEqual(result.models[0], {
    providerID: "copilot",
    providerName: "GitHub Copilot",
    modelID: "gpt-4.1-native/id",
    modelName: "GPT 4.1",
    description: "Native description",
    contextLimit: 128000,
    outputLimit: 16000,
    attachments: true,
    isFree: true,
    billingMultiplier: 0
  })
  await catalog.validate({ providerID: "copilot", modelID: "gpt-4.1-native/id" })
  await assert.rejects(catalog.validate({ providerID: "copilot", modelID: "invented" }), /no longer available/)
  await assert.rejects(catalog.validate({ providerID: "copilot", modelID: "gpt-4.1-native/id", variant: "high" }), /no longer available/)
  assert.deepEqual(await catalog.preloadState(), new Set())
  assert.equal(catalog.diagnostics().hiddenSessionCount, 0)
})

test("Copilot model catalog shares one list request across concurrent callers and caches the result", async () => {
  let calls = 0
  const client = {
    async start() {},
    async request() {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { models: [{ id: "native-one", name: "One" }] }
    },
    close() {}
  }
  const catalog = new CopilotModelCatalog({ client })
  const results = await Promise.all(Array.from({ length: 20 }, () => catalog.list({ allowStale: false })))
  assert.equal(calls, 1)
  assert.equal(results.every((result) => result.models[0].modelID === "native-one"), true)
  assert.equal((await catalog.list({ allowStale: false })).models.length, 1)
  assert.equal(calls, 1)
})

test("empty Copilot model inventory refuses catalog resolution with login guidance", async () => {
  const client = {
    async start() {},
    async request() { return { models: [] } },
    close() {}
  }
  const catalog = new CopilotModelCatalog({ client })
  await assert.rejects(catalog.list({ allowStale: false }), (error) => {
    assert.equal(error.code, "model_catalog_unavailable")
    assert.match(error.message, /copilot login/)
    assert.match(error.message, /account enabled for Copilot/)
    return true
  })
  await assert.rejects(catalog.resolve({ providerID: "copilot", modelID: "made-up" }), (error) => error.code === "model_catalog_unavailable")
})

test("an authenticated Auto-only Copilot account does not need a new login or invented individual models", async () => {
  const calls = []
  const client = {
    async request(method) { calls.push(method); return method === "auth.getStatus" ? { isAuthenticated: true } : { models: [] } },
    close() {}
  }
  const catalog = new CopilotModelCatalog({ client, includeAuto: true })
  const { models } = await catalog.list({ allowStale: false })
  assert.deepEqual(models.map((model) => model.modelID), ["auto"])
  assert.equal(models[0].isDefault, true)
  assert.equal(models[0].isFree, undefined, "Auto pricing depends on the account; do not invent zero cost")
  await catalog.validate({ providerID: "copilot", modelID: "auto" })
  await assert.rejects(catalog.validate({ providerID: "copilot", modelID: "gpt-invented" }), /no longer available/)
  assert.deepEqual(calls, ["models.list", "auth.getStatus"])
})
