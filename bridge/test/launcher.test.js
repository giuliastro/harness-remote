import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { bridgeEnvironment, buildBridgeArgs, detectBackends, lanAddresses, resolveBackend } from "../src/launcher.js"

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

test("detects OpenCode so its direct HTTP path can be explained", () => {
  const candidate = path.join("/tools", "opencode")
  assert.deepEqual(detectBackends({
    pathValue: "/tools",
    platform: "linux",
    exists: (value) => value === candidate,
    access: () => {}
  }), ["opencode"])
  assert.equal(resolveBackend([], ["opencode"]), "opencode")
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
