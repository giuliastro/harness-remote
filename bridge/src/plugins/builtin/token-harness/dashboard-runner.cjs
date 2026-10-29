const { spawn, spawnSync } = require("node:child_process")
const { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } = require("node:fs")
const path = require("node:path")

const MAX_LOG_BYTES = 1024 * 1024

// Long-lived bridge between a detached Token Harness UI server and the one-shot plugin process.
// Keeping the child's output in a real file avoids Windows cmd redirection quirks and lets the
// plugin read the ready URL without keeping the one-shot process alive.
const [cli, logPath, home] = process.argv.slice(2)
if (!cli || !logPath) process.exit(2)
const stopPath = path.join(path.dirname(logPath), "dashboard.stop")
const statePath = path.join(path.dirname(logPath), "dashboard.json")

let logBytes = 0
let readyLine = ""
let readyScan = ""

function writeLog(chunk) {
  const output = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  const decoded = output.toString("utf8")
  const readyInput = readyScan + decoded
  const readyMatch = /Token Harness is ready:\s*(http:\/\/(?:127\.0\.0\.1|localhost):\d+\/?)/.exec(readyInput)
  if (readyMatch) readyLine = `Token Harness is ready: ${readyMatch[1]}`
  readyScan = readyInput.slice(-512)

  if (logBytes + output.length <= MAX_LOG_BYTES) {
    appendFileSync(logPath, output)
    logBytes += output.length
    return
  }

  // Keep the newest output while reserving room for the ready URL. Keeping that line in
  // the tail lets the one-shot plugin process discover the URL even if startup output
  // filled the log before it next polls. Synchronous file operations also avoid rename
  // semantics that differ between Windows and Unix while the file is being read.
  let previous = readFileSync(logPath)
  const marker = readyLine ? Buffer.from(`\n${readyLine}\n`) : Buffer.alloc(0)
  if (marker.length) {
    // Remove the marker we appended on the preceding roll before selecting a fresh
    // tail; otherwise repeated rolls would gradually crowd out actual child output.
    const previousMarker = previous.lastIndexOf(marker)
    if (previousMarker >= 0) {
      previous = Buffer.concat([
        previous.subarray(0, previousMarker),
        previous.subarray(previousMarker + marker.length)
      ])
    }
  }
  const tailLimit = Math.max(0, MAX_LOG_BYTES - marker.length)
  const joined = Buffer.concat([previous, output])
  const tail = joined.subarray(Math.max(0, joined.length - tailLimit))
  const bounded = marker.length ? Buffer.concat([tail, marker]) : tail
  writeFileSync(logPath, bounded)
  logBytes = bounded.length
}

writeFileSync(logPath, "")
const child = spawn(cli, ["ui", "--no-open"], {
  cwd: home || undefined,
  env: {
    ...process.env,
    ...(home ? { HOME: home } : {})
  },
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
  windowsHide: true,
  shell: process.platform === "win32" && /\.cmd$/i.test(cli)
})

function removeOwnState() {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"))
    if (state.pid === process.pid) rmSync(statePath, { force: true })
  } catch {
    // The opener may not have written state yet, or a newer runner owns it.
  }
}

let stopping = false
function stopChild() {
  stopping = true
  clearInterval(stopTimer)
  rmSync(stopPath, { force: true })
  if (child.pid && process.platform === "win32") {
    const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe")
    const result = spawnSync(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true })
    if (result.status !== 0) child.kill()
  } else if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM") } catch { child.kill("SIGTERM") }
  }
  removeOwnState()
  // A .cmd shim may take a moment to report the exit after its process tree is stopped.
  setTimeout(() => process.exit(0), 1_000).unref()
}

const stopTimer = setInterval(() => {
  if (existsSync(stopPath)) stopChild()
}, 250)

child.stdout.on("data", writeLog)
child.stderr.on("data", writeLog)
child.once("error", (error) => {
  writeLog(`\nToken Harness failed to start: ${error.message}\n`)
  process.exit(1)
})
child.once("close", (code) => {
  clearInterval(stopTimer)
  removeOwnState()
  process.exit(stopping ? 0 : code ?? 0)
})
