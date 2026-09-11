import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import {
  OneTimePairingGrant,
  PAIRING_TTL_MS,
  announceMachinePairing,
  createOneTimePairingGrant,
  createPairingServer,
  machinePairingLinks,
  renderPairingQRCode
} from "../src/pairing-server.js"

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}
function close(server) { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
function config() { return { host: "0.0.0.0", port: 4097, username: "harness", password: "secret-password", corsOrigins: [] } }
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

test("generated pairing grant is high entropy and expires after the short bootstrap window", () => {
  const generated = createOneTimePairingGrant({
    now: () => 10_000,
    randomBytesImpl: (size) => {
      assert.equal(size, 32)
      return Buffer.alloc(size, 0xab)
    }
  })
  assert.match(generated.token, /^[A-Za-z0-9_-]{40,}$/)
  assert.equal(generated.expiresAt, 10_000 + PAIRING_TTL_MS)
})

test("scan-ready pairing links contain the one-time grant but never Basic Auth credentials", () => {
  const links = machinePairingLinks(config(), grant(), {
    eth0: [{ family: "IPv4", internal: false, address: "192.168.1.44" }]
  })
  assert.equal(links.length, 1)
  assert.equal(links[0].endpoint, "http://192.168.1.44:4097")
  assert.match(links[0].uri, /^harnessremote:\/\/pair\?/)
  assert.match(links[0].uri, /token=one-time-token/)
  assert.doesNotMatch(links[0].uri, /secret-password|harness%3A|username|password/)
})

test("terminal QR renderer asks for compact output and returns the generated code", () => {
  let received
  const output = renderPairingQRCode("harnessremote://pair?token=abc", {
    load: () => ({
      generate(input, options, callback) {
        received = { input, options }
        callback("QR-CODE")
      }
    })
  })
  assert.equal(output, "QR-CODE")
  assert.deepEqual(received, {
    input: "harnessremote://pair?token=abc",
    options: { small: true }
  })
})

test("terminal QR renderer fails open to the plain pairing link when the presentation dependency is unavailable", () => {
  const output = renderPairingQRCode("harnessremote://pair?token=abc", {
    load: () => { throw new Error("module not installed") }
  })
  assert.equal(output, null)
})

test("startup pairing announcement renders one preferred QR and keeps alternate LAN links as text", () => {
  let output = ""
  let renderedURI
  const links = announceMachinePairing(config(), grant(), {
    interfaces: {
      eth0: [{ family: "IPv4", internal: false, address: "192.168.1.44" }],
      wlan0: [{ family: "IPv4", internal: false, address: "192.168.1.45" }]
    },
    write: (text) => { output += text },
    renderQR: (uri) => {
      renderedURI = uri
      return "<QR>"
    }
  })
  assert.equal(links.length, 2)
  assert.equal(renderedURI, links[0].uri)
  assert.match(output, /<QR>/)
  assert.match(output, /Scan the QR above for http:\/\/192\.168\.1\.44:4097/)
  assert.match(output, /192\.168\.1\.45%3A4097/)
  assert.match(output, /one-time token, not the daemon password/i)
  assert.doesNotMatch(output, /secret-password/)
})

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
