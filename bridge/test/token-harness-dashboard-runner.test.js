import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { spawn, spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const MAX_LOG_BYTES = 1024 * 1024
const runnerPath = fileURLToPath(new URL("../src/plugins/builtin/token-harness/dashboard-runner.cjs", import.meta.url))

test("dashboard runner keeps a bounded rolling log and preserves its ready URL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "token-harness-dashboard-runner-"))
  const logPath = path.join(root, "dashboard.log")
  const cliScript = path.join(root, "token-harness")
  const cli = process.platform === "win32" ? path.join(root, "token-harness.cmd") : cliScript
  await writeFile(cliScript, `#!/usr/bin/env node
process.stdout.write("Token Harness is ready: http://127.0.0.1:45678/\\n")
let index = 0
function writeChunk() {
  if (index === 24) return process.exit(0)
  const chunk = "x".repeat(128 * 1024) + "\\nTAIL_SENTINEL_" + index + "\\n"
  index += 1
  process.stderr.write(chunk, writeChunk)
}
writeChunk()
`, "utf8")
  await chmod(cliScript, 0o755)
  if (process.platform === "win32") {
    await writeFile(cli, `@echo off\r\n"${process.execPath}" "%~dp0token-harness" %*\r\n`, "utf8")
  }

  try {
    const result = spawnSync(process.execPath, [runnerPath, cli, logPath, root], {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true
    })
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    const [log, details] = await Promise.all([readFile(logPath, "utf8"), stat(logPath)])
    assert.ok(details.size <= MAX_LOG_BYTES, `dashboard.log was ${details.size} bytes`)
    assert.match(log, /Token Harness is ready: http:\/\/127\.0\.0\.1:45678\//)
    assert.match(log, /TAIL_SENTINEL_23/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test("dashboard runner stops its child when the plugin is disabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "token-harness-dashboard-stop-"))
  const logPath = path.join(root, "dashboard.log")
  const cliScript = path.join(root, "token-harness")
  const cli = process.platform === "win32" ? path.join(root, "token-harness.cmd") : cliScript
  const childPIDPath = path.join(root, "child.pid")
  await writeFile(cliScript, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(childPIDPath)}, String(process.pid))
process.stdout.write("Token Harness is ready: http://127.0.0.1:45678/\\n")
setInterval(() => {}, 1000)
`)
  await chmod(cliScript, 0o755)
  if (process.platform === "win32") {
    await writeFile(cli, `@echo off\r\n"${process.execPath}" "%~dp0token-harness" %*\r\n`)
  }
  const runner = spawn(process.execPath, [runnerPath, cli, logPath, root], { stdio: "ignore", windowsHide: true })
  let childPID = null
  try {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        const log = await readFile(logPath, "utf8")
        childPID = Number(await readFile(childPIDPath, "utf8"))
        if (log.includes("Token Harness is ready:") && Number.isInteger(childPID)) break
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(childPID, "dashboard child did not start")
    await writeFile(path.join(root, "dashboard.json"), JSON.stringify({ pid: runner.pid, url: "http://127.0.0.1:45678/" }))
    await writeFile(path.join(root, "dashboard.stop"), "stop")
    const exitCode = await Promise.race([
      new Promise((resolve) => runner.once("close", resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error("dashboard runner did not stop")), 5_000))
    ])
    assert.equal(exitCode, 0)
    await assert.rejects(readFile(path.join(root, "dashboard.json"), "utf8"), { code: "ENOENT" })
    assert.throws(() => process.kill(childPID, 0))
  } finally {
    if (runner.exitCode === null) runner.kill()
    if (childPID && process.platform === "win32") spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(childPID), "/F"], { windowsHide: true })
    else if (childPID) { try { process.kill(childPID, "SIGKILL") } catch {} }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
