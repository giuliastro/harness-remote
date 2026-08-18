#!/usr/bin/env node
import path from "node:path"
import { AcpClient } from "./acp-client.js"
import { AcpAgentModelCatalog, HttpAgentModelCatalog } from "./agent-model-catalog.js"
import { parseConfig, usage as bridgeUsage } from "./config.js"
import { harnessProfile, resolveAcpLaunch } from "./harness-profiles.js"
import { canListen, resolveLaunchPlan } from "./launcher.js"
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

export function parseDaemonOptions(args, environment = process.env, detect = resolveLaunchPlan) {
  const bridgeArgs = []
  const options = {
    openCode: true,
    openCodeCommand: environment.HARNESS_REMOTE_OPENCODE_COMMAND ?? "opencode",
    openCodeHost: environment.HARNESS_REMOTE_OPENCODE_HOST ?? "127.0.0.1",
    openCodePort: parsePort(environment.HARNESS_REMOTE_OPENCODE_PORT ?? "4096", "--opencode-port"),
    openCodeTimeout: Number(environment.HARNESS_REMOTE_OPENCODE_TIMEOUT ?? "15000")
  }

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (option === "--no-opencode") {
      options.openCode = false
      continue
    }
    if (option === "--opencode-timeout") {
      const value = Number(requireValue(args, index, option))
      if (!Number.isInteger(value) || value < 1000) throw new Error("--opencode-timeout must be at least 1000 (milliseconds)")
      options.openCodeTimeout = value
      index += 1
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

  // `parseConfig` defaults the backend to `omp` for the standalone bridge, where one server is one
  // harness and the user names it. A daemon is started once per machine and is expected to work out
  // what that machine has: without this, a phone with PI and OpenCode installed announced `omp` as
  // its primary agent and then failed with `spawn omp ENOENT`. Resolve from PATH the way the
  // launcher already does — it owns the ACP preference order — and let its message explain a
  // machine with nothing installed rather than starting up and failing later.
  const named = bridgeArgs.includes("--backend") || environment.HARNESS_REMOTE_BACKEND || environment.OMP_BRIDGE_BACKEND
  if (!named) bridgeArgs.push("--backend", detect(args).backend)

  return { config: parseConfig(bridgeArgs, environment), ...options }
}

export function daemonUsage() {
  return `${bridgeUsage()}\n\nMulti-host daemon options:\n  --opencode-command <path>  OpenCode executable (default: opencode)\n  --opencode-host <host>     Managed OpenCode bind host (default: 127.0.0.1)\n  --opencode-port <port>     Managed OpenCode port (default: 4096)\n  --opencode-timeout <ms>    How long managed OpenCode may take to become ready (default: 15000)\n  --no-opencode              Start only the primary ACP host`
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

  const { config, openCode, openCodeCommand, openCodeHost, openCodePort, openCodeTimeout } = parsed
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
  const plan = resolveLaunchPlan(process.argv.slice(2))
  const acpBackends = [...new Set([...plan.detected.filter((backend) => backend !== "opencode"), config.backend])]
  const primaryProfile = harnessProfile(config.backend)
  const acpHosts = new Map()
  for (const backend of acpBackends) {
    const profile = harnessProfile(backend)
    const launch = backend === config.backend
      ? { command: config.acpCommand, args: config.acpArgs }
      : resolveAcpLaunch(profile)
    const agentConfig = { ...config, backend: profile.id, acpCommand: launch.command, acpArgs: launch.args }
    const acp = new AcpClient({
      command: launch.command,
      args: launch.args,
      permissionMode: profile.permissionMode,
      preferredAuthMethod: profile.authMethod
    })
    // Model discovery owns a separate ACP connection and one durable prompt-less session. That keeps
    // New Task catalog refreshes from interfering with user-facing ACP session history.
    const modelCatalog = new AcpAgentModelCatalog({
      agent: new AcpClient({ command: launch.command, args: launch.args, permissionMode: profile.permissionMode, preferredAuthMethod: profile.authMethod }),
      agentID: profile.id,
      directory: config.roots?.[0] ?? process.cwd(),
      stateDirectory: config.stateDirectory
    })
    // Load persisted technical-session ids before the server starts, so they never leak into lists.
    await modelCatalog.preloadState()
    daemon.registerAcpHost({
      id: profile.id,
      label: profile.label,
      backend: profile.id,
      capabilities: profile.capabilities,
      agent: acp,
      modelCatalog,
      bridgeConfig: agentConfig,
      serviceOptions: {
        snapshotDirectory: path.join(config.stateDirectory, profile.id),
        historyLoader: profile.historyLoader,
        preserveListedTimestamps: profile.preserveListedTimestamps,
        hiddenSessionIDs: modelCatalog.hiddenSessionIDs,
        reloadOnHistoryRefresh: profile.reloadOnHistoryRefresh,
        replaySettleMs: profile.replaySettleMs
      }
    })
    acpHosts.set(profile.id, acp)
    acp.on("stderr", (line) => process.stderr.write(`[${profile.id}] ${line}\n`))
    acp.on("exit", (error) => process.stderr.write(`[${profile.id}] ${error.message}\n`))
  }
  const acp = acpHosts.get(primaryProfile.id)
  if (!acp) throw new Error(`Primary harness ${primaryProfile.id} was not detected`)

  if (openCode) {
    const managedOpenCode = new ManagedOpenCodeHost({
      command: openCodeCommand,
      host: openCodeHost,
      port: openCodePort,
      username: config.username,
      password: config.password,
      startTimeoutMs: openCodeTimeout
    })
    const openCodeModels = new HttpAgentModelCatalog({ host: managedOpenCode, agentID: "opencode" })
    daemon.registerManagedHttpHost({
      id: "opencode",
      label: "OpenCode",
      backend: "opencode",
      capabilities: { sessions: true },
      host: managedOpenCode,
      modelCatalog: openCodeModels
    })
  }

  const server = createMachineDaemonServer({
    daemon,
    config,
    primaryAcp: acp,
    serviceOptions: {
      snapshotDirectory: path.join(config.stateDirectory, primaryProfile.id),
      historyLoader: primaryProfile.historyLoader,
      preserveListedTimestamps: primaryProfile.preserveListedTimestamps,
      hiddenSessionIDs: daemon.hostEntry(primaryProfile.id).modelCatalog.hiddenSessionIDs,
      reloadOnHistoryRefresh: primaryProfile.reloadOnHistoryRefresh,
      replaySettleMs: primaryProfile.replaySettleMs
    }
  })

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once("error", onError)
    server.listen(config.port, config.host, () => {
      server.off("error", onError)
      resolve()
    })
  })

  const managedResults = await daemon.startManagedHosts()
  process.stdout.write(`Harness daemon ready at http://${config.host}:${config.port}\n`)
  process.stdout.write(`Machine: ${identity.name} (${identity.id})\n`)
  process.stdout.write("Active agents:\n")
  for (const host of daemon.snapshot().agents) {
    if (host.id === primaryProfile.id) {
      process.stdout.write(`  • ${host.label} — primary (${host.transport.toUpperCase()})\n`)
      continue
    }
    process.stdout.write(`  • ${host.label} — managed ${host.transport.toUpperCase()}, ${host.state}\n`)
  }
  for (const result of managedResults) {
    if (result.status !== "available") process.stderr.write(`[${result.id}] unavailable: ${result.error?.message ?? "startup failed"}\n`)
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
