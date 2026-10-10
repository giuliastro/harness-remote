import assert from "node:assert/strict"
import test from "node:test"
import { AcpClient } from "../src/acp-client.js"
import { withoutGatewayCredentials } from "../src/child-environment.js"
import { ManagedOpenCodeHost } from "../src/opencode-host.js"

const gatewayEnvironment = {
  PATH: "/usr/bin",
  HOME: "/home/agent",
  HARNESS_REMOTE_USERNAME: "harness",
  HARNESS_REMOTE_PASSWORD: "gateway-secret",
  OMP_BRIDGE_USERNAME: "legacy",
  harness_remote_password: "lower-case-secret",
  HARNESS_REMOTE_ROOT: "/repos"
}

function captureSpawnOptions() {
  const captured = {}
  const spawnProcess = (command, args, options) => {
    captured.options = options
    throw new Error("spawn captured")
  }
  return { captured, spawnProcess }
}

test("removes gateway credentials case-insensitively and keeps everything else", () => {
  assert.deepEqual(withoutGatewayCredentials(gatewayEnvironment), {
    PATH: "/usr/bin",
    HOME: "/home/agent",
    HARNESS_REMOTE_ROOT: "/repos"
  })
})

test("ACP adapters start without the gateway credentials", async () => {
  const { captured, spawnProcess } = captureSpawnOptions()
  const client = new AcpClient({ command: "claude-agent-acp", args: [], spawnProcess, environment: gatewayEnvironment })

  await assert.rejects(client.start(), /spawn captured/)

  assert.equal(captured.options.env.PATH, "/usr/bin")
  assert.equal(captured.options.env.HARNESS_REMOTE_PASSWORD, undefined)
  assert.equal(captured.options.env.HARNESS_REMOTE_USERNAME, undefined)
  assert.equal(captured.options.env.harness_remote_password, undefined)
})

test("managed OpenCode keeps its own server credentials but not the gateway variables", async () => {
  const { captured, spawnProcess } = captureSpawnOptions()
  const host = new ManagedOpenCodeHost({
    username: "harness",
    password: "gateway-secret",
    environment: gatewayEnvironment,
    spawnProcess,
    platform: "linux",
    isolatePosixProcessTree: false
  })

  await assert.rejects(host.start(), /spawn captured/)

  assert.equal(captured.options.env.OPENCODE_SERVER_USERNAME, "harness")
  assert.equal(captured.options.env.OPENCODE_SERVER_PASSWORD, "gateway-secret")
  assert.equal(captured.options.env.HARNESS_REMOTE_PASSWORD, undefined)
  assert.equal(captured.options.env.OMP_BRIDGE_USERNAME, undefined)
})
