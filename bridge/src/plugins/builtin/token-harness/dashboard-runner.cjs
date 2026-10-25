const { spawn } = require("node:child_process")
const { createWriteStream } = require("node:fs")

// Long-lived bridge between a detached Token Harness UI server and the one-shot plugin process.
// Keeping the child's output in a real file avoids Windows cmd redirection quirks and lets the
// plugin read the ready URL without keeping the one-shot process alive.
const [cli, logPath, home] = process.argv.slice(2)
if (!cli || !logPath) process.exit(2)

const log = createWriteStream(logPath, { flags: "w" })
const child = spawn(cli, ["ui", "--no-open"], {
  cwd: home || undefined,
  env: {
    ...process.env,
    ...(home ? { HOME: home } : {})
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  shell: process.platform === "win32" && /\.cmd$/i.test(cli)
})

child.stdout.pipe(log, { end: false })
child.stderr.pipe(log, { end: false })
child.once("error", (error) => {
  log.write(`\nToken Harness failed to start: ${error.message}\n`)
  log.end()
  process.exit(1)
})
child.once("exit", (code) => {
  log.end()
  process.exit(code ?? 0)
})
