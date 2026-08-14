#!/usr/bin/env node
import path from "node:path"
import { AcpClient } from "./acp-client.js"
import { parseConfig, usage as bridgeUsage } from "./config.js"
import { harnessProfile } from "./harness-profiles.js"
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

/**
 * No constant default. A daemon started without `--backend` used to select `omp` whether or not it
 * was installed, so a machine with PI and OpenCode on it announced `omp` as its primary and then
 * failed with `spawn omp ENOENT`. Resolve from PATH the way the launcher does — it owns the ACP
 * preference order — and let its message explain a machine with nothing installed.
 */
function requestedBackend(args, environment, detect) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--backend") return requireValue(args, index, "--backend")
  }
  const configured = environment.HARNESS_REMOTE_BACKEND ?? environment.OMP_BRIDGE_BACKEND
  if (configured) return configured
  return detect(args).backend
}

/**
 * The standalone bridge is ACP-only, so parseConfig deliberately rejects OpenCode. The machine
 * daemon is broader: OpenCode is a managed HTTP agent and can be the only/primary agent on a
 * machine. Reuse the mature common option parser by substituting an ACP profile only while parsing
 * generic host/auth/root/state options, then restore the requested daemon backend.
 */
export function parseDaemonOptions(args, environment = process.env, detect = resolveLaunchPlan) {
  const daemonBackend = requestedBackend(args, environment, detect)
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
    if (option === "--backend") {
      const value = requireValue(args, index, option)
      bridgeArgs.push(option, value === "opencode" ? "omp" : value)
      index += 1
      continue
    }
    bridgeArgs.push(option)
    if (["--host", "--port", "--username", "--password", "--acp-command", "--acp-arg", "--root", "--cors", "--state-dir"].includes(option)) {
      bridgeArgs.push(requireValue(args, index, option))
      index += 1
    }
  }

  const parseEnvironment = daemonBackend === "opencode"
    ? { ...environment, HARNESS_REMOTE_BACKEND: "omp", OMP_BRIDGE_BACKEND: "omp" }
    : { ...environment, HARNESS_REMOTE_BACKEND: daemonBackend }
  const config = parseConfig(bridgeArgs, parseEnvironment)
  if (daemonBackend === "opencode") config.backend = "opencode"
  if (config.backend === "opencode" && !options.openCode) {
    throw new Error("--backend opencode cannot be combined with --no-opencode")
  }
  return { config, ...options }
}

export function daemonUsage() {
  return `${bridgeUsage()}\n\nMachine daemon backends:\n  --backend opencode       Run OpenCode as the primary managed agent (no ACP agent required)\n\nMulti-host daemon options:\n  --opencode-command <path>  OpenCode executable (default: opencode)\n  --opencode-host <host>     Internal managed OpenCode bind host (default: 127.0.0.1)\n  --opencode-port <port>     Internal managed OpenCode port (default: 4096)\n  --opencode-timeout <ms>    How long managed OpenCode may take to become ready (default: 15000)\n  --no-opencode              Start only the primary ACP host`
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
  const openCodeOnly = config.backend === "opencode"
  const profile = openCodeOnly ? undefined : harnessProfile(config.backend)
  const acp = profile ? new AcpClient({
    command: config.acpCommand,
    args: config.acpArgs,
    permissionMode: profile.permissionMode,
    preferredAuthMethod: profile.authMethod
  }) : undefined

  if (profile && acp) {
    daemon.registerAcpHost({
      id: profile.id,
      label: profile.label,
      backend: profile.id,
      capabilities: profile.capabilities,
      agent: acp
    })
  }

  if (openCode) {
    const managedOpenCode = new ManagedOpenCodeHost({
      command: openCodeCommand,
      host: openCodeHost,
      port: openCodePort,
      username: config.username,
      password: config.password,
      startTimeoutMs: openCodeTimeout
    })
    daemon.registerManagedHttpHost({
      id: "opencode",
      label: "OpenCode",
      backend: "opencode",
      capabilities: { sessions: true, prompt: true, abort: true, streaming: true, diff: true, filesystemBrowser: true },
      host: managedOpenCode
    })
  }

  const primaryAgentID = openCodeOnly ? "opencode" : profile.id
  const server = createMachineDaemonServer({
    daemon,
    config,
    primaryAcp: acp,
    primaryAgentID,
    serviceOptions: profile ? {
      snapshotDirectory: path.join(config.stateDirectory, profile.id),
      historyLoader: profile.historyLoader,
      preserveListedTimestamps: profile.preserveListedTimestamps,
      reloadOnHistoryRefresh: profile.reloadOnHistoryRefresh
    } : undefined
  })

  if (profile && acp) {
    acp.on("stderr", (line) => process.stderr.write(`[${profile.id}] ${line}\n`))
    acp.on("exit", (error) => process.stderr.write(`[${profile.id}] ${error.message}\n`))
  }

  server.listen(config.port, config.host, () => {
    process.stdout.write(`Harness daemon listening on http://${config.host}:${config.port}\n`)
    process.stdout.write(`Machine: ${identity.name} (${identity.id})\n`)
    if (openCode) process.stdout.write(`Managed OpenCode: http://${openCodeHost}:${openCodePort} (internal — reach it through the daemon port)\n`)
    // Which adapter an ACP agent is about to run is the single most useful line when it fails to
    // start: it separates "the adapter you installed is broken" from "we tried to fetch one".
    // OpenCode-only machines have no adapter, so they just name the primary.
    process.stdout.write(profile
      ? `Primary agent: ${primaryAgentID} (adapter: ${[config.acpCommand, ...config.acpArgs].join(" ")})\n`
      : `Primary agent: ${primaryAgentID}\n`)
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

const invokedAsDaemonCli = process.argv[1] && (
  process.argv[1].endsWith("daemon-cli.js") || path.basename(process.argv[1]) === "harness-remote-daemon"
)

if (invokedAsDaemonCli) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
