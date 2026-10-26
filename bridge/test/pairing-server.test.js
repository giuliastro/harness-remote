import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import {
  MachinePairingGrants,
  OneTimePairingGrant,
  PAIRING_TTL_MS,
  announceMachinePairing,
  createOneTimePairingGrant,
  createPairingServer,
  machinePairingLinks,
  pairingBoundToLoopback,
  pairingQRRendererMissing,
  renderPairingQRCode,
  watchStartupPairing
} from "../src/pairing-server.js"

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}
function close(server) { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
function config(overrides = {}) { return { host: "0.0.0.0", port: 4097, username: "harness", password: "secret-password", corsOrigins: [], ...overrides } }
function machine() { return { id: "machine-1", name: "Dev workstation" } }
function grant(overrides = {}) {
  return new OneTimePairingGrant({ token: "one-time-token", expiresAt: 2_000, now: () => 1_000, ...overrides })
}
function grants(overrides = {}) {
  return new MachinePairingGrants({ grant: grant(), ...overrides })
}
function authorization(username = "harness", password = "secret-password") {
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
}
function tokenFromURI(uri) {
  return new URL(uri).searchParams.get("token")
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

test("terminal QR renderer is optional when the presentation dependency is unavailable", () => {
  const output = renderPairingQRCode("harnessremote://pair?token=abc", {
    load: () => { throw new Error("module not installed") }
  })
  assert.equal(output, null)
})

test("startup pairing announcement renders one preferred QR without raw deep links or endpoints", () => {
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
  assert.match(output, /Phone pairing/)
  assert.match(output, /<QR>/)
  assert.match(output, /Scan this QR in Harness Remote/)
  assert.doesNotMatch(output, /harnessremote:\/\//)
  assert.doesNotMatch(output, /one-time-token|secret-password/)
  assert.doesNotMatch(output, /https?:\/\//)
  assert.doesNotMatch(output, /192\.168\.1\.44|192\.168\.1\.45/)
})

test("pairing announcement falls back to normal machine setup without leaking pairing authority", () => {
  let output = ""
  announceMachinePairing(config(), grant(), {
    interfaces: {
      eth0: [{ family: "IPv4", internal: false, address: "192.168.1.44" }]
    },
    write: (text) => { output += text },
    renderQR: () => null,
    rendererMissing: () => false
  })
  assert.match(output, /Machines → Add machine/)
  assert.match(output, /address and credentials/)
  assert.doesNotMatch(output, /npm install/, "a render failure must not blame a missing dependency")
  assert.doesNotMatch(output, /harnessremote:\/\//)
  assert.doesNotMatch(output, /one-time-token|secret-password/)
  assert.doesNotMatch(output, /https?:\/\//)
})

test("pairing announcement explains a missing QR renderer in a source checkout", () => {
  let output = ""
  announceMachinePairing(config(), grant(), {
    interfaces: {
      eth0: [{ family: "IPv4", internal: false, address: "192.168.1.44" }]
    },
    write: (text) => { output += text },
    renderQR: () => null,
    rendererMissing: () => true
  })
  assert.match(output, /qrcode-terminal/)
  assert.match(output, /npm install/)
  assert.match(output, /npx harness-remote@latest/)
  assert.match(output, /Machines → Add machine/)
  assert.doesNotMatch(output, /one-time-token|secret-password/)
})

test("QR renderer is reported missing only when the module cannot be resolved", () => {
  assert.equal(pairingQRRendererMissing({ resolve: () => "/node_modules/qrcode-terminal/lib/main.js" }), false)
  assert.equal(pairingQRRendererMissing({
    resolve: () => { throw Object.assign(new Error("Cannot find module"), { code: "MODULE_NOT_FOUND" }) }
  }), true)
  assert.equal(pairingQRRendererMissing({ resolve: () => { throw new Error("EACCES") } }), false)
})

test("pairing claim returns the existing daemon credentials without Basic Auth", async () => {
  const innerServer = http.createServer((_request, response) => { response.writeHead(401); response.end() })
  const server = createPairingServer({ innerServer, config: config(), machine: machine(), grants: grants() })
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
  const server = createPairingServer({ innerServer, config: config(), machine: machine(), grants: grants() })
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
  const server = createPairingServer({ innerServer, config: config(), machine: machine(), grants: grants() })
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
    grants: grants({ grant: grant({ expiresAt: 999 }) })
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
  const server = createPairingServer({ innerServer, config: config(), machine: machine(), grants: grants() })
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/v1/machine`)
    assert.equal(response.status, 401)
    assert.equal(delegated, 1)
  } finally { await close(server) }
})

test("pairing bind detection distinguishes loopback from network-reachable hosts", () => {
  for (const host of ["127.0.0.1", "127.0.1.1", "::1", "localhost", "  LOCALHOST  "]) {
    assert.equal(pairingBoundToLoopback(host), true, `${host} is loopback`)
  }
  for (const host of ["0.0.0.0", "::", "192.168.1.44", "harness.local", ""]) {
    assert.equal(pairingBoundToLoopback(host), false, `${host} is reachable`)
  }
})

test("the grant route rejects unauthenticated requests without issuing or exposing a grant", async () => {
  const innerServer = http.createServer((_request, response) => { response.writeHead(500); response.end() })
  const pairing = grants()
  const server = createPairingServer({ innerServer, config: config(), machine: machine(), grants: pairing })
  const base = await listen(server)
  try {
    assert.equal((await fetch(`${base}/v1/pairing/grant`, { method: "POST" })).status, 401)
    assert.equal((await fetch(`${base}/v1/pairing/grant`)).status, 401)
    const wrongPassword = await fetch(`${base}/v1/pairing/grant`, { method: "POST", headers: authorization("harness", "wrong-password") })
    assert.equal(wrongPassword.status, 401)
    // The refused requests changed nothing: the grant that existed before them is still the one the
    // daemon holds, and it is only usable through the normal claim path.
    assert.equal((await claim(base, pairing.current.token)).status, 200)
  } finally { await close(server) }
})

test("an authenticated grant request issues fresh scan-ready URIs for every reachable address", async () => {
  let counter = 0
  const server = createPairingServer({
    innerServer: http.createServer((_request, response) => { response.writeHead(500); response.end() }),
    config: config(),
    machine: machine(),
    grants: new MachinePairingGrants({
      now: () => 10_000,
      randomBytesImpl: (size) => Buffer.alloc(size, 0x10 + counter++)
    }),
    interfaces: {
      lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
      eth0: [{ family: "IPv4", internal: false, address: "192.168.1.44" }],
      wlan0: [{ family: "IPv4", internal: false, address: "192.168.1.45" }]
    }
  })
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/v1/pairing/grant`, { method: "POST", headers: authorization() })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("cache-control"), "no-store")
    const body = await response.json()
    assert.equal(body.version, 1)
    assert.equal(body.loopbackOnly, false)
    assert.equal(body.expiresAt, 10_000 + PAIRING_TTL_MS)
    assert.deepEqual(body.links.map((link) => link.endpoint), [
      "http://192.168.1.44:4097",
      "http://192.168.1.45:4097"
    ])
    for (const link of body.links) {
      assert.match(link.uri, /^harnessremote:\/\/pair\?/)
      assert.equal(new URL(link.uri).searchParams.get("endpoint"), link.endpoint)
    }
    // A grant response is scan material, never credentials.
    assert.doesNotMatch(JSON.stringify(body), /secret-password|"username"|"password"/)
  } finally { await close(server) }
})

test("regenerating a grant replaces the outstanding one so an old QR cannot be claimed", async () => {
  let counter = 0
  const pairing = new MachinePairingGrants({
    now: () => 20_000,
    randomBytesImpl: (size) => Buffer.alloc(size, 0x20 + counter++)
  })
  const server = createPairingServer({
    innerServer: http.createServer((_request, response) => { response.writeHead(500); response.end() }),
    config: config(),
    machine: machine(),
    grants: pairing,
    interfaces: { eth0: [{ family: "IPv4", internal: false, address: "192.168.1.44" }] }
  })
  const base = await listen(server)
  try {
    const issue = async () => (await (await fetch(`${base}/v1/pairing/grant`, { method: "POST", headers: authorization() })).json())
    const firstToken = tokenFromURI((await issue()).links[0].uri)
    const secondToken = tokenFromURI((await issue()).links[0].uri)
    assert.notEqual(firstToken, secondToken)
    assert.equal((await claim(base, firstToken)).status, 401)
    assert.equal((await claim(base, secondToken)).status, 200)
    assert.equal((await claim(base, secondToken)).status, 409)
  } finally { await close(server) }
})

test("grant status reports pending, claimed and expired truthfully", async () => {
  let clock = 30_000
  let counter = 0
  const pairing = new MachinePairingGrants({
    now: () => clock,
    randomBytesImpl: (size) => Buffer.alloc(size, 0x30 + counter++)
  })
  const server = createPairingServer({
    innerServer: http.createServer((_request, response) => { response.writeHead(500); response.end() }),
    config: config(),
    machine: machine(),
    grants: pairing,
    interfaces: { eth0: [{ family: "IPv4", internal: false, address: "192.168.1.44" }] }
  })
  const base = await listen(server)
  try {
    const status = async () => (await (await fetch(`${base}/v1/pairing/grant`, { headers: authorization() })).json())
    const issue = async () => (await (await fetch(`${base}/v1/pairing/grant`, { method: "POST", headers: authorization() })).json())

    assert.deepEqual(await status(), { version: 1, claimed: false, expired: false, expiresAt: 30_000 + PAIRING_TTL_MS })
    assert.deepEqual(await status(), { version: 1, claimed: false, expired: false, expiresAt: 30_000 + PAIRING_TTL_MS })

    const claimedGrant = await issue()
    assert.equal((await claim(base, tokenFromURI(claimedGrant.links[0].uri))).status, 200)
    assert.deepEqual(await status(), { version: 1, claimed: true, expired: false, expiresAt: 30_000 + PAIRING_TTL_MS })

    const expiring = await issue()
    clock = expiring.expiresAt
    assert.deepEqual(await status(), { version: 1, claimed: false, expired: true, expiresAt: expiring.expiresAt })
    assert.equal((await claim(base, tokenFromURI(expiring.links[0].uri))).status, 410)

    clock = expiring.expiresAt + 1
    const reissued = await issue()
    assert.equal(reissued.expiresAt, expiring.expiresAt + 1 + PAIRING_TTL_MS)
    assert.equal((await claim(base, tokenFromURI(reissued.links[0].uri))).status, 200)
  } finally { await close(server) }
})

test("a loopback-only daemon answers with an explanation instead of an unreachable QR", async () => {
  const server = createPairingServer({
    innerServer: http.createServer((_request, response) => { response.writeHead(500); response.end() }),
    config: config({ host: "127.0.0.1" }),
    machine: machine(),
    grants: new MachinePairingGrants({
      now: () => 40_000,
      randomBytesImpl: (size) => Buffer.alloc(size, 0x40)
    }),
    interfaces: { eth0: [{ family: "IPv4", internal: false, address: "192.168.1.44" }] }
  })
  const base = await listen(server)
  try {
    const response = await fetch(`${base}/v1/pairing/grant`, { method: "POST", headers: authorization() })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.loopbackOnly, true)
    assert.deepEqual(body.links, [])
    assert.equal(body.expiresAt, 40_000 + PAIRING_TTL_MS)
  } finally { await close(server) }
})

test("no QR is shown when the daemon only listens on this computer", () => {
  let output = ""
  let rendered = false
  const links = announceMachinePairing(config({ host: "127.0.0.1" }), grant(), {
    write: (text) => { output += text },
    renderQR: () => { rendered = true; return "<QR>" }
  })
  assert.deepEqual(links, [])
  assert.equal(rendered, false)
  assert.match(output, /Phone pairing unavailable/)
  assert.match(output, /only accepts connections from this computer/)
})

test("no QR is shown when the computer has no network address a phone can reach", () => {
  let output = ""
  let rendered = false
  const links = announceMachinePairing(config(), grant(), {
    interfaces: { lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }] },
    write: (text) => { output += text },
    renderQR: () => { rendered = true; return "<QR>" }
  })
  assert.deepEqual(links, [])
  assert.equal(rendered, false)
  assert.match(output, /no network address a phone can reach/)
})

