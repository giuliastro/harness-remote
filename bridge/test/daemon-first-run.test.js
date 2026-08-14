import assert from "node:assert/strict"
import test from "node:test"
import { parseDaemonOptions } from "../src/daemon-cli.js"

const detect = (backend = "pi") => () => ({ backend, detected: ["pi", "opencode"], mode: "daemon" })

// A daemon is started once per machine and is expected to work out what that machine has. The
// shared bridge parser defaults to `omp`, which is right for the standalone bridge — one server is
// one harness and the user names it — and wrong here: a phone with PI and OpenCode installed
// announced `omp` as its primary and then failed with `spawn omp ENOENT`.
test("a daemon started without --backend resolves one from PATH", () => {
  assert.equal(parseDaemonOptions([], {}, detect()).config.backend, "pi")
})

test("an explicit backend and the environment both outrank detection", () => {
  const never = () => { throw new Error("detection must not run when the backend is named") }
  assert.equal(parseDaemonOptions(["--backend", "claude"], {}, never).config.backend, "claude")
  assert.equal(parseDaemonOptions([], { HARNESS_REMOTE_BACKEND: "codex" }, never).config.backend, "codex")
  assert.equal(parseDaemonOptions([], { OMP_BRIDGE_BACKEND: "codex" }, never).config.backend, "codex")
})

// Starting up and failing later is worse than refusing to start: the message the launcher already
// writes names what it looked for.
test("a machine with no supported agent is refused rather than defaulted", () => {
  const empty = () => { throw new Error("No supported agent CLI was found on PATH.") }
  assert.throws(() => parseDaemonOptions([], {}, empty), /No supported agent CLI/)
})

// 15 seconds is not a universal truth. Under proot on a phone — the environment this project keeps
// optimising for — OpenCode's first start routinely exceeds it, and the host then stays unavailable
// for the life of the daemon.
test("the managed OpenCode readiness timeout can be raised", () => {
  assert.equal(parseDaemonOptions([], {}, detect()).openCodeTimeout, 15000)
  assert.equal(parseDaemonOptions(["--opencode-timeout", "60000"], {}, detect()).openCodeTimeout, 60000)
  assert.equal(parseDaemonOptions([], { HARNESS_REMOTE_OPENCODE_TIMEOUT: "45000" }, detect()).openCodeTimeout, 45000)
  assert.throws(() => parseDaemonOptions(["--opencode-timeout", "5"], {}, detect()), /at least 1000/)
})
