import assert from "node:assert/strict"
import test from "node:test"
import { parseConfig } from "../src/config.js"

test("defaults to a loopback-only unauthenticated listener", () => {
  assert.deepEqual(parseConfig([], {}), {
    backend: "omp",
    host: "127.0.0.1",
    port: 4097,
    username: "",
    password: "",
    acpCommand: "omp",
    acpArgs: ["acp"],
    roots: [],
    corsOrigins: [],
    logRequests: false
  })
})

test("configures a non-OMP ACP adapter command and arguments", () => {
  assert.deepEqual(parseConfig([
    "--acp-command", "npx",
    "--acp-arg", "-y",
    "--acp-arg", "@victor-software-house/pi-acp"
  ], {}).acpCommand, "npx")
  assert.deepEqual(parseConfig([
    "--acp-command", "npx",
    "--acp-arg", "-y",
    "--acp-arg", "@victor-software-house/pi-acp"
  ], {}).acpArgs, ["-y", "@victor-software-house/pi-acp"])
  assert.deepEqual(parseConfig([], {
    OMP_BRIDGE_ACP_COMMAND: "pi-acp",
    OMP_BRIDGE_ACP_ARGS: "[]"
  }).acpArgs, [])
})

test("selects PI defaults for the ACP backend", () => {
  assert.deepEqual(parseConfig(["--backend", "pi"], {}).backend, "pi")
  assert.equal(parseConfig(["--backend", "pi"], {}).acpCommand, process.platform === "win32" ? "npx.cmd" : "npx")
  assert.deepEqual(parseConfig(["--backend", "pi"], {}).acpArgs, ["-y", "@victor-software-house/pi-acp"])
  assert.deepEqual(parseConfig([], { OMP_BRIDGE_BACKEND: "pi" }).acpArgs, ["-y", "@victor-software-house/pi-acp"])
})

test("prefers generic environment names while retaining OMP aliases", () => {
  const generic = parseConfig([], {
    HARNESS_REMOTE_BACKEND: "pi",
    HARNESS_REMOTE_HOST: "localhost",
    HARNESS_REMOTE_PORT: "4901",
    HARNESS_REMOTE_ACP_COMMAND: "custom-pi",
    HARNESS_REMOTE_ACP_ARGS: "[\"serve\"]",
    OMP_BRIDGE_BACKEND: "omp",
    OMP_BRIDGE_PORT: "4902"
  })
  assert.equal(generic.backend, "pi")
  assert.equal(generic.host, "localhost")
  assert.equal(generic.port, 4901)
  assert.equal(generic.acpCommand, "custom-pi")
  assert.deepEqual(generic.acpArgs, ["serve"])

  const legacy = parseConfig([], {
    OMP_BRIDGE_BACKEND: "pi",
    OMP_BRIDGE_HOST: "localhost",
    OMP_BRIDGE_PORT: "4902"
  })
  assert.equal(legacy.backend, "pi")
  assert.equal(legacy.host, "localhost")
  assert.equal(legacy.port, 4902)
})

test("shares the bridge with browser origins only when asked", () => {
  assert.deepEqual(parseConfig([], {}).corsOrigins, [])
  const config = parseConfig(["--cors", "http://localhost:5173", "--cors", "http://192.168.1.64:5199"], {})
  assert.deepEqual(config.corsOrigins, ["http://localhost:5173", "http://192.168.1.64:5199"])
  assert.deepEqual(parseConfig([], { OMP_BRIDGE_CORS: "http://localhost:5173" }).corsOrigins, ["http://localhost:5173"])
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
  assert.equal(parseConfig([], { OMP_BRIDGE_LOG_REQUESTS: "1" }).logRequests, true)
})
