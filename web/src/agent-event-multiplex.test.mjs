import assert from "node:assert/strict"
import test from "node:test"
import { createAgentEventMultiplexer } from "./agent-event-multiplex.ts"

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeConnect() {
  const connections = []
  const connect = (options) => {
    const connection = { options, closed: false, close() { this.closed = true } }
    connections.push(connection)
    return connection
  }
  return { connect, connections, open: () => connections.filter((connection) => !connection.closed) }
}

test("every harness of one machine shares one connection and gets its own events", async () => {
  const { connect, connections, open } = fakeConnect()
  const multiplexer = createAgentEventMultiplexer(connect)
  const seen = { claude: [], deepseek: [] }
  const statuses = { claude: [], deepseek: [] }
  const subscribe = (agentID) => multiplexer.subscribe({
    machineURL: "http://pc:4097",
    headers: { Authorization: "Basic x" },
    agentID,
    onEvent: (event) => seen[agentID].push(event),
    onStatus: (status) => statuses[agentID].push(status.type),
    fallback: () => { throw new Error("must not fall back") }
  })
  const claude = subscribe("claude")
  const deepseek = subscribe("deepseek")
  await wait(80)
  assert.equal(open().length, 1, "one connection for the machine")
  assert.equal(open()[0].options.url, "http://pc:4097/v1/events/agents?agents=claude%2Cdeepseek")
  assert.deepEqual(open()[0].options.headers, { Authorization: "Basic x" })

  const { onEvent } = open()[0].options
  onEvent({ name: "hr.agent-status", data: { agentID: "claude", status: "connected" } })
  onEvent({ name: "hr.agent-event", data: { agentID: "claude", frame: "event: message.updated\ndata: {\"sessionID\":\"c1\"}" } })
  onEvent({ name: "hr.agent-event", data: { agentID: "deepseek", frame: "data: {\"type\":\"session.updated\",\"sessionID\":\"d1\"}" } })
  assert.deepEqual(statuses.claude, ["connected"])
  assert.deepEqual(statuses.deepseek, [])
  assert.deepEqual(seen.claude, [{ name: "message.updated", data: { sessionID: "c1" } }])
  assert.equal(seen.deepseek.length, 1)
  assert.equal(seen.deepseek[0].data.sessionID, "d1")

  // Dropping a harness reconnects once with the remaining set; the last one closes everything.
  claude.close()
  await wait(80)
  assert.equal(open().length, 1)
  assert.match(open()[0].options.url, /agents=deepseek$/)
  deepseek.close()
  assert.equal(open().length, 0)
  assert.equal(connections.length, 2)
})

test("a daemon without the multiplex endpoint falls back to one stream per harness", async () => {
  const { connect, open } = fakeConnect()
  const multiplexer = createAgentEventMultiplexer(connect)
  const direct = []
  const subscribe = (agentID) => multiplexer.subscribe({
    machineURL: "http://old:4097",
    agentID,
    onEvent: () => {},
    fallback: () => {
      const handle = { agentID, closed: false, close() { this.closed = true } }
      direct.push(handle)
      return handle
    }
  })
  const first = subscribe("opencode")
  await wait(80)
  open()[0].options.onStatus({ type: "connection-error", error: "HTTP 404" })
  assert.equal(open().length, 0, "the multiplex is abandoned for this machine")
  assert.deepEqual(direct.map((handle) => handle.agentID), ["opencode"])
  const second = subscribe("pi")
  await wait(80)
  assert.deepEqual(direct.map((handle) => handle.agentID), ["opencode", "pi"], "later subscribers go direct at once")
  assert.equal(open().length, 0)
  first.close()
  second.close()
  assert.ok(direct.every((handle) => handle.closed))
})
