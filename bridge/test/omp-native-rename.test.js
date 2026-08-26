import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { createBridgeServer } from "../src/server.js"

class RenameOmpAcp extends EventEmitter {
  agentInfo = { version: "18.0.6" }
  title = "Session 019faa51"
  prompts = []

  async start() {}

  async listSessions() {
    return [{
      sessionId: "019faa51-rename-test",
      title: this.title,
      cwd: process.cwd(),
      updatedAt: "2026-08-26T18:00:00.000Z"
    }]
  }

  async request(method, params) {
    if (method === "session/load") return { configOptions: [] }
    if (method === "session/prompt") {
      const text = params.prompt?.find((part) => part.type === "text")?.text || ""
      this.prompts.push(text)
      if (text.startsWith("/rename ")) this.title = text.slice("/rename ".length)
      return { stopReason: "end_turn" }
    }
    return {}
  }

  notify() {}
}

function authHeaders() {
  return {
    authorization: `Basic ${Buffer.from("omp:secret").toString("base64")}`,
    "content-type": "application/json"
  }
}

test("OMP rename is executed by OMP's native /rename ACP command and returned from session/list", async () => {
  const acp = new RenameOmpAcp()
  const historyLoader = async () => []
  const server = createBridgeServer({
    acp,
    serviceOptions: { historyLoader },
    config: {
      backend: "omp",
      host: "127.0.0.1",
      port: 0,
      username: "omp",
      password: "secret",
      roots: [process.cwd()]
    }
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const baseURL = `http://127.0.0.1:${address.port}`

  try {
    const response = await fetch(`${baseURL}/session/019faa51-rename-test?directory=${encodeURIComponent(process.cwd())}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ title: "Risolvi altra issue e crea PR" })
    })
    assert.equal(response.status, 200)
    const renamed = await response.json()
    assert.equal(renamed.title, "Risolvi altra issue e crea PR")
    assert.deepEqual(acp.prompts, ["/rename Risolvi altra issue e crea PR"])

    const listed = await fetch(`${baseURL}/experimental/session`, { headers: authHeaders() })
    assert.equal(listed.status, 200)
    assert.equal((await listed.json())[0].title, "Risolvi altra issue e crea PR")
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
