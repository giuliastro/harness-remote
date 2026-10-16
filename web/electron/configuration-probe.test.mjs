import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"

const { executeConfigurationProbe } = await import("../dist-electron/electron/configuration-probe.js")

test("unsaved configuration probes inspect only machine metadata with a validated connection", async () => {
  const requests = []
  const server = createServer((request, response) => {
    requests.push({ path: request.url, method: request.method, authorization: request.headers.authorization })
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify(request.url === "/v1/machine" ? { machine: { id: "test" }, agents: [] } : { projects: [] }))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const profile = { id: "unsaved", backend: "codex", agentId: "codex", host: "127.0.0.1", port: server.address().port, username: "probe", password: "test" }
  try {
    for (const path of ["/v1/machine", "/v1/projects"]) {
      const result = await executeConfigurationProbe(profile, path)
      assert.equal(result.ok, true)
    }
    assert.deepEqual(requests.map(({ path, method }) => ({ path, method })), [
      { path: "/v1/machine", method: "GET" },
      { path: "/v1/projects", method: "GET" }
    ])
    assert.equal(requests[0].authorization, `Basic ${Buffer.from("probe:test").toString("base64")}`)

    for (const path of ["/session", "/v1/tasks", "/v1/agents/codex/models", "/v1/machine?path=anything", { path: "/v1/machine", method: "POST" }]) {
      assert.equal((await executeConfigurationProbe(profile, path)).ok, false)
    }
    assert.equal((await executeConfigurationProbe({ ...profile, host: "file:///tmp/private" }, "/v1/machine")).ok, false)
    assert.equal((await executeConfigurationProbe({ ...profile, host: "http://user:password@localhost" }, "/v1/machine")).ok, false)
    const invalidItalian = await executeConfigurationProbe({ ...profile, host: "file:///tmp/private" }, "/v1/machine", "it")
    const { createTranslator } = await import("../dist-electron/src/i18n.js")
    assert.equal(invalidItalian.error.message, createTranslator("it")("machine.connectionInvalid"))
    assert.equal(requests.length, 2, "invalid probes must not reach the network")
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
