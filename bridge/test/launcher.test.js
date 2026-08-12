import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { buildBridgeArgs, detectBackends, resolveBackend } from "../src/launcher.js"

test("detects supported agent executables without running them", () => {
  const pathValue = ["/bin", "/tools"].join(path.delimiter)
  const existing = new Set([path.join("/tools", "codex")])
  assert.deepEqual(detectBackends({ pathValue, platform: "linux", exists: (candidate) => existing.has(candidate) }), ["codex"])
})

test("uses an explicit backend even when discovery is empty", () => {
  assert.equal(resolveBackend(["--backend", "claude"], []), "claude")
})

test("auto-selects exactly one detected backend", () => {
  assert.equal(resolveBackend([], ["omp"]), "omp")
})

test("requires an explicit choice when multiple backends are detected", () => {
  assert.throws(() => resolveBackend([], ["codex", "claude"]), /Multiple supported agents detected/)
})

test("requires an explicit backend when discovery finds none", () => {
  assert.throws(() => resolveBackend([], []), /No supported agent CLI was detected/)
})

test("injects quick-start defaults without overriding explicit bridge options", () => {
  assert.deepEqual(buildBridgeArgs(["--root", "/work"], {
    backend: "codex",
    host: "0.0.0.0",
    port: 4098,
    username: "harness",
    password: "secret"
  }), [
    "--root", "/work",
    "--backend", "codex",
    "--host", "0.0.0.0",
    "--port", "4098",
    "--username", "harness",
    "--password", "secret"
  ])

  const explicit = ["--backend", "pi", "--host", "127.0.0.1", "--port", "5000"]
  assert.deepEqual(buildBridgeArgs(explicit, {
    backend: "codex",
    host: "0.0.0.0",
    port: 4098,
    username: "",
    password: ""
  }), explicit)
})
