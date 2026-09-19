import assert from "node:assert/strict"
import test from "node:test"
import { ensureHarnessPortAvailable, ensureOpenCodePortAvailable, parseDaemonOptions } from "../src/daemon-cli.js"
import { resolveLaunchPlan } from "../src/launcher.js"

const loopbackEnv = {
  HARNESS_REMOTE_HOST: "127.0.0.1",
  HARNESS_REMOTE_BACKEND: "codex"
}

test("daemon defaults to one ACP primary plus loopback managed OpenCode", () => {
  const parsed = parseDaemonOptions([], loopbackEnv)
  assert.equal(parsed.config.backend, "codex")
  assert.equal(parsed.openCode, true)
  assert.equal(parsed.openCodeCommand, "opencode")
  assert.equal(parsed.openCodeHost, "127.0.0.1")
  assert.equal(parsed.openCodePort, 4096)
  assert.equal(parsed.config.port, 4097)
})

test("daemon keeps a custom ACP command for a known primary with multiple detected CLIs", () => {
  const args = ["--backend", "codex", "--acp-command", "/tools/custom-codex-acp"]
  const parsed = parseDaemonOptions(args, { HARNESS_REMOTE_HOST: "127.0.0.1" })

  assert.equal(parsed.config.backend, "codex")
  assert.equal(parsed.config.acpCommand, "/tools/custom-codex-acp")
  assert.deepEqual(resolveLaunchPlan(args, ["claude", "codex"]), {
    mode: "daemon",
    backend: "codex",
    detected: ["claude", "codex"],
    openCode: false
  })
})

test("daemon does not inherit a LAN daemon bind for managed OpenCode", () => {
  const parsed = parseDaemonOptions(["--host", "0.0.0.0"], {
    HARNESS_REMOTE_BACKEND: "codex",
    HARNESS_REMOTE_USERNAME: "harness",
    HARNESS_REMOTE_PASSWORD: "secret"
  })
  assert.equal(parsed.config.host, "0.0.0.0")
  assert.equal(parsed.openCodeHost, "127.0.0.1")
})

test("daemon forwards bridge options and consumes OpenCode-specific options", () => {
  const parsed = parseDaemonOptions([
    "--backend", "claude",
    "--port", "4900",
    "--opencode-host", "127.0.0.2",
    "--opencode-port", "4901",
    "--opencode-command", "/tools/opencode",
    "--root", "/work"
  ], loopbackEnv)

  assert.equal(parsed.config.backend, "claude")
  assert.equal(parsed.config.port, 4900)
  assert.deepEqual(parsed.config.roots, ["/work"])
  assert.equal(parsed.openCodeHost, "127.0.0.2")
  assert.equal(parsed.openCodePort, 4901)
  assert.equal(parsed.openCodeCommand, "/tools/opencode")
})

test("daemon can explicitly disable OpenCode during migration", () => {
  const parsed = parseDaemonOptions(["--no-opencode"], loopbackEnv)
  assert.equal(parsed.openCode, false)
})

test("daemon rejects invalid managed OpenCode ports", () => {
  assert.throws(() => parseDaemonOptions(["--opencode-port", "nope"], loopbackEnv), /integer between 1 and 65535/)
})

test("daemon preflight rejects an occupied managed OpenCode port with an actionable error", async () => {
  await assert.rejects(ensureOpenCodePortAvailable({
    port: 4096,
    host: "127.0.0.1",
    canListenImpl: async () => false
  }), /already in use.*OpenCode already running.*--opencode-port/)
})

test("daemon preflight accepts a free managed OpenCode port", async () => {
  await ensureOpenCodePortAvailable({
    port: 4096,
    host: "127.0.0.1",
    canListenImpl: async () => true
  })
})

test("daemon OpenCode preflight has a working default listener probe", async () => {
  await ensureOpenCodePortAvailable({
    port: 0,
    host: "127.0.0.1"
  })
})

test("daemon preflight rejects a wildcard port shadowed by a local listener", async () => {
  await assert.rejects(ensureHarnessPortAvailable({
    port: 4097,
    host: "0.0.0.0",
    canListenImpl: async () => false
  }), /Harness Remote cannot use 0\.0\.0\.0:4097.*omit --port/)
})

test("daemon preflight accepts a free wildcard port", async () => {
  await ensureHarnessPortAvailable({
    port: 4097,
    host: "0.0.0.0",
    canListenImpl: async () => true
  })
})
