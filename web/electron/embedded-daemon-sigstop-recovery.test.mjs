import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const { EmbeddedDaemonRuntime } = await import("../dist-electron/electron/embedded-daemon.js")

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function generation(path) {
  try { return Number(await readFile(path, "utf8")) || 0 } catch { return 0 }
}

test("recovers a SIGSTOPed embedded daemon without dropping logical runtime liveness", {
  skip: process.platform === "win32" ? "SIGSTOP is a POSIX-only desktop failure mode" : false
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "hr-embedded-daemon-sigstop-"))
  const script = join(root, "daemon.mjs")
  const stateDirectory = join(root, "state")
  const generationFile = join(stateDirectory, "generation")
  await writeFile(script, `
import http from "node:http"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const port = Number(process.argv[process.argv.indexOf("--port") + 1])
const stateDirectory = process.argv[process.argv.indexOf("--state-dir") + 1]
mkdirSync(stateDirectory, { recursive: true })
const generationFile = join(stateDirectory, "generation")
let generation = 0
try { generation = Number(readFileSync(generationFile, "utf8")) || 0 } catch {}
generation += 1
writeFileSync(generationFile, String(generation))
const expectedAuthorization = "Basic " + Buffer.from(process.env.HARNESS_REMOTE_USERNAME + ":" + process.env.HARNESS_REMOTE_PASSWORD).toString("base64")
const server = http.createServer((request, response) => {
  if (request.url !== "/v1/machine") { response.writeHead(404); response.end(); return }
  if (request.headers.authorization !== expectedAuthorization) { response.writeHead(401); response.end(); return }
  response.writeHead(200, { "Content-Type": "application/json" })
  response.end(JSON.stringify({ machine: { id: "sigstop-test" }, agents: [] }))
})
server.listen(port, "127.0.0.1", () => {
  process.stdout.write("Harness daemon ready at http://127.0.0.1:" + port + "\\n")
})
`, "utf8")

  const exits = []
  const runtime = new EmbeddedDaemonRuntime({
    entryPath: script,
    stateDirectory,
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 250,
    healthCheckIntervalMs: 20,
    healthCheckTimeoutMs: 30,
    healthFailureThreshold: 2,
    onExit: (details) => exits.push(details)
  })

  try {
    const first = await runtime.start()
    assert.ok(first.pid)
    assert.equal(await generation(generationFile), 1)
    process.kill(first.pid, "SIGSTOP")

    let currentGeneration = 1
    for (let index = 0; index < 600 && currentGeneration < 2; index += 1) {
      // Electron polls this logical liveness flag while the daemon is being supervised. It must not
      // interpret the deliberate child replacement window as a permanent local-runtime crash.
      assert.equal(runtime.isRunning, true)
      await sleep(10)
      currentGeneration = await generation(generationFile)
    }
    assert.equal(currentGeneration, 2, "health supervision should replace the stopped process")

    const second = await runtime.start()
    assert.notEqual(second.pid, first.pid)
    assert.equal(second.endpoint.port, first.endpoint.port)
    assert.equal(second.endpoint.username, first.endpoint.username)
    assert.equal(second.endpoint.password, first.endpoint.password)
    assert.equal(await runtime.healthCheck(), true)
    assert.deepEqual(exits, [], "successful SIGSTOP recovery must not surface as an unexpected exit")
  } finally {
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  }
})
