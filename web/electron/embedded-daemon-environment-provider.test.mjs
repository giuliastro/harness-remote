import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const { EmbeddedDaemonRuntime } = await import("../dist-electron/electron/embedded-daemon.js")

test("awaits a fresh environment provider before each embedded daemon launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "hr-embedded-daemon-env-"))
  const script = join(root, "fake-daemon.mjs")
  await writeFile(script, `
const port = process.argv[process.argv.indexOf("--port") + 1]
if (process.env.HARNESS_REMOTE_ENV_PROVIDER_SENTINEL !== "ready") process.exit(12)
process.stdout.write("Harness daemon ready at http://127.0.0.1:" + port + "\\n")
const timer = setInterval(() => {}, 1000)
process.on("SIGTERM", () => { clearInterval(timer); process.exit(0) })
`, "utf8")

  let calls = 0
  const runtime = new EmbeddedDaemonRuntime({
    entryPath: script,
    environment: async () => {
      calls += 1
      return { ...process.env, HARNESS_REMOTE_ENV_PROVIDER_SENTINEL: "ready" }
    },
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 2_000
  })

  try {
    await runtime.start()
    assert.equal(calls, 1)
    await runtime.stop()
    await runtime.start()
    assert.equal(calls, 2, "a retry/restart must refresh PATH rather than reusing a stale environment")
  } finally {
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  }
})
