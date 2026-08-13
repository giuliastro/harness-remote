import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { bridgeEnvironment, buildBridgeArgs, buildDaemonArgs, createManagedShutdown, detectBackends, lanAddresses, resolveBackend, resolveLaunchPlan, startManagedOpenCode } from "../src/launcher.js"

test("detects executable agent files on PATH without running them", () => {
  const pathValue = ["/bin", "/tools"].join(path.delimiter)
  const existing = new Set([path.join("/tools", "codex")])
  assert.deepEqual(detectBackends({ pathValue, platform: "linux", exists: (candidate) => existing.has(candidate), access: () => {} }), ["codex"])
})

test("ignores non-executable PATH entries on Unix", () => {
  const candidate = path.join("/tools", "claude")
  assert.deepEqual(detectBackends({ pathValue: "/tools", platform: "linux", exists: (value) => value === candidate, access: () => { throw new Error("not executable") } }), [])
})

test("detects OpenCode as a managed direct-HTTP backend", () => {
  const candidate = path.join("/tools", "opencode")
  assert.deepEqual(detectBackends({ pathValue: "/tools", platform: "linux", exists: (value) => value === candidate, access: () => {} }), ["opencode"])
  assert.equal(resolveBackend([], ["opencode"]), "opencode")
})

test("delegates OpenCode startup to the managed host", async () => {
  let options
  class FakeHost { constructor(value) { options = value } async start() { this.started = true } }
  const managed = await startManagedOpenCode({ host: "0.0.0.0", port: 4096, username: "harness", password: "secret", command: "/tools/opencode", Host: FakeHost })
  assert.equal(managed.started, true)
  assert.deepEqual(options, { command: "/tools/opencode", host: "0.0.0.0", port: 4096, username: "harness", password: "secret" })
})

test("escalates a second shutdown signal from SIGTERM to SIGKILL", () => {
  const signals = []
  const exits = []
  const processObject = { exitCode: 0, exit(code) { exits.push(code) } }
  const shutdown = createManagedShutdown({ stop: (signal) => signals.push(signal) }, processObject)
  shutdown("SIGINT")
  assert.equal(processObject.exitCode, 130)
  assert.deepEqual(signals, ["SIGTERM"])
  assert.deepEqual(exits, [])
  shutdown("SIGINT")
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
  assert.deepEqual(exits, [130])
})

test("uses an explicit backend on a fresh environment with no detected CLI", () => {
  assert.equal(resolveBackend(["--backend", "claude"], []), "claude")
  assert.deepEqual(resolveLaunchPlan(["--backend", "claude"], []), { mode: "single", backend: "claude", detected: [] })
})

test("auto-selects exactly one detected backend", () => {
  assert.equal(resolveBackend([], ["omp"]), "omp")
  assert.deepEqual(resolveLaunchPlan([], ["omp"]), { mode: "single", backend: "omp", detected: ["omp"] })
})

test("starts the machine daemon automatically when multiple agents are detected", () => {
  assert.deepEqual(resolveLaunchPlan([], ["claude", "codex", "opencode"]), { mode: "daemon", backend: "codex", detected: ["claude", "codex", "opencode"], openCode: true })
})

test("uses --backend to select the daemon primary", () => {
  assert.deepEqual(resolveLaunchPlan(["--backend", "claude"], ["codex", "claude", "opencode"]), { mode: "daemon", backend: "claude", detected: ["codex", "claude", "opencode"], openCode: true })
})

test("uses --single as the daemon opt-out", () => {
  assert.deepEqual(resolveLaunchPlan(["--single", "--backend", "claude"], ["codex", "claude", "opencode"]), { mode: "single", backend: "claude", detected: ["codex", "claude", "opencode"] })
  assert.throws(() => resolveLaunchPlan(["--single"], ["codex", "claude"]), /--single requires --backend/)
})

test("keeps explicit OpenCode on the single-host path", () => {
  assert.deepEqual(resolveLaunchPlan(["--backend", "opencode"], ["codex", "opencode"]), { mode: "single", backend: "opencode", detected: ["codex", "opencode"] })
})

test("starts a daemon without OpenCode when multiple ACP agents are detected", () => {
  assert.deepEqual(resolveLaunchPlan([], ["omp", "claude"]), { mode: "daemon", backend: "claude", detected: ["omp", "claude"], openCode: false })
})

test("keeps the legacy resolver strict for callers that still require one backend", () => {
  assert.throws(() => resolveBackend([], ["codex", "claude"]), /Multiple supported agent CLIs were found on PATH/)
})

test("requires an installed or explicit backend when discovery finds none", () => {
  assert.throws(() => resolveLaunchPlan([], []), /No supported agent CLI was found on PATH/)
})

test("injects quick-start defaults but never places credentials or launcher-only flags on child argv", () => {
  const argv = buildBridgeArgs(["--root", "/work", "--single", "--username", "harness", "--password", "secret"], { backend: "codex", host: "0.0.0.0", port: 4098 })
  assert.deepEqual(argv, ["--root", "/work", "--backend", "codex", "--host", "0.0.0.0", "--port", "4098"])
  assert.equal(argv.includes("secret"), false)
  const environment = bridgeEnvironment({ PATH: "/bin" }, "harness", "secret")
  assert.equal(environment.HARNESS_REMOTE_USERNAME, "harness")
  assert.equal(environment.HARNESS_REMOTE_PASSWORD, "secret")
  assert.equal(environment.PATH, "/bin")
})

test("builds daemon argv with selected primary and managed OpenCode port", () => {
  assert.deepEqual(buildDaemonArgs(["--root", "/work"], { backend: "codex", host: "0.0.0.0", port: 4097, openCode: false }), ["--root", "/work", "--backend", "codex", "--host", "0.0.0.0", "--port", "4097", "--no-opencode"])
  assert.deepEqual(buildDaemonArgs([], { backend: "claude", host: "0.0.0.0", port: 4097, openCode: true, openCodePort: 4098 }), ["--backend", "claude", "--host", "0.0.0.0", "--port", "4097", "--opencode-port", "4098"])
})

test("does not override an explicit managed OpenCode port", () => {
  assert.deepEqual(buildDaemonArgs(["--opencode-port", "4901"], { backend: "codex", host: "0.0.0.0", port: 4097, openCode: true, openCodePort: 4098 }), ["--opencode-port", "4901", "--backend", "codex", "--host", "0.0.0.0", "--port", "4097"])
})

test("does not override explicit backend, host, or port", () => {
  const explicit = ["--backend", "pi", "--host", "127.0.0.1", "--port", "5000"]
  assert.deepEqual(buildBridgeArgs(explicit, { backend: "codex", host: "0.0.0.0", port: 4098 }), explicit)
})

test("prefers physical LAN addresses over obvious virtual interfaces", () => {
  assert.deepEqual(lanAddresses({ docker0: [{ family: "IPv4", internal: false, address: "172.17.0.1" }], wlan0: [{ family: "IPv4", internal: false, address: "192.168.1.42" }], lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }] }), ["192.168.1.42"])
})

test("falls back to virtual candidates when no physical-looking address exists", () => {
  assert.deepEqual(lanAddresses({ docker0: [{ family: "IPv4", internal: false, address: "172.17.0.1" }] }), ["172.17.0.1"])
})
