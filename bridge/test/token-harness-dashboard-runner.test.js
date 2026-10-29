import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
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
    await rm(root, { recursive: true, force: true })
  }
})
