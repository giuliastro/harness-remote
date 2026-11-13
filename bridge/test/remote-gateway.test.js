import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import http from "node:http"
import { once } from "node:events"
import { test } from "node:test"
import { PairedDeviceRegistry } from "../src/paired-device-registry.js"
import { OneTimePairingGrant } from "../src/pairing-server.js"
import { createRemoteGatewayServer } from "../src/remote-gateway.js"
import { RemoteRequestAuthenticator, REMOTE_AUTH_HEADERS, remoteRequestMessage } from "../src/remote-request-auth.js"

async function listen(server) {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return server.address().port
}

async function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path, headers }, (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => { body += chunk })
      response.on("end", () => resolve({ status: response.statusCode, body }))
    }).on("error", reject)
  })
}

async function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path, method: "POST",
      headers: { "content-type": "application/json" } }, (response) => {
      let text = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => { text += chunk })
      response.on("end", () => resolve({ status: response.statusCode, body: text }))
    })
    request.on("error", reject)
    request.end(JSON.stringify(body))
  })
}

test("signed HTTPS ingress forwards only verified requests and injects local credentials", async () => {
  const upstream = http.createServer((request, response) => {
    if (request.headers.authorization !== `Basic ${Buffer.from("user:secret").toString("base64")}`) {
      response.writeHead(401).end()
      return
    }
    if (request.headers[REMOTE_AUTH_HEADERS.signature] || request.headers.cookie) {
      response.writeHead(500).end()
      return
    }
    response.writeHead(200).end(request.url)
  })
  const upstreamPort = await listen(upstream)
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const der = publicKey.export({ format: "der", type: "spki" })
  const deviceID = createHash("sha256").update(der).digest("base64url")
  const registry = new PairedDeviceRegistry({ store: {
    read: async () => null, write: async () => {}, serial: async (operation) => operation()
  } })
  await registry.load()
  await registry.pair({ publicKey: der.toString("base64url"), name: "Phone" })
  const machineID = "machine-123"
  const pin = "a".repeat(64)
  const timestamp = 1_900_000_000_000
  const authenticator = new RemoteRequestAuthenticator({ registry, machineID, pin, now: () => timestamp })
  const grants = new OneTimePairingGrant({ token: "once", expiresAt: timestamp + 60_000, now: () => timestamp })
  // HTTP is injected solely to exercise ingress routing; the production factory uses HTTPS.
  const gateway = createRemoteGatewayServer({
    tls: { key: "test", cert: "test" }, authenticator, upstreamPort,
    username: "user", password: "secret", createServer: (_tls, handler) => http.createServer(handler),
    pairing: { grants, registry, machineID }
  })
  const port = await listen(gateway)
  try {
    assert.equal((await get(port, "/v1/machine")).status, 401)
    assert.equal((await post(port, "/v1/remote/pair", { token: "wrong", publicKey: der.toString("base64url"), name: "Phone" })).status, 401)
    const paired = await post(port, "/v1/remote/pair", { token: "once", publicKey: der.toString("base64url"), name: "Phone" })
    assert.equal(paired.status, 200)
    assert.equal(JSON.parse(paired.body).deviceID, deviceID)
    assert.equal((await post(port, "/v1/remote/pair", { token: "once", publicKey: der.toString("base64url"), name: "Phone" })).status, 409)
    const nonce = "b".repeat(43)
    const message = remoteRequestMessage({ machineID, pin, deviceID, timestamp, nonce,
      method: "GET", target: "/v1/machine", body: Buffer.alloc(0) })
    const headers = {
      [REMOTE_AUTH_HEADERS.device]: deviceID,
      [REMOTE_AUTH_HEADERS.timestamp]: String(timestamp),
      [REMOTE_AUTH_HEADERS.nonce]: nonce,
      [REMOTE_AUTH_HEADERS.signature]: sign("sha256", Buffer.from(message), privateKey).toString("base64url"),
      cookie: "private=must-not-forward",
      authorization: "Basic attacker"
    }
    assert.deepEqual(await get(port, "/v1/machine", headers), { status: 200, body: "/v1/machine" })
    assert.equal((await get(port, "/v1/machine", headers)).status, 401)
    await registry.revoke(deviceID)
    headers[REMOTE_AUTH_HEADERS.nonce] = "c".repeat(43)
    assert.equal((await get(port, "/v1/machine", headers)).status, 401)
  } finally {
    gateway.close()
    upstream.close()
  }
})
