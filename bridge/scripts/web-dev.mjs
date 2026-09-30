#!/usr/bin/env node
import { access } from "node:fs/promises"
import { constants } from "node:fs"
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const rootDir = join(scriptDir, "..", "..")
const webDir = join(rootDir, "web")
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"
const vitePath = join(webDir, "node_modules", "vite", "bin", "vite.js")

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: webDir,
      stdio: "inherit",
      ...options
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal)
        return
      }
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code ?? 1}`))
    })
  })
}

try {
  await access(vitePath, constants.F_OK)
} catch {
  process.stdout.write("Preparing Harness Remote web UI dependencies in the npx cache...\n")
  // Windows cannot execute npm.cmd directly through child_process.spawn on current Node builds.
  // These arguments are fixed, so using the command shell here does not expose user input.
  await run(npmCommand, ["ci"], { shell: process.platform === "win32" })
}

const passthrough = process.argv.slice(2)
await run(process.execPath, [vitePath, "--host", ...passthrough])
