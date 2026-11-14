import assert from "node:assert/strict"
import test from "node:test"
import { createRemoteDeviceManagementServer } from "../src/remote-device-management-server.js"

function config() { return { username: "harness", password: "secret", corsOrigins: [] } }
function authorization() { return `Basic ${Buffer.from("harness:secret").toString("base64")}` }
function createRequestHandler(options) {
  let handler
  const server = createRemoteDeviceManagementServer({ ...options, createServer: (requestHandler) => { handler = requestHandler; return requestHandler } })
  assert.equal(typeof server, "function")
  return async (url, { method = "GET", headers = {} } = {}) => {
    const response = {
      headers: {}, status: undefined, body: "", headersSent: false, writableEnded: false,
      setHeader(name, value) { this.headers[name] = value },
      writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); this.headersSent = true },
      end(body = "") { this.body = body; this.writableEnded = true }
    }
    const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
    const request = { method, url, headers: { host: "localhost", ...normalizedHeaders } }
    await handler(request, response)
    return { status: response.status, headers: response.headers, body: response.body, json: () => JSON.parse(response.body) }
  }
}

test("device list requires daemon authentication and omits public keys", async () => {
  const id = "a".repeat(43)
  const registry = { list: () => [{ id, name: "phone", publicKey: "sensitive", pairedAt: "2026-01-01T00:00:00.000Z", revokedAt: null }],
    async revoke() { throw new Error("must not revoke") } }
  let delegated = 0
  const innerServer = { emit() { delegated += 1 } }
  const request = createRequestHandler({ innerServer, config: config(), registry })
  assert.equal((await request("/v1/remote/devices")).status, 401)
  const response = await request("/v1/remote/devices", { headers: { Authorization: authorization() } })
  assert.equal(response.status, 200)
  assert.deepEqual(response.json(), { devices: [{ id, name: "phone", pairedAt: "2026-01-01T00:00:00.000Z", revokedAt: null }] })
  assert.equal(delegated, 0)
})

test("device revocation is authenticated, validates IDs, and reports unknown devices", async () => {
  const id = "b".repeat(43)
  const revoked = []
  const registry = { list: () => [], async revoke(value) { revoked.push(value); return value === id } }
  const innerServer = { emit() { assert.fail("device route must not delegate") } }
  const request = createRequestHandler({ innerServer, config: config(), registry })
  assert.equal((await request(`/v1/remote/devices/${id}`, { method: "DELETE" })).status, 401)
  const success = await request(`/v1/remote/devices/${id}`, { method: "DELETE", headers: { Authorization: authorization() } })
  assert.equal(success.status, 200)
  assert.deepEqual(success.json(), { revoked: true })
  const unknown = await request(`/v1/remote/devices/${"c".repeat(43)}`, { method: "DELETE", headers: { Authorization: authorization() } })
  assert.equal(unknown.status, 404)
  const invalid = await request("/v1/remote/devices/invalid", { method: "DELETE", headers: { Authorization: authorization() } })
  assert.equal(invalid.status, 400)
  assert.deepEqual(revoked, [id, "c".repeat(43)])
})

test("unsupported device methods fail closed and unrelated requests are delegated", async () => {
  let delegated = 0
  const registry = { list: () => [], async revoke() { throw new Error("must not revoke") } }
  const innerServer = { emit(_event, _request, response) { delegated += 1; response.writeHead(204); response.end() } }
  const request = createRequestHandler({ innerServer, config: config(), registry })
  const headers = { Authorization: authorization() }
  assert.equal((await request("/v1/remote/devices", { method: "POST", headers })).status, 405)
  assert.equal((await request(`/v1/remote/devices/${"d".repeat(43)}`, { method: "POST", headers })).status, 405)
  assert.equal(delegated, 0)
  assert.equal((await request("/v1/machine")).status, 204)
  assert.equal(delegated, 1)
})
