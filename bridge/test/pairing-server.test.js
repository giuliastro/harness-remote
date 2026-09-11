import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import { OneTimePairingGrant, createPairingServer } from "../src/pairing-server.js"

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}
function close(server) { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
function config() { return { username: "harness", password: "secret-password", corsOrigins: [] } }
function machine() { return { id: "machine-1", name: "Dev workstation" } }
function grant(overrides = {}) {
  return new OneTimePairingGrant({ token: "one-time-token", expiresAt: 2_000, now: () => 1_000, ...overrides })
}

async function claim(base, token = "one-time-token") {
  return fetch(`${base}/v1/pairing/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  })
}

test("pairing claim returns the existing daemon credentials without Basic Auth", async () => {
  const innerServer = http.createServer((_request, response) => { response.writeHead(401); response.end() })
  const server = createPairingServer({ innerServer, config: config(), machine: machine(), grant: grant() })
  const base = await listen(server)
  try {
    const response = await claim(base)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("cache-control"), "no-store")
    assert.deepEqual(await response.json(), {
      version: 1,
      machine: { id: "machine-1", name: "Dev workstation" },
      credentials: { username: "harness", password: "secret-password" }
    })
  } finally { await close(server) }
})

test("a pairing grant can be consumed exactly once", async () => {
  const innerServer = http.createServer((_request, response) => { response.writeHead(500); response.end() })
  const server = createPairingServer({ innerServer, config: config(), machine: machine(), grant: grant() })
  const base = await listen(server)
  try {
    assert.equal((await claim(base)).status, 200)
    const second = await claim(base)
    assert.equal(second.status, 409)
    assert.match((await second.json()).error, /already been used/i)
  } finally { await close(server) }
})

test("invalid token does not consume the valid grant", async () => {
  const innerServer = http.createServer((_request, response) => { response.writeHead(500); response.end() })
  const server = createPairingServer({ innerServer, config: config(), machine: machine(), grant: grant() })
  const base = await listen(server)
  try {
    assert.equal((await claim(base, "wrong-token")).status, 401)
    assert.equal((await claim(base)).status, 200)
  } finally { await close(server) }
})

test("expired pairing grant fails closed", async () => {
  const innerServer = http.createServer((_request, response) => { response.writeHead(500); response.end() })
  const server = createPairingServer({
    innerServer,
    config: config(),
    machine: machine(),
    grant: grant({ expiresAt: 999 })
  })
  const base = await listen(server)
  try {
    const response = await claim(base)
    assert.equal(response.status, 410)
    assert.match((await response.json()).error, /expired/i)
  } finally { await close(server) }
})

test("pairing wrapper delegates every unrelated route to the existing authenticated stack", async () => {
  let delegated = 0
  const innerServer = http.createServer((request, response) => {
    delegated += 1
    assert.equal(request.url, "/v1/machine")
    response.writeHead(401, { "WWW-Authenticate": "Basic" })
    response.end()
  })
  const server = createPairingServer({ innerServer, config: config(), machine: machine(), grant: grant() })
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/v1/machine`)
    assert.equal(response.status, 401)
    assert.equal(delegated, 1)
  } finally { await close(server) }
})
