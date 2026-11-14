import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import http from "node:http"
import https from "node:https"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { PairedDeviceRegistry } from "../src/paired-device-registry.js"
import { OneTimePairingGrant } from "../src/pairing-server.js"
import { createRemoteGatewayServer } from "../src/remote-gateway.js"
import { RemoteRequestAuthenticator, REMOTE_AUTH_HEADERS, remoteRequestMessage } from "../src/remote-request-auth.js"
import { loadTlsMachineIdentity } from "../src/tls-machine-identity.js"

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
    if (request.url === "/v1/events") {
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write("data: ready\n\n")
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
    const streamNonce = "e".repeat(43)
    const streamMessage = remoteRequestMessage({ machineID, pin, deviceID, timestamp,
      nonce: streamNonce, method: "GET", target: "/v1/events", body: Buffer.alloc(0) })
    const streamHeaders = {
      ...headers,
      [REMOTE_AUTH_HEADERS.nonce]: streamNonce,
      [REMOTE_AUTH_HEADERS.signature]: sign("sha256", Buffer.from(streamMessage), privateKey).toString("base64url")
    }
    let firstEvent
    const firstEventSeen = new Promise((resolve) => { firstEvent = resolve })
    let streamClosed
    const closed = new Promise((resolve) => { streamClosed = resolve })
    const streamRequest = http.get({ hostname: "127.0.0.1", port, path: "/v1/events", headers: streamHeaders }, (stream) => {
      stream.once("data", firstEvent)
      stream.once("close", streamClosed)
    })
    await firstEventSeen
    await registry.revoke(deviceID)
    let closeTimeout
    try {
      await Promise.race([closed, new Promise((_resolve, reject) => {
        closeTimeout = setTimeout(() => reject(new Error("Revoked SSE stream remained open")), 2_500)
      })])
    } finally {
      clearTimeout(closeTimeout)
    }
    streamRequest.destroy()
    headers[REMOTE_AUTH_HEADERS.nonce] = "c".repeat(43)
    assert.equal((await get(port, "/v1/machine", headers)).status, 401)
  } finally {
    gateway.close()
    upstream.close()
  }
})

test("real HTTPS ingress serves only on its pinned TLS machine identity", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "hr-remote-gateway-tls-"))
  const machineID = "machine-tls-test"
  const identity = await loadTlsMachineIdentity(stateDirectory, machineID)
  const upstream = http.createServer((_request, response) => response.writeHead(200).end("machine"))
  const upstreamPort = await listen(upstream)
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const der = publicKey.export({ format: "der", type: "spki" })
  const deviceID = createHash("sha256").update(der).digest("base64url")
  const registry = new PairedDeviceRegistry({ store: {
    read: async () => null, write: async () => {}, serial: async (operation) => operation()
  } })
  await registry.load()
  await registry.pair({ publicKey: der.toString("base64url"), name: "Phone" })
  const authenticator = new RemoteRequestAuthenticator({ registry, machineID, pin: identity.spkiSha256 })
  const gateway = createRemoteGatewayServer({
    tls: { key: identity.privateKey, cert: identity.certificate }, authenticator, upstreamPort
  })
  const port = await listen(gateway)
  try {
    const timestamp = Date.now()
    const nonce = "d".repeat(43)
    const target = "/v1/machine"
    const message = remoteRequestMessage({ machineID, pin: identity.spkiSha256,
      deviceID, timestamp, nonce, method: "GET", target, body: Buffer.alloc(0) })
    const headers = {
      [REMOTE_AUTH_HEADERS.device]: deviceID,
      [REMOTE_AUTH_HEADERS.timestamp]: String(timestamp),
      [REMOTE_AUTH_HEADERS.nonce]: nonce,
      [REMOTE_AUTH_HEADERS.signature]: sign("sha256", Buffer.from(message), privateKey).toString("base64url")
    }
    const response = await new Promise((resolve, reject) => {
      https.get({ hostname: "127.0.0.1", port, path: target, headers,
        ca: identity.certificate, servername: identity.dnsName }, (incoming) => {
        let body = ""
        incoming.setEncoding("utf8")
        incoming.on("data", (chunk) => { body += chunk })
        incoming.on("end", () => resolve({ status: incoming.statusCode, body }))
      }).on("error", reject)
    })
    assert.deepEqual(response, { status: 200, body: "machine" })
    await assert.rejects(new Promise((resolve, reject) => {
      https.get({ hostname: "127.0.0.1", port, path: target, headers,
        ca: identity.certificate, servername: "other.machine.harness-remote.invalid" }, resolve).on("error", reject)
    }), /certificate|hostname|altname/i)
  } finally {
    gateway.close()
    upstream.close()
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("a device receives confirmation when it revokes its own key", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const der = publicKey.export({ format: "der", type: "spki" })
  const registry = new PairedDeviceRegistry({ store: {
    read: async () => null, write: async () => {}, serial: async (operation) => operation()
  } })
  await registry.load()
  const deviceID = await registry.pair({ publicKey: der.toString("base64url"), name: "Phone" })
  const target = `/v1/remote/devices/${deviceID}`
  const upstream = http.createServer(async (request, response) => {
    if (request.method === "DELETE" && request.url === target) {
      await registry.revoke(deviceID)
      response.writeHead(200, { "content-type": "application/json" }).end('{"revoked":true}')
      return
    }
    response.writeHead(404).end()
  })
  const upstreamPort = await listen(upstream)
  const machineID = "machine-self-revoke"
  const pin = "a".repeat(64)
  const authenticator = new RemoteRequestAuthenticator({ registry, machineID, pin })
  const gateway = createRemoteGatewayServer({ tls: { key: "test", cert: "test" },
    authenticator, upstreamPort, createServer: (_tls, handler) => http.createServer(handler) })
  const port = await listen(gateway)
  try {
    const timestamp = Date.now()
    const nonce = "s".repeat(43)
    const message = remoteRequestMessage({ machineID, pin, deviceID, timestamp, nonce,
      method: "DELETE", target, body: Buffer.alloc(0) })
    const headers = {
      [REMOTE_AUTH_HEADERS.device]: deviceID,
      [REMOTE_AUTH_HEADERS.timestamp]: String(timestamp),
      [REMOTE_AUTH_HEADERS.nonce]: nonce,
      [REMOTE_AUTH_HEADERS.signature]: sign("sha256", Buffer.from(message), privateKey).toString("base64url")
    }
    const result = await new Promise((resolve, reject) => {
      http.request({ hostname: "127.0.0.1", port, path: target, method: "DELETE", headers }, (response) => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk) => { body += chunk })
        response.on("end", () => resolve({ status: response.statusCode, body }))
      }).on("error", reject).end()
    })
    assert.deepEqual(result, { status: 200, body: '{"revoked":true}' })
    const nextNonce = "t".repeat(43)
    const nextMessage = remoteRequestMessage({ machineID, pin, deviceID, timestamp,
      nonce: nextNonce, method: "GET", target, body: Buffer.alloc(0) })
    assert.equal((await get(port, target, {
      ...headers,
      [REMOTE_AUTH_HEADERS.nonce]: nextNonce,
      [REMOTE_AUTH_HEADERS.signature]: sign("sha256", Buffer.from(nextMessage), privateKey).toString("base64url")
    })).status, 401)
  } finally {
    gateway.close()
    upstream.close()
  }
})
