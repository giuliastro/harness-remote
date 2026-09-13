import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const { EmbeddedDaemonRuntime } = await import("../dist-electron/electron/embedded-daemon.js")

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function readNumber(path) {
  try { return Number(await readFile(path, "utf8")) || 0 } catch { return 0 }
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === "ESRCH") return false
    throw error
  }
}

test("hard recovery replaces the daemon process tree instead of leaving a managed child orphaned", {
  skip: process.platform === "win32" ? "POSIX process-group supervision is tested on POSIX runners" : false
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "hr-embedded-daemon-tree-"))
  const stateDirectory = join(root, "state")
  const daemonScript = join(root, "daemon.mjs")
  const holderScript = join(root, "holder.mjs")
  const generationFile = join(stateDirectory, "generation")
  const holderPidFile = join(stateDirectory, "holder-pid")
  const firstInternalPortFile = join(stateDirectory, "internal-port-1")
  const secondInternalPortFile = join(stateDirectory, "internal-port-2")

  await writeFile(holderScript, `
import net from "node:net"
const port = Number(process.argv[2])
const server = net.createServer()
server.listen(port, "127.0.0.1", () => process.stdout.write("READY\\n"))
setInterval(() => {}, 1000)
`, "utf8")

  await writeFile(daemonScript, `
import http from "node:http"
import net from "node:net"
import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const port = Number(process.argv[process.argv.indexOf("--port") + 1])
const internalPort = Number(process.argv[process.argv.indexOf("--opencode-port") + 1])
const stateDirectory = process.argv[process.argv.indexOf("--state-dir") + 1]
mkdirSync(stateDirectory, { recursive: true })
const generationFile = join(stateDirectory, "generation")
let generation = 0
try { generation = Number(readFileSync(generationFile, "utf8")) || 0 } catch {}
generation += 1
writeFileSync(generationFile, String(generation))
writeFileSync(join(stateDirectory, "internal-port-" + generation), String(internalPort))

await new Promise((resolve, reject) => {
  const probe = net.createServer()
  probe.once("error", reject)
  probe.listen(internalPort, "127.0.0.1", () => probe.close(resolve))
})

if (generation === 1) {
  const holder = spawn(process.execPath, [${JSON.stringify(holderScript)}, String(internalPort)], {
    stdio: ["ignore", "pipe", "ignore"]
  })
  await new Promise((resolve, reject) => {
    let stdout = ""
    const onData = (chunk) => {
      stdout += String(chunk)
      if (stdout.includes("READY")) {
        holder.stdout.off("data", onData)
        resolve()
      }
    }
    holder.stdout.on("data", onData)
    holder.once("error", reject)
    holder.once("exit", (code, signal) => reject(new Error("holder exited before ready: " + (code ?? signal))))
  })
  writeFileSync(join(stateDirectory, "holder-pid"), String(holder.pid))
}

const expectedAuthorization = "Basic " + Buffer.from(process.env.HARNESS_REMOTE_USERNAME + ":" + process.env.HARNESS_REMOTE_PASSWORD).toString("base64")
const server = http.createServer((request, response) => {
  if (request.url !== "/v1/machine") { response.writeHead(404); response.end(); return }
  if (request.headers.authorization !== expectedAuthorization) { response.writeHead(401); response.end(); return }
  response.writeHead(200, { "Content-Type": "application/json" })
  response.end(JSON.stringify({ machine: { id: "process-tree-test" }, agents: [] }))
})
server.listen(port, "127.0.0.1", () => {
  process.stdout.write("Harness daemon ready at http://127.0.0.1:" + port + "\\n")
})
`, "utf8")

  const exits = []
  const runtime = new EmbeddedDaemonRuntime({
    entryPath: daemonScript,
    stateDirectory,
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 250,
    healthCheckIntervalMs: 20,
    healthCheckTimeoutMs: 30,
    healthFailureThreshold: 2,
    recoveryRetryDelayMs: 20,
    onExit: (details) => exits.push(details)
  })

  let holderPid = 0
  try {
    const first = await runtime.start()
    holderPid = await readNumber(holderPidFile)
    const firstInternalPort = await readNumber(firstInternalPortFile)
    assert.ok(first.pid)
    assert.ok(holderPid)
    assert.ok(firstInternalPort)
    assert.equal(processExists(holderPid), true)

    process.kill(first.pid, "SIGSTOP")

    let currentGeneration = 1
    for (let index = 0; index < 600 && currentGeneration < 2; index += 1) {
      assert.equal(runtime.isRunning, true)
      await sleep(10)
      currentGeneration = await readNumber(generationFile)
    }
    assert.equal(currentGeneration, 2, "health supervision should replace the stopped daemon")

    for (let index = 0; index < 200 && processExists(holderPid); index += 1) await sleep(10)
    assert.equal(processExists(holderPid), false, "hard recovery must terminate managed descendants with the abandoned daemon")

    const second = await runtime.start()
    const secondInternalPort = await readNumber(secondInternalPortFile)
    assert.notEqual(second.pid, first.pid)
    assert.ok(secondInternalPort)
    assert.equal(second.endpoint.port, first.endpoint.port, "renderer-facing endpoint must remain stable")
    assert.equal(second.endpoint.username, first.endpoint.username)
    assert.equal(second.endpoint.password, first.endpoint.password)
    assert.equal(await runtime.healthCheck(), true)
    assert.deepEqual(exits, [])
  } finally {
    await runtime.stop()
    if (holderPid && processExists(holderPid)) {
      try { process.kill(holderPid, "SIGKILL") } catch {}
    }
    await rm(root, { recursive: true, force: true })
  }
})
