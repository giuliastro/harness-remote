import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const {
  EMBEDDED_DAEMON_HOST,
  EMBEDDED_DAEMON_PROFILE_ID,
  EmbeddedDaemonRuntime,
  embeddedDaemonArgs,
  embeddedDaemonEntry,
  embeddedDaemonEnvironment,
  findLoopbackPort
} = await import("../dist-electron/electron/embedded-daemon.js")

test("resolves the daemon entry inside source checkout and packaged resources", () => {
  assert.equal(
    embeddedDaemonEntry({ isPackaged: false, appPath: "/repo/web", resourcesPath: "/unused" }),
    join("/repo/web", "..", "bridge", "src", "daemon-cli.js")
  )
  assert.equal(
    embeddedDaemonEntry({ isPackaged: true, appPath: "/unused", resourcesPath: "/app/resources" }),
    join("/app/resources", "bridge-runtime", "src", "daemon-cli.js")
  )
})

test("builds a loopback-only authenticated daemon launch contract", () => {
  assert.deepEqual(embeddedDaemonArgs(4100, 4101, "desktop-user", "desktop-pass"), [
    "--host", "127.0.0.1",
    "--port", "4100",
    "--opencode-host", "127.0.0.1",
    "--opencode-port", "4101",
    "--username", "desktop-user",
    "--password", "desktop-pass"
  ])
  const env = embeddedDaemonEnvironment({ PATH: "/bin" })
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1")
  assert.equal(env.PATH, "/bin")
})

test("skips a loopback port that is already occupied", async () => {
  const occupied = createServer()
  await new Promise((resolve, reject) => {
    occupied.once("error", reject)
    occupied.listen(0, EMBEDDED_DAEMON_HOST, resolve)
  })
  const address = occupied.address()
  assert.ok(address && typeof address === "object")
  try {
    const selected = await findLoopbackPort(address.port, [], 2)
    assert.equal(selected, address.port + 1)
  } finally {
    await new Promise((resolve) => occupied.close(resolve))
  }
})

test("owns one embedded daemon process from readiness through clean shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "hr-embedded-daemon-"))
  const script = join(root, "fake-daemon.mjs")
  await writeFile(script, `
const portIndex = process.argv.indexOf("--port")
const port = process.argv[portIndex + 1]
process.stdout.write("Harness daemon ready at http://127.0.0.1:" + port + "\\n")
const timer = setInterval(() => {}, 1000)
process.on("SIGTERM", () => { clearInterval(timer); process.exit(0) })
`, "utf8")

  const runtime = new EmbeddedDaemonRuntime({
    entryPath: script,
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 2_000
  })
  try {
    const first = await runtime.start()
    const second = await runtime.start()
    assert.equal(runtime.isRunning, true)
    assert.equal(first.pid, second.pid)
    assert.equal(first.endpoint.id, EMBEDDED_DAEMON_PROFILE_ID)
    assert.equal(first.endpoint.host, EMBEDDED_DAEMON_HOST)
    assert.ok(first.endpoint.port >= 4097)
    assert.equal(first.endpoint.username, "harness-desktop")
    assert.ok(first.endpoint.password.length >= 24)
    await runtime.stop()
    assert.equal(runtime.isRunning, false)
  } finally {
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test("surfaces an early daemon failure without leaking a permanently running child", async () => {
  const root = await mkdtemp(join(tmpdir(), "hr-embedded-daemon-failure-"))
  const script = join(root, "failing-daemon.mjs")
  await writeFile(script, `process.stderr.write("no supported harness found\\n"); process.exit(2)\n`, "utf8")
  const runtime = new EmbeddedDaemonRuntime({ entryPath: script, startupTimeoutMs: 2_000 })
  try {
    await assert.rejects(runtime.start(), /no supported harness found/i)
    assert.equal(runtime.isRunning, false)
  } finally {
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  }
})
