import assert from "node:assert/strict"
import test from "node:test"
import { parseDaemonOptions } from "../src/daemon-cli.js"

const loopbackEnv = {
  HARNESS_REMOTE_HOST: "127.0.0.1",
  HARNESS_REMOTE_BACKEND: "codex"
}

test("daemon defaults to one ACP primary plus managed OpenCode", () => {
  const parsed = parseDaemonOptions([], loopbackEnv)
  assert.equal(parsed.config.backend, "codex")
  assert.equal(parsed.openCode, true)
  assert.equal(parsed.openCodeCommand, "opencode")
  assert.equal(parsed.openCodePort, 4096)
  assert.equal(parsed.config.port, 4097)
})

test("daemon forwards bridge options and consumes OpenCode-specific options", () => {
  const parsed = parseDaemonOptions([
    "--backend", "claude",
    "--port", "4900",
    "--opencode-port", "4901",
    "--opencode-command", "/tools/opencode",
    "--root", "/work"
  ], loopbackEnv)

  assert.equal(parsed.config.backend, "claude")
  assert.equal(parsed.config.port, 4900)
  assert.deepEqual(parsed.config.roots, ["/work"])
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
