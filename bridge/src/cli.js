#!/usr/bin/env node
import path from "node:path"
import { AcpClient } from "./acp-client.js"
import { parseConfig, usage } from "./config.js"
import { harnessProfile } from "./harness-profiles.js"
import { loadMachineIdentity, MachineRegistry, trackAgentHostLifecycle } from "./machine-registry.js"
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
  const machineIdentity = await loadMachineIdentity(config.stateDirectory)
  const machineRegistry = new MachineRegistry(machineIdentity)
  machineRegistry.registerHost({
    id: profile.id,
    label: profile.label,
    backend: profile.id,
    transport: "acp",
    state: "configured",
    capabilities: profile.capabilities
  })

  const acp = trackAgentHostLifecycle(
    new AcpClient({ command: config.acpCommand, args: config.acpArgs, permissionMode: profile.permissionMode, preferredAuthMethod: profile.authMethod }),
    machineRegistry,
    profile.id
  )
  const server = createBridgeServer({
    config,
    acp,
    machineRegistry,
    serviceOptions: {
      snapshotDirectory: path.join(config.stateDirectory, profile.id),
      historyLoader: profile.historyLoader,
      preserveListedTimestamps: profile.preserveListedTimestamps,
      reloadOnHistoryRefresh: profile.reloadOnHistoryRefresh
    }
  })
  let shuttingDown = false

  acp.on("stderr", (line) => process.stderr.write(`[${config.backend}] ${line}\n`))
  acp.on("permission", ({ optionId }) => {
    process.stderr.write(`[${config.backend}] granted tool permission (${optionId ?? "none offered"})\n`)
  })
  acp.on("agent-request", (message) => {
    process.stderr.write(`[${config.backend}] handled agent request: ${message.method}\n`)
  })
  acp.on("exit", (error) => {
    if (!shuttingDown) process.stderr.write(`[${config.backend}] ${error.message}\n`)
  })

  server.listen(config.port, config.host, () => {
    process.stdout.write(`${config.backend.toUpperCase()} bridge listening on http://${config.host}:${config.port}\n`)
    process.stdout.write(`Machine: ${machineIdentity.name} (${machineIdentity.id})\n`)
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
