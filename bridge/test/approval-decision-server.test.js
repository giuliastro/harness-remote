import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import { createApprovalDecisionServer } from "../src/approval-decision-server.js"

function config() { return { username: "harness", password: "secret", corsOrigins: [] } }
function authorization() { return `Basic ${Buffer.from("harness:secret").toString("base64")}` }
function identity() { return { machineID: "machine-1", agentID: "opencode", sessionID: "session-1", directory: "/work/project" } }
function record() {
  return {
    ...identity(),
    requestID: "permission-1",
    requestedAction: "write",
    boundary: ["src/**"],
    decision: "once",
    decidedAt: "2026-09-11T07:50:00.000Z"
  }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${server.address().port}`
}
function close(server) { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }

function store() {
  const records = []
  return {
    records,
    async record(input) { records.push(input); return { type: "authorization-decision", ...input, semantics: "one-shot" } },
    async listFor(input) { assert.deepEqual(input, identity()); return records.map((entry) => ({ type: "authorization-decision", ...entry, semantics: "one-shot" })) }
  }
}

test("approval metadata API is authenticated and never delegates its own route", async () => {
  let delegated = 0
  const innerServer = http.createServer((_request, response) => { delegated += 1; response.writeHead(418); response.end() })
  const decisionStore = store()
  const server = createApprovalDecisionServer({ innerServer, config: config(), store: decisionStore })
  const base = await listen(server)
  try {
    assert.equal((await fetch(`${base}/v1/approval-decisions`)).status, 401)
    const posted = await fetch(`${base}/v1/approval-decisions`, {
      method: "POST",
      headers: { Authorization: authorization(), "Content-Type": "application/json" },
      body: JSON.stringify(record())
    })
    assert.equal(posted.status, 200)
    assert.equal((await posted.json()).decision.requestID, "permission-1")
    assert.equal(delegated, 0)
  } finally { await close(server) }
})

test("approval metadata can be read by another authenticated client using exact native identity", async () => {
  const innerServer = http.createServer((_request, response) => { response.writeHead(404); response.end() })
  const decisionStore = store()
  await decisionStore.record(record())
  const server = createApprovalDecisionServer({ innerServer, config: config(), store: decisionStore })
  const base = await listen(server)
  try {
    const query = new URLSearchParams(identity()).toString()
    const response = await fetch(`${base}/v1/approval-decisions?${query}`, { headers: { Authorization: authorization() } })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).decisions[0].requestID, "permission-1")
  } finally { await close(server) }
})

test("unrelated routes remain byte-owned by the existing stack", async () => {
  const innerServer = http.createServer((request, response) => {
    assert.equal(request.url, "/v1/machine")
    response.writeHead(204)
    response.end()
  })
  const server = createApprovalDecisionServer({ innerServer, config: config(), store: store() })
  const base = await listen(server)
  try { assert.equal((await fetch(`${base}/v1/machine`)).status, 204) }
  finally { await close(server) }
})
