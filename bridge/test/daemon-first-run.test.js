import assert from "node:assert/strict"
import test from "node:test"
import { parseDaemonOptions } from "../src/daemon-cli.js"

const detect = (backend = "pi") => () => ({ backend, detected: ["pi", "opencode"], mode: "daemon" })

test("a daemon started without --backend resolves one from PATH", () => {
  assert.equal(parseDaemonOptions([], {}, detect()).config.backend, "pi")
})

test("an explicit backend and the environment both outrank detection", () => {
  const never = () => { throw new Error("detection must not run when the backend is named") }
  assert.equal(parseDaemonOptions(["--backend", "claude"], {}, never).config.backend, "claude")
  assert.equal(parseDaemonOptions([], { HARNESS_REMOTE_BACKEND: "codex" }, never).config.backend, "codex")
  assert.equal(parseDaemonOptions([], { OMP_BRIDGE_BACKEND: "codex" }, never).config.backend, "codex")
})

test("a machine with no supported agent is refused rather than defaulted", () => {
  const empty = () => { throw new Error("No supported agent CLI was found on PATH.") }
  assert.throws(() => parseDaemonOptions([], {}, empty), /No supported agent CLI/)
})

test("the managed OpenCode readiness timeout can be raised", () => {
  assert.equal(parseDaemonOptions([], {}, detect()).openCodeTimeout, 15000)
  assert.equal(parseDaemonOptions(["--opencode-timeout", "60000"], {}, detect()).openCodeTimeout, 60000)
  assert.equal(parseDaemonOptions([], { HARNESS_REMOTE_OPENCODE_TIMEOUT: "45000" }, detect()).openCodeTimeout, 45000)
  assert.throws(() => parseDaemonOptions(["--opencode-timeout", "5"], {}, detect()), /at least 1000/)
})

test("an ACP adapter already on PATH is preferred over fetching one", async () => {
  const { harnessProfile, resolveAcpLaunch } = await import("../src/harness-profiles.js")

  const installed = resolveAcpLaunch(harnessProfile("pi"), { find: (name) => name === "pi-acp" ? "/usr/bin/pi-acp" : null })
  assert.deepEqual(installed, { command: "/usr/bin/pi-acp", args: [], source: "path" })

  const fetched = resolveAcpLaunch(harnessProfile("pi"), { find: () => null })
  assert.equal(fetched.source, "npx")
  assert.ok(fetched.args.includes("@automatalabs/pi-acp@0.2.5"))

  // OMP is itself the ACP executable. Resolve it before spawning so a child process does not have
  // to rediscover a curl-installed ~/.local/bin wrapper from a possibly different npx PATH.
  assert.deepEqual(resolveAcpLaunch(harnessProfile("omp"), { find: (name) => name === "omp" ? "/home/test/.local/bin/omp" : null }), {
    command: "/home/test/.local/bin/omp",
    args: ["acp"],
    source: "path"
  })

  for (const backend of ["claude", "codex"]) {
    const profile = harnessProfile(backend)
    assert.ok(profile.adapterCommand, `${backend} must name the adapter binary it would install`)
    assert.equal(resolveAcpLaunch(profile, { find: () => `/usr/bin/${profile.adapterCommand}` }).source, "path")
  }
})
