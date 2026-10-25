import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import { createPluginServer } from "../src/plugins/plugin-server.js"

function config() {
  return { username: "harness", password: "secret", corsOrigins: [] }
}

function authorization() {
  return `Basic ${Buffer.from("harness:secret").toString("base64")}`
}

function plugin(overrides = {}) {
  return {
    id: "token-harness",
    name: "Token Harness",
    version: "1.0.0",
    description: "Allowance and routing",
    icon: "token-harness",
    builtIn: true,
    enabled: true,
    ready: true,
    state: "active",
    dependency: { state: "external", name: "token-harness", version: "0.1.34" },
    actions: {
      install: { available: false },
      update: { available: false },
      uninstall: { available: false }
    },
    contributions: {},
    settings: null,
    diagnostics: [],
    checkedAt: "2026-10-25T12:00:00.000Z",
    ...overrides
  }
}

function fakeHost() {
  const calls = []
  return {
    calls,
    async list(options) {
      calls.push(["list", options])
      return { plugins: [plugin()], generatedAt: "2026-10-25T12:00:00.000Z" }
    },
    async detail(id, options) {
      calls.push(["detail", id, options])
      return plugin({ id })
    },
    async install(id) { calls.push(["install", id]); return { plugin: plugin(), message: "installed" } },
    async update(id) { calls.push(["update", id]); return { plugin: plugin(), message: "updated" } },
    async uninstall(id) { calls.push(["uninstall", id]); return { plugin: plugin({ enabled: false }), message: "removed" } },
    async enable(id) { calls.push(["enable", id]); return { plugin: plugin(), message: "enabled" } },
    async disable(id) { calls.push(["disable", id]); return { plugin: plugin({ enabled: false, state: "disabled" }), message: "disabled" } },
    async configure(id, values) { calls.push(["configure", id, values]); return { ok: true, message: "saved" } },
    async runAction(id, actionID, params) { calls.push(["runAction", id, actionID, params]); return { ok: true, message: "opened" } }
  }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${server.address().port}`
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

test("plugin control plane is authenticated, routes lifecycle actions and preserves unrelated traffic", async () => {
  let delegated = 0
  const innerServer = http.createServer((request, response) => {
    delegated += 1
    assert.equal(request.url, "/v1/machine")
    response.writeHead(204)
    response.end()
  })
  const host = fakeHost()
  const server = createPluginServer({ innerServer, config: config(), pluginHost: host })
  const base = await listen(server)
  try {
    assert.equal((await fetch(`${base}/v1/plugins`)).status, 401)

    const listed = await fetch(`${base}/v1/plugins?refresh=1`, { headers: { Authorization: authorization() } })
    assert.equal(listed.status, 200)
    assert.equal((await listed.json()).plugins[0].id, "token-harness")
    assert.deepEqual(host.calls[0], ["list", { refresh: true }])

    const detail = await fetch(`${base}/v1/plugins/token-harness`, { headers: { Authorization: authorization() } })
    assert.equal(detail.status, 200)
    assert.equal((await detail.json()).plugin.id, "token-harness")

    const installed = await fetch(`${base}/v1/plugins/token-harness/install`, { method: "POST", headers: { Authorization: authorization() } })
    assert.equal(installed.status, 200)
    assert.equal((await installed.json()).message, "installed")

    const configured = await fetch(`${base}/v1/plugins/token-harness/settings`, {
      method: "PATCH",
      headers: { Authorization: authorization(), "Content-Type": "application/json" },
      body: JSON.stringify({ values: { window: "30d", "routing.claude": true } })
    })
    assert.equal(configured.status, 200)
    assert.deepEqual(host.calls.find((call) => call[0] === "configure"), ["configure", "token-harness", { window: "30d", "routing.claude": true }])

    const opened = await fetch(`${base}/v1/plugins/token-harness/actions/open`, {
      method: "POST",
      headers: { Authorization: authorization(), "Content-Type": "application/json" },
      body: "{}"
    })
    assert.equal(opened.status, 200)
    assert.equal((await opened.json()).message, "opened")
    assert.deepEqual(host.calls.find((call) => call[0] === "runAction"), ["runAction", "token-harness", "open", {}])

    const machine = await fetch(`${base}/v1/machine`)
    assert.equal(machine.status, 204)
    assert.equal(delegated, 1)
  } finally {
    await close(server)
  }
})

test("plugin control plane rejects unknown actions and malformed settings without touching the inner stack", async () => {
  const innerServer = http.createServer((_request, response) => { response.writeHead(418); response.end() })
  const host = fakeHost()
  host.detail = async () => { throw Object.assign(new Error("Unknown plugin: nope"), { code: "unknown_plugin" }) }
  const server = createPluginServer({ innerServer, config: config(), pluginHost: host })
  const base = await listen(server)
  try {
    const missing = await fetch(`${base}/v1/plugins/nope`, { headers: { Authorization: authorization() } })
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).code, "unknown_plugin")

    const badSettings = await fetch(`${base}/v1/plugins/token-harness/settings`, {
      method: "PATCH",
      headers: { Authorization: authorization(), "Content-Type": "application/json" },
      body: JSON.stringify({ nope: true })
    })
    assert.equal(badSettings.status, 400)

    const wrongMethod = await fetch(`${base}/v1/plugins/token-harness/install`, { headers: { Authorization: authorization() } })
    assert.equal(wrongMethod.status, 405)
  } finally {
    await close(server)
  }
})