function manualTimer() {
  const timer = { fire: null, delay: null, unref() { this.unrefed = true } }
  return { timer, setTimer: (callback, delay) => { timer.fire = callback; timer.delay = delay; return timer } }
}

test("an expired startup QR that no phone claimed says the phone could not connect", () => {
  const pairing = grants()
  const links = [{ endpoint: "http://192.168.1.44:4097", uri: "harnessremote://pair" }]
  let output = ""
  const { timer, setTimer } = manualTimer()
  watchStartupPairing(pairing, pairing.current, links, { write: (text) => { output += text }, platform: "win32", setTimer, now: () => 1_000 })
  assert.equal(timer.delay, 1_000, "fires when the grant expires")
  assert.equal(timer.unrefed, true, "never keeps the process alive")
  timer.fire()
  assert.match(output, /No phone connected/)
  assert.match(output, /could not reach http:\/\/192\.168\.1\.44:4097/)
  assert.match(output, /--allow-firewall/)
  assert.doesNotMatch(output, /one-time-token|secret-password/)
})

test("the expiry message stays silent after a claim, a regenerated QR, or off Windows mentions no Windows fix", () => {
  const links = [{ endpoint: "http://192.168.1.44:4097", uri: "harnessremote://pair" }]
  for (const settle of [(pairing) => pairing.consume("one-time-token"), (pairing) => pairing.issue()]) {
    const pairing = grants()
    const startup = pairing.current
    let output = ""
    const { timer, setTimer } = manualTimer()
    watchStartupPairing(pairing, startup, links, { write: (text) => { output += text }, setTimer, now: () => 1_000 })
    settle(pairing)
    timer.fire()
    assert.equal(output, "")
  }
  const pairing = grants()
  let output = ""
  const { timer, setTimer } = manualTimer()
  watchStartupPairing(pairing, pairing.current, links, { write: (text) => { output += text }, platform: "linux", setTimer, now: () => 1_000 })
  timer.fire()
  assert.match(output, /No phone connected/)
  assert.doesNotMatch(output, /--allow-firewall/)
  assert.equal(watchStartupPairing(pairing, pairing.current, [], { setTimer }), null, "nothing to watch without a QR")
})

test("a successful claim reports the phone that connected", async () => {
  const innerServer = http.createServer((_request, response) => { response.writeHead(500); response.end() })
  const claims = []
  const server = createPairingServer({ innerServer, config: config(), machine: machine(), grants: grants(), onClaim: (event) => claims.push(event) })
  const base = await listen(server)
  try {
    assert.equal((await claim(base, "wrong-token")).status, 401)
    assert.deepEqual(claims, [], "a rejected claim is not a connected phone")
    assert.equal((await claim(base)).status, 200)
    assert.deepEqual(claims, [{ remoteAddress: "127.0.0.1" }])
  } finally { await close(server) }
})
