import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { bridgeEnvironment, buildBridgeArgs, createManagedShutdown, detectBackends, lanAddresses, resolveBackend, startManagedOpenCode } from "../src/launcher.js"

test("detects executable agent files on PATH without running them", () => {
  const pathValue = ["/bin", "/tools"].join(path.delimiter)
  const existing = new Set([path.join("/tools", "codex")])
  assert.deepEqual(detectBackends({
    pathValue,
    platform: "linux",
    exists: (candidate) => existing.has(candidate),
    access: () => {}
  }), ["codex"])
})

test("ignores non-executable PATH entries on Unix", () => {
  const candidate = path.join("/tools", "claude")
  assert.deepEqual(detectBackends({
    pathValue: "/tools",
    platform: "linux",
    exists: (value) => value === candidate,
    access: () => { throw new Error("not executable") }
  }), [])
})

test("detects OpenCode as a managed direct-HTTP backend", () => {
  const candidate = path.join("/tools", "opencode")
  assert.deepEqual(detectBackends({
    pathValue: "/tools",
    platform: "linux",
    exists: (value) => value === candidate,
    access: () => {}
  }), ["opencode"])
  assert.equal(resolveBackend([], ["opencode"]), "opencode")
})

test("delegates OpenCode startup to the managed host", async () => {
  let options
  class FakeHost {
    constructor(value) { options = value }
    async start() { this.started = true }
  }
  const managed = await startManagedOpenCode({
    host: "0.0.0.0",
    port: 4096,
    username: "harness",
    password: "secret",
    command: "/tools/opencode",
    Host: FakeHost
  })
  assert.equal(managed.started, true)
  assert.deepEqual(options, {
    command: "/tools/opencode",
    host: "0.0.0.0",
    port: 4096,
    username: "harness",
    password: "secret"
  })
})

test("escalates a second shutdown signal from SIGTERM to SIGKILL", () => {
  const signals = []
  const exits = []
  const processObject = {
    exitCode: 0,
    exit(code) { exits.push(code) }
  }
  const shutdown = createManagedShutdown({ stop: (signal) => signals.push(signal) }, processObject)

  shutdown("SIGINT")
  assert.equal(processObject.exitCode, 130)
  assert.deepEqual(signals, ["SIGTERM"])
  assert.deepEqual(exits, [])

  shutdown("SIGINT")
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
  assert.deepEqual(exits, [130])
})

test("uses an explicit backend even when discovery is empty", () => {
  assert.equal(resolveBackend(["--backend", "claude"], []), "claude")
})

test("auto-selects exactly one detected backend", () => {
  assert.equal(resolveBackend([], ["omp"]), "omp")
})

test("requires an explicit choice when multiple backends are detected", () => {
  assert.throws(() => resolveBackend([], ["codex", "claude"]), /Multiple supported agent CLIs were found on PATH/)
})

test("requires an installed or explicit backend when discovery finds none", () => {
  assert.throws(() => resolveBackend([], []), /No supported agent CLI was found on PATH/)
})

test("injects quick-start defaults but never places credentials on child argv", () => {
  const argv = buildBridgeArgs([
    "--root", "/work",
    "--username", "harness",
    "--password", "secret"
  ], {
    backend: "codex",
    host: "0.0.0.0",
    port: 4098
  })
  assert.deepEqual(argv, [
    "--root", "/work",
    "--backend", "codex",
    "--host", "0.0.0.0",
    "--port", "4098"
  ])
  assert.equal(argv.includes("secret"), false)

  const environment = bridgeEnvironment({ PATH: "/bin" }, "harness", "secret")
  assert.equal(environment.HARNESS_REMOTE_USERNAME, "harness")
  assert.equal(environment.HARNESS_REMOTE_PASSWORD, "secret")
  assert.equal(environment.PATH, "/bin")
})

test("does not override explicit backend, host, or port", () => {
  const explicit = ["--backend", "pi", "--host", "127.0.0.1", "--port", "5000"]
  assert.deepEqual(buildBridgeArgs(explicit, {
    backend: "codex",
    host: "0.0.0.0",
    port: 4098
  }), explicit)
})

test("prefers physical LAN addresses over obvious virtual interfaces", () => {
  assert.deepEqual(lanAddresses({
    docker0: [{ family: "IPv4", internal: false, address: "172.17.0.1" }],
    wlan0: [{ family: "IPv4", internal: false, address: "192.168.1.42" }],
    lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }]
  }), ["192.168.1.42"])
})

test("falls back to virtual candidates when no physical-looking address exists", () => {
  assert.deepEqual(lanAddresses({
    docker0: [{ family: "IPv4", internal: false, address: "172.17.0.1" }]
  }), ["172.17.0.1"])
})
