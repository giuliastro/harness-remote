#!/usr/bin/env node
import { AcpClient } from "./acp-client.js"
import { parseConfig, usage } from "./config.js"
import { harnessProfile } from "./harness-profiles.js"
import { createBridgeServer } from "./server.js"

let config
try {
  config = parseConfig(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage()}\n`)
  process.exitCode = 1
}

if (config?.help) {
  process.stdout.write(`${usage()}\n`)
  process.exit(0)
}

if (config) {
  const profile = harnessProfile(config.backend)
  const acp = new AcpClient({ command: config.acpCommand, args: config.acpArgs, permissionMode: profile.permissionMode })
  const server = createBridgeServer({ config, acp })
  let shuttingDown = false

  acp.on("stderr", (line) => process.stderr.write(`[${config.backend}] ${line}`))
  acp.on("agent-request", (message) => {
    process.stderr.write(`[${config.backend}] handled agent request: ${message.method}\n`)
  })
  acp.on("exit", (error) => {
    if (!shuttingDown) process.stderr.write(`[${config.backend}] ${error.message}\n`)
  })

  server.listen(config.port, config.host, () => {
    process.stdout.write(`${config.backend.toUpperCase()} bridge listening on http://${config.host}:${config.port}\n`)
  })

  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    acp.close()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 5_000).unref()
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}
