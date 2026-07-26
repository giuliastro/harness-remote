import assert from "node:assert/strict"
import test from "node:test"
import { homedir } from "node:os"
import path from "node:path"
import { parseConfig } from "../src/config.js"
import { harnessProfile } from "../src/harness-profiles.js"

test("defaults to a loopback-only unauthenticated listener", () => {
  assert.deepEqual(parseConfig([], {}), {
    host: "127.0.0.1",
    port: 4097,
    username: "",
    password: "",
    harness: "omp",
    agentBin: "omp",
    piBin: "pi",
    agentArgs: [],
    roots: [],
    corsOrigins: [],
    logRequests: false,
    stateDirectory: path.join(homedir(), ".harness-remote")
  })
})

test("shares the bridge with browser origins only when asked", () => {
  assert.deepEqual(parseConfig([], {}).corsOrigins, [])
  const config = parseConfig(["--cors", "http://localhost:5173", "--cors", "http://192.168.1.64:5199"], {})
  assert.deepEqual(config.corsOrigins, ["http://localhost:5173", "http://192.168.1.64:5199"])
  assert.deepEqual(parseConfig([], { HARNESS_REMOTE_CORS: "http://localhost:5173" }).corsOrigins, ["http://localhost:5173"])
})

test("requires credentials outside loopback", () => {
  assert.throws(() => parseConfig(["--host", "0.0.0.0"], {}), /required when binding beyond loopback/)
})

test("accepts authenticated LAN configuration and repeated roots", () => {
  const config = parseConfig([
    "--host", "0.0.0.0",
    "--port", "4900",
    "--username", "omp",
    "--password", "secret",
    "--root", "/work/a",
    "--root", "/work/b"
  ], {})
  assert.equal(config.port, 4900)
  assert.deepEqual(config.roots, ["/work/a", "/work/b"])
})

test("enables safe request diagnostics explicitly", () => {
  assert.equal(parseConfig(["--log-requests"], {}).logRequests, true)
  assert.equal(parseConfig([], { HARNESS_REMOTE_LOG_REQUESTS: "1" }).logRequests, true)
})

test("selects the PI profile and allows executable overrides", () => {
  const config = parseConfig(["--harness", "pi", "--agent-bin", "/usr/local/bin/pi-acp", "--agent-arg", "--quiet", "--pi-bin", "/opt/pi/bin/pi"], {})
  assert.equal(config.harness, "pi")
  assert.equal(config.agentBin, "/usr/local/bin/pi-acp")
  assert.equal(config.piBin, "/opt/pi/bin/pi")
  assert.deepEqual(config.agentArgs, ["--quiet"])
})

test("allows session snapshot storage to be relocated", () => {
  assert.equal(parseConfig(["--state-dir", "/var/lib/harness-remote"], {}).stateDirectory, "/var/lib/harness-remote")
  assert.equal(parseConfig([], { HARNESS_REMOTE_STATE_DIR: "/tmp/harness-state" }).stateDirectory, "/tmp/harness-state")
})

test("local OMP and PI profiles allow ACP tool permission requests", () => {
  assert.equal(harnessProfile("omp").permissionMode, "allow")
  assert.equal(harnessProfile("pi").permissionMode, "allow")
})
