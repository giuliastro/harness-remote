#!/usr/bin/env node
import path from "node:path"
import { AcpHarnessDriver } from "./acp-harness-driver.js"
import { AcpTransport } from "./acp-transport.js"
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
  const profile = harnessProfile(config.harness)
  const acp = new AcpTransport({
    process: profile.process(config),
    auth: profile.auth,
    permissionMode: profile.permissionMode
  })
  const driver = new AcpHarnessDriver(acp, {
    versionProcess: profile.versionProcess(config),
    snapshotDirectory: path.join(config.stateDirectory, profile.id),
    historyLoader: profile.historyLoader
  })
  const server = createBridgeServer({ config, driver, capabilities: profile.capabilities })
  let shuttingDown = false

  acp.on("stderr", (line) => process.stderr.write(`[${profile.id}] ${line}`))
  acp.on("agent-request", (message) => {
    if (message.method !== "session/request_permission") {
      process.stderr.write(`[${profile.id}] declined unsupported agent request: ${message.method}\n`)
    }
  })
  acp.on("exit", (error) => {
    if (!shuttingDown) process.stderr.write(`[${profile.id}] ${error.message}\n`)
  })

  server.listen(config.port, config.host, () => {
    process.stdout.write(`${profile.label} bridge listening on http://${config.host}:${config.port}\n`)
  })

  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    server.close()
    acp.close()
    const forcedExit = setTimeout(() => process.exit(1), 5_000)
    forcedExit.unref()
    await driver.flushSnapshots()
    clearTimeout(forcedExit)
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}
