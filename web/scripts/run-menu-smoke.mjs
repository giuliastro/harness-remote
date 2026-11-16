/**
 * Runs scripts/menu-smoke.mjs under Electron and decides the result from what the smoke reports,
 * not from Electron's exit code.
 *
 * On the Windows runners Electron sometimes exits with 1 after the smoke has printed its pass line,
 * whether the script ends with app.exit(0) or process.exit(0). The menu had built and installed
 * correctly every time; the failure is in Electron's own shutdown, which this smoke does not test.
 * That flake failed the Windows packaging job, and with it the release job that attaches the
 * desktop artifacts.
 *
 * Pass: the pass line was printed and no assertion failed. Anything else, including a crash before
 * the pass line, no output or a hang, still fails.
 */
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const electron = require("electron")
const smoke = fileURLToPath(new URL("./menu-smoke.mjs", import.meta.url))
const PASS_LINE = /^application menu smoke test passed on \S+$/m
const TIMEOUT_MS = 120_000

// Inherited from an Electron-based shell, this would run the smoke as plain Node without Electron's
// app and Menu modules.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, [smoke], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
let stdout = ""
let stderr = ""
child.stdout.on("data", (chunk) => { stdout += chunk; process.stdout.write(chunk) })
child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk) })

const timer = setTimeout(() => {
  console.error(`menu smoke did not finish within ${TIMEOUT_MS / 1000} s`)
  child.kill()
  process.exit(1)
}, TIMEOUT_MS)

child.on("error", (error) => {
  clearTimeout(timer)
  console.error(`could not start Electron: ${error.message}`)
  process.exit(1)
})

child.on("close", (code, signal) => {
  clearTimeout(timer)
  const passed = PASS_LINE.test(stdout) && !/✗/.test(stdout + stderr)
  if (!passed) {
    console.error(`menu smoke failed (Electron exit ${signal ?? code})`)
    process.exit(1)
  }
  if (code !== 0) {
    console.warn(`menu smoke passed; Electron then exited with ${signal ?? code} during shutdown, which this smoke does not test`)
  }
  process.exit(0)
})
