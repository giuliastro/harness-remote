import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { bridgeEnvironment, buildBridgeArgs, buildDaemonArgs, canListenForBind, createManagedShutdown, detectBackends, equivalentOpenCodeExecutables, formatStartupSummary, lanAddresses, resolveBackend, resolveLaunchPlan, startManagedOpenCode } from "../src/launcher.js"

test("detects executable agent files on PATH without running them", () => {
  const pathValue = ["/bin", "/tools"].join(path.delimiter)
  const existing = new Set([path.join("/tools", "codex")])
  assert.deepEqual(detectBackends({ pathValue, platform: "linux", exists: (candidate) => existing.has(candidate), access: () => {} }), ["codex"])
})

test("detects GitHub Copilot from provider metadata without changing existing primary preference", () => {
  const pathValue = ["/bin", "/tools"].join(path.delimiter)
  const existing = new Set([
    path.join("/tools", "copilot"),
    path.join("/tools", "codex")
  ])
  assert.deepEqual(
    detectBackends({ pathValue, platform: "linux", exists: (candidate) => existing.has(candidate), access: () => {} }),
    ["copilot", "codex"]
  )
  assert.deepEqual(
    resolveLaunchPlan([], ["copilot", "codex"]),
    { mode: "daemon", backend: "codex", detected: ["copilot", "codex"], openCode: false }
  )
  assert.deepEqual(
    resolveLaunchPlan([], ["copilot", "opencode"]),
    { mode: "daemon", backend: "copilot", detected: ["copilot", "opencode"], openCode: true }
  )
})

test("detects OpenCode 2 and MiMo as ACP providers without changing established primaries", () => {
  const pathValue = ["/bin", "/tools"].join(path.delimiter)
  const existing = new Set([
    path.join("/tools", "opencode2"),
    path.join("/tools", "mimo"),
    path.join("/tools", "copilot")
  ])
  assert.deepEqual(
    detectBackends({ pathValue, platform: "linux", exists: (candidate) => existing.has(candidate), access: () => {} }),
    ["copilot", "opencode2", "mimo"]
  )
  assert.deepEqual(
    resolveLaunchPlan([], ["copilot", "opencode2", "mimo"]),
    { mode: "daemon", backend: "copilot", detected: ["copilot", "opencode2", "mimo"], openCode: false }
  )
  assert.deepEqual(
    resolveLaunchPlan(["--backend", "opencode2"], ["copilot", "opencode2", "mimo"]),
    { mode: "daemon", backend: "opencode2", detected: ["copilot", "opencode2", "mimo"], openCode: false }
  )
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

test("does not register OpenCode 2 when its executable is only an OpenCode alias", () => {
  const opencode = path.join("/tools", "opencode")
  const opencode2 = path.join("/tools", "opencode2")
  const existing = new Set([opencode, opencode2])
  const alias = '#!/bin/sh\nexec "$(dirname "$0")/opencode" "$@"\n'

  assert.equal(
    equivalentOpenCodeExecutables(opencode, opencode2, {
      realpathSync: (value) => value,
      readFileSync: (value) => value === opencode2 ? alias : ""
    }),
    true
  )
  assert.deepEqual(
    detectBackends({
      pathValue: "/tools",
      platform: "linux",
      exists: (value) => existing.has(value),
      access: () => {},
      realpathSync: (value) => value,
      readFileSync: (value) => value === opencode2 ? alias : ""
    }),
    ["opencode"]
  )
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

test("startup summary prints one non-clickable address and a plain harness list", () => {
  const summary = formatStartupSummary({
    plan: { mode: "daemon", backend: "codex", detected: ["omp", "pi", "codex", "opencode"], openCode: true },
    addresses: ["192.168.1.42", "192.168.1.43"],
    port: 4097,
    username: "harness",
    password: "secret"
  })
  assert.match(summary, /Address\s+192\.168\.1\.42:4097/)
  assert.doesNotMatch(summary, /192\.168\.1\.43/)
  assert.doesNotMatch(summary, /https?:\/\//)
  assert.doesNotMatch(summary, /Open in browser/)
  assert.match(summary, /• omp/)
  assert.match(summary, /• pi/)
  assert.match(summary, /• codex/)
  assert.match(summary, /• opencode/)
  assert.doesNotMatch(summary, /— primary|starts on first use|— available|managed, starts/)
  assert.match(summary, /Machines → Add machine/)
})

test("keeps the single-backend startup summary simple", () => {
  const summary = formatStartupSummary({
    plan: { mode: "single", backend: "pi", detected: ["pi"] },
    addresses: [],
    port: 4097,
    username: "harness",
    password: "secret"
  })
  assert.match(summary, /Harness  pi/)
  assert.match(summary, /<LAN address>:4097/)
  assert.doesNotMatch(summary, /https?:\/\//)
  assert.doesNotMatch(summary, /Harnesses/)
})

test("injects quick-start defaults but never places credentials or launcher-only flags on child argv", () => {
  const argv = buildBridgeArgs(["--root", "/work", "--single", "--username", "harness", "--password", "secret"], { backend: "codex", host: "0.0.0.0", port: 4098 })
  assert.deepEqual(argv, ["--root", "/work", "--backend", "codex", "--host", "0.0.0.0", "--port", "4098"])
  assert.equal(argv.includes("secret"), false)
  const environment = bridgeEnvironment({ PATH: "/bin" }, "harness", "secret")
  assert.equal(environment.HARNESS_REMOTE_USERNAME, "harness")
  assert.equal(environment.HARNESS_REMOTE_PASSWORD, "secret")
  assert.equal(environment.HARNESS_REMOTE_LAUNCHED_BY_LAUNCHER, "1")
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

test("treats a wildcard bind as unavailable when localhost is already occupied", async () => {
  const probes = []
  const available = await canListenForBind(4097, "0.0.0.0", async (_port, host) => {
    probes.push(host)
    return host !== "127.0.0.1"
  })
  assert.equal(available, false)
  assert.ok(probes.includes("0.0.0.0"))
  assert.ok(probes.includes("127.0.0.1"))
})

test("does not require IPv6 to validate an IPv4 wildcard bind", async () => {
  const probes = []
  const available = await canListenForBind(4097, "0.0.0.0", async (_port, host) => {
    probes.push(host)
    return true
  })
  assert.equal(available, true)
  assert.ok(probes.includes("0.0.0.0"))
  assert.ok(probes.includes("127.0.0.1"))
  assert.ok(!probes.includes("::1"))
})
