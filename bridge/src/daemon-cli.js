#!/usr/bin/env node
import path from "node:path"
import { AcpClient } from "./acp-client.js"
import { parseConfig, usage as bridgeUsage } from "./config.js"
import { harnessProfile } from "./harness-profiles.js"
import { canListen } from "./launcher.js"
import { loadMachineIdentity } from "./machine-registry.js"
import { MachineDaemon, createMachineDaemonServer } from "./machine-daemon.js"
import { ManagedOpenCodeHost } from "./opencode-host.js"

function requireValue(args, index, option) {
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`)
  return value
}

function parsePort(value, option) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${option} must be an integer between 1 and 65535`)
  return port
}

export function parseDaemonOptions(args, environment = process.env) {
  const bridgeArgs = []
  const options = {
    openCode: true,
    openCodeCommand: environment.HARNESS_REMOTE_OPENCODE_COMMAND ?? "opencode",
    openCodeHost: environment.HARNESS_REMOTE_OPENCODE_HOST ?? "127.0.0.1",
    openCodePort: parsePort(environment.HARNESS_REMOTE_OPENCODE_PORT ?? "4096", "--opencode-port")
  }

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (option === "--no-opencode") {
      options.openCode = false
      continue
    }
    if (option === "--opencode-command") {
      options.openCodeCommand = requireValue(args, index, option)
      index += 1
      continue
    }
    if (option === "--opencode-host") {
      options.openCodeHost = requireValue(args, index, option)
      index += 1
      continue
    }
    if (option === "--opencode-port") {
      options.openCodePort = parsePort(requireValue(args, index, option), option)
      index += 1
      continue
    }
    bridgeArgs.push(option)
    if (["--backend", "--host", "--port", "--username", "--password", "--acp-command", "--acp-arg", "--root", "--cors", "--state-dir"].includes(option)) {
      bridgeArgs.push(requireValue(args, index, option))
      index += 1
    }
  }

  return { config: parseConfig(bridgeArgs, environment), ...options }
}

export function daemonUsage() {
  return `${bridgeUsage()}\n\nMulti-host daemon options:\n  --opencode-command <path>  OpenCode executable (default: opencode)\n  --opencode-host <host>     Managed OpenCode bind host (default: 127.0.0.1)\n  --opencode-port <port>     Managed OpenCode port (default: 4096)\n  --no-opencode              Start only the primary ACP host`
}

export async function ensureOpenCodePortAvailable({ port, host, canListenImpl = canListen }) {
  if (await canListenImpl(port, host)) return
  throw new Error(`OpenCode port ${port} is already in use on ${host}. Is OpenCode already running? Use --opencode-port to choose another.`)
}

async function main() {
  let parsed
  try {
    parsed = parseDaemonOptions(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${daemonUsage()}\n`)
    process.exitCode = 1
    return
  }

  const { config, openCode, openCodeCommand, openCodeHost, openCodePort } = parsed
  if (config.help) {
    process.stdout.write(`${daemonUsage()}\n`)
    return
  }

  if (openCode && openCodePort === config.port) {
    throw new Error(`OpenCode port ${openCodePort} conflicts with the Harness daemon port`)
  }
  if (openCode) await ensureOpenCodePortAvailable({ port: openCodePort, host: openCodeHost })

  const identity = await loadMachineIdentity(config.stateDirectory)
  const daemon = new MachineDaemon(identity)
  const profile = harnessProfile(config.backend)
  const acp = new AcpClient({
    command: config.acpCommand,
    args: config.acpArgs,
    permissionMode: profile.permissionMode,
    preferredAuthMethod: profile.authMethod
  })

  daemon.registerAcpHost({
    id: profile.id,
    label: profile.label,
    backend: profile.id,
    capabilities: profile.capabilities,
    agent: acp
  })

  if (openCode) {
    const managedOpenCode = new ManagedOpenCodeHost({
      command: openCodeCommand,
      host: openCodeHost,
      port: openCodePort,
      username: config.username,
      password: config.password
    })
    daemon.registerManagedHttpHost({
      id: "opencode",
      label: "OpenCode",
      backend: "opencode",
      capabilities: { sessions: true },
      host: managedOpenCode
    })
  }

  const server = createMachineDaemonServer({
    daemon,
    config,
    primaryAcp: acp,
    serviceOptions: {
      snapshotDirectory: path.join(config.stateDirectory, profile.id),
      historyLoader: profile.historyLoader,
      preserveListedTimestamps: profile.preserveListedTimestamps,
      reloadOnHistoryRefresh: profile.reloadOnHistoryRefresh
    }
  })

  acp.on("stderr", (line) => process.stderr.write(`[${profile.id}] ${line}`))
  acp.on("exit", (error) => process.stderr.write(`[${profile.id}] ${error.message}\n`))

  server.listen(config.port, config.host, () => {
    process.stdout.write(`Harness daemon listening on http://${config.host}:${config.port}\n`)
    process.stdout.write(`Machine: ${identity.name} (${identity.id})\n`)
    if (openCode) process.stdout.write(`Managed OpenCode endpoint: http://${openCodeHost}:${openCodePort}\n`)
    for (const host of daemon.snapshot().agents) {
      process.stdout.write(`${host.state === "available" ? "✓" : "•"} ${host.label} [${host.transport}] ${host.state}\n`)
    }
  })

  const managedResults = await daemon.startManagedHosts()
  for (const result of managedResults) {
    if (result.status === "available") process.stdout.write(`[${result.id}] available\n`)
    else process.stderr.write(`[${result.id}] unavailable: ${result.error?.message ?? "startup failed"}\n`)
  }

  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    daemon.close()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 5_000).unref()
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

if (process.argv[1]?.endsWith("daemon-cli.js")) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
