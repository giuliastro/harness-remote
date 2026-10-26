import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const { loadOrCreateEmbeddedDaemonAuth } = await import("../dist-electron/electron/embedded-daemon-auth.js")

test("persists one desktop daemon credential across restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "hr-embedded-auth-"))
  const path = join(root, "nested", "embedded-daemon-auth.json")
  try {
    const first = await loadOrCreateEmbeddedDaemonAuth(path)
    assert.equal(first.username, "harness-desktop")
    assert.ok(first.password.length >= 24)

    const stored = JSON.parse(await readFile(path, "utf8"))
    assert.deepEqual(stored, { version: 1, ...first })

    // This is the restart path: a new main process reads the same file and must reuse the phone's
    // already-paired Basic Auth credentials instead of minting a new password.
    const second = await loadOrCreateEmbeddedDaemonAuth(path)
    assert.deepEqual(second, first)

    if (process.platform !== "win32") {
      const mode = (await stat(path)).mode & 0o777
      assert.equal(mode & 0o077, 0, "only the desktop user may read the daemon secret")
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("replaces a malformed credential file with a stable valid one", async () => {
  const root = await mkdtemp(join(tmpdir(), "hr-embedded-auth-corrupt-"))
  const path = join(root, "embedded-daemon-auth.json")
  try {
    await writeFile(path, '{"version":1,"username":"","password":"short"}\n', "utf8")
    const first = await loadOrCreateEmbeddedDaemonAuth(path)
    assert.equal(first.username, "harness-desktop")
    assert.ok(first.password.length >= 24)

    const stored = JSON.parse(await readFile(path, "utf8"))
    assert.deepEqual(stored, { version: 1, ...first })
    assert.deepEqual(await loadOrCreateEmbeddedDaemonAuth(path), first)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
