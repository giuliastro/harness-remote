import assert from "node:assert/strict"
import { createServer } from "node:http"
import { after, test } from "node:test"

const { executeDesktopRequest } = await import("../dist-electron/electron/request-transport.js")

const seen = []
const server = createServer((request, response) => {
  seen.push({ url: request.url, backend: request.headers["x-harness-backend"] ?? null })
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify({ ok: true }))
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const port = server.address().port

const profile = {
  id: "project-metadata-scope",
  backend: "opencode",
  agentId: "opencode",
  host: "127.0.0.1",
  port,
  username: "",
  password: ""
}

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

test("Project identity and outcome stay on the machine daemon instead of the selected agent", async () => {
  for (const path of [
    "/v1/project-identity?projectId=project-1",
    "/v1/project-outcome?projectId=project-1"
  ]) {
    const result = await executeDesktopRequest(profile, { path })
    assert.equal(result.ok, true)
  }

  assert.deepEqual(seen, [
    { url: "/v1/project-identity?projectId=project-1", backend: null },
    { url: "/v1/project-outcome?projectId=project-1", backend: null }
  ])
})
