import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

test("desktop packaging carries the bridge runtime outside the app asar", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  const resources = packageJson.build?.extraResources ?? []
  assert.ok(resources.some((entry) => entry.from === "../bridge/src" && entry.to === "bridge-runtime/src"))
  assert.ok(resources.some((entry) => entry.from === "../bridge/package.json" && entry.to === "bridge-runtime/package.json"))
})

test("keeps the embedded daemon loopback-only, isolates state, and keeps credentials out of process arguments", () => {
  const args = embeddedDaemonArgs(4100, 4101, "/private/desktop-state")
  assert.deepEqual(args, [
    "--host", "127.0.0.1",
    "--port", "4100",
    "--opencode-host", "127.0.0.1",
    "--opencode-port", "4101",
    "--state-dir", "/private/desktop-state"
  ])
  assert.equal(args.includes("desktop-user"), false)
  assert.equal(args.includes("desktop-pass"), false)

  const env = embeddedDaemonEnvironment(
    { PATH: "/bin" },
    { username: "desktop-user", password: "desktop-pass" }
  )
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1")
  assert.equal(env.PATH, "/bin")
  assert.equal(env.HARNESS_REMOTE_USERNAME, "desktop-user")
  assert.equal(env.HARNESS_REMOTE_PASSWORD, "desktop-pass")
})

test("skips a loopback port that is already occupied", async () => {
  const base = await findLoopbackPort(55_000, [], 1_000)
  const occupied = createServer()
  await new Promise((resolve, reject) => {
    occupied.once("error", reject)
    occupied.listen(base, EMBEDDED_DAEMON_HOST, resolve)
  })
  try {
    const selected = await findLoopbackPort(base, [], 16)
    assert.notEqual(selected, base)
    assert.ok(selected > base)
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
const stateIndex = process.argv.indexOf("--state-dir")
if (stateIndex < 0 || !process.argv[stateIndex + 1]) process.exit(8)
if (!process.env.HARNESS_REMOTE_USERNAME || !process.env.HARNESS_REMOTE_PASSWORD) process.exit(9)
process.stdout.write("Harness daemon ready at http://127.0.0.1:" + port + "\\n")
const timer = setInterval(() => {}, 1000)
process.on("SIGTERM", () => { clearInterval(timer); process.exit(0) })
`, "utf8")

  const exits = []
  const runtime = new EmbeddedDaemonRuntime({
    entryPath: script,
    stateDirectory: join(root, "state"),
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 2_000,
    onExit: (details) => exits.push(details)
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
    assert.deepEqual(exits, [], "intentional shutdown must not be reported as an unexpected runtime exit")
  } finally {
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test("restarts a live embedded daemon after repeated authenticated HTTP health failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "hr-embedded-daemon-health-"))
  const script = join(root, "wedging-daemon.mjs")
  const stateDirectory = join(root, "state")
  const generationFile = join(stateDirectory, "health-generation")
  await writeFile(script, `
import http from "node:http"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const port = Number(process.argv[process.argv.indexOf("--port") + 1])
const stateDirectory = process.argv[process.argv.indexOf("--state-dir") + 1]
mkdirSync(stateDirectory, { recursive: true })
const generationFile = join(stateDirectory, "health-generation")
let generation = 0
try { generation = Number(readFileSync(generationFile, "utf8")) || 0 } catch {}
generation += 1
writeFileSync(generationFile, String(generation))
const expectedAuthorization = "Basic " + Buffer.from(process.env.HARNESS_REMOTE_USERNAME + ":" + process.env.HARNESS_REMOTE_PASSWORD).toString("base64")
let machineRequests = 0
const server = http.createServer((request, response) => {
  if (request.url !== "/v1/machine") { response.writeHead(404); response.end(); return }
  if (request.headers.authorization !== expectedAuthorization) { response.writeHead(401); response.end(); return }
  machineRequests += 1
  if (generation === 1 && machineRequests > 1) return
  response.writeHead(200, { "Content-Type": "application/json" })
  response.end(JSON.stringify({ machine: { id: "fake" }, agents: [] }))
})
server.listen(port, "127.0.0.1", () => {
  process.stdout.write("Harness daemon ready at http://127.0.0.1:" + port + "\\n")
})
process.on("SIGTERM", () => {
  server.closeAllConnections?.()
  server.close()
  process.exit(0)
})
`, "utf8")

  const exits = []
  const runtime = new EmbeddedDaemonRuntime({
    entryPath: script,
    stateDirectory,
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 1_000,
    healthCheckIntervalMs: 20,
    healthCheckTimeoutMs: 30,
    healthFailureThreshold: 2,
    onExit: (details) => exits.push(details)
  })
  try {
    const first = await runtime.start()

    let generation = 0
    for (let index = 0; index < 200 && generation < 2; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      try { generation = Number(await readFile(generationFile, "utf8")) || 0 } catch {}
    }
    assert.equal(generation, 2, "health supervision should replace the wedged process")

    const second = await runtime.start()
    assert.equal(runtime.isRunning, true)
    assert.notEqual(second.pid, first.pid)
    assert.equal(second.endpoint.port, first.endpoint.port, "recovery must preserve the registered loopback endpoint")
    assert.equal(second.endpoint.username, first.endpoint.username)
    assert.equal(second.endpoint.password, first.endpoint.password, "recovery must preserve volatile credentials")
    assert.equal(await runtime.healthCheck(), true)
    assert.deepEqual(exits, [], "successful health recovery must not be reported as an unexpected exit")
  } finally {
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test("reports an unexpected post-readiness daemon exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "hr-embedded-daemon-exit-"))
  const script = join(root, "exiting-daemon.mjs")
  await writeFile(script, `
const port = process.argv[process.argv.indexOf("--port") + 1]
process.stdout.write("Harness daemon ready at http://127.0.0.1:" + port + "\\n")
setTimeout(() => process.exit(7), 50)
`, "utf8")
  let exit
  const runtime = new EmbeddedDaemonRuntime({
    entryPath: script,
    startupTimeoutMs: 2_000,
    onExit: (details) => { exit = details }
  })
  try {
    await runtime.start()
    for (let index = 0; index < 100 && !exit; index += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(exit, { code: 7, signal: null })
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
