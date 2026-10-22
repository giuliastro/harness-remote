import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { findCodexExecutable, codexAdapterEnvironment } from "../src/executable-discovery.js"
import { detectBackends } from "../src/launcher.js"

test("discovers desktop Codex outside a GUI client's PATH", () => {
  for (const [platform, candidate] of [
    ["linux", "/usr/lib/chatgpt/resources/codex"],
    ["darwin", "/Applications/Codex.app/Contents/Resources/codex"],
    ["darwin", "/users/test/Applications/ChatGPT.app/Contents/Resources/codex"]
  ]) {
    const options = { platform, homeDirectory: "/users/test", pathValue: "/usr/bin", exists: value => value === candidate, access() {} }
    assert.equal(findCodexExecutable(options), candidate)
    assert.deepEqual(detectBackends(options), ["codex"])
    assert.equal(findCodexExecutable({ ...options, access() { throw new Error("denied") } }), null)
  }
})

test("prefers an installed CLI and skips a dangling standalone shim", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-discovery-"))
  try {
    const shim = path.join(root, "codex")
    fs.symlinkSync(path.join(root, "missing"), shim)
    const candidate = "/usr/lib/chatgpt/resources/codex"
    const options = { platform: "linux", pathValue: root, exists: value => value === candidate || fs.existsSync(value), access: value => { if (value !== candidate) fs.accessSync(value, fs.constants.X_OK) } }
    assert.equal(findCodexExecutable(options), candidate)
    fs.unlinkSync(shim)
    fs.writeFileSync(shim, "#!/bin/sh\n", { mode: 0o755 })
    assert.equal(findCodexExecutable(options), shim)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("does not claim desktop Codex when absent or on an unsupported platform", () => {
  assert.equal(findCodexExecutable({ pathValue: "", exists: () => false }), null)
  assert.equal(findCodexExecutable({ platform: "win32", pathValue: "", exists: () => true }), null)
})

test("adapter uses detected Codex, respects an explicit override and retains bundled fallback", () => {
  assert.equal(findCodexExecutable({ codexPath: "/custom path/codex", pathValue: "", exists: value => value === "/custom path/codex", access() {} }), "/custom path/codex")
  assert.deepEqual(codexAdapterEnvironment({ environment: { PATH: "/tools" }, find: options => {
    assert.equal(options.pathValue, "/tools")
    return "/desktop/codex"
  } }), { CODEX_PATH: "/desktop/codex" })
  assert.deepEqual(codexAdapterEnvironment({ environment: { CODEX_PATH: "/custom/codex" }, find() { throw Error("must not override") } }), { CODEX_PATH: "/custom/codex" })
  assert.deepEqual(codexAdapterEnvironment({ environment: {}, find: () => null }), {})
})
