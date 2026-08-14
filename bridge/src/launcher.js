#!/usr/bin/env node
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import { networkInterfaces } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { ManagedOpenCodeHost } from "./opencode-host.js"

const BACKEND_EXECUTABLES = {
  omp: ["omp"],
  pi: ["pi"],
  claude: ["claude"],
  codex: ["codex"],
  opencode: ["opencode"]
}

// This is product policy, not alphabetical order: prefer the broadest/most-tested ACP path first.
// Reordering this changes the default primary on every multi-agent machine.
const ACP_BACKENDS = ["codex", "claude", "omp", "pi"]
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|tun|tap|utun)/i

function optionValue(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function hasOption(args, name) {
  return args.includes(name)
}

function executableNames(name, platform = process.platform) {
  if (platform !== "win32") return [name]
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase())
  return [name, ...extensions.map((extension) => `${name}${extension}`)]
}

function executable(candidate, { platform = process.platform, exists = fs.existsSync, access = fs.accessSync } = {}) {
  if (!exists(candidate)) return false
  if (platform === "win32") return true
  try {
    access(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function findExecutable(name, { pathValue = process.env.PATH ?? "", platform = process.platform, exists = fs.existsSync, access = fs.accessSync } = {}) {
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const candidate of executableNames(name, platform)) {
      const fullPath = path.join(directory, candidate)
      if (executable(fullPath, { platform, exists, access })) return fullPath
    }
  }
  return null
}

export function detectBackends(options = {}) {
  return Object.entries(BACKEND_EXECUTABLES)
    .filter(([, commands]) => commands.some((command) => findExecutable(command, options)))
    .map(([backend]) => backend)
}

export function resolveBackend(args, detected = detectBackends()) {
  const explicit = optionValue(args, "--backend")
  if (explicit) return explicit
  if (detected.length === 1) return detected[0]
  if (detected.length > 1) {
    throw new Error(`Multiple supported agent CLIs were found on PATH (${detected.join(", ")}). Re-run with --backend <${detected.join("|")}>.`)
  }
  throw new Error("No supported agent CLI was found on PATH. Install/select omp, pi, claude, codex, or opencode, then re-run with --backend if needed.")
}

/** Choose the low-friction startup shape without executing any discovered CLI. */
export function resolveLaunchPlan(args, detected = detectBackends()) {
  const explicit = optionValue(args, "--backend")
  const forceSingle = hasOption(args, "--single")

  if (detected.length === 0) {
    if (explicit) return { mode: "single", backend: explicit, detected }
    throw new Error("No supported agent CLI was found on PATH. Install/select omp, pi, claude, codex, or opencode, then re-run with --backend if needed.")
  }

  if (forceSingle) {
    const backend = explicit ?? (detected.length === 1 ? detected[0] : null)
    if (!backend) {
      throw new Error(`--single requires --backend when multiple supported agent CLIs are installed (${detected.join(", ")}).`)
    }
    return { mode: "single", backend, detected }
  }

  if (detected.length === 1) return { mode: "single", backend: explicit ?? detected[0], detected }

  if (explicit === "opencode") return { mode: "single", backend: explicit, detected }
  if (explicit && !ACP_BACKENDS.includes(explicit)) {
    throw new Error(`Unsupported ACP backend '${explicit}' for machine-daemon startup.`)
  }

  const primary = explicit ?? ACP_BACKENDS.find((backend) => detected.includes(backend))
  if (!primary) return { mode: "single", backend: detected[0], detected }
  return {
    mode: "daemon",
    backend: primary,
    detected,
    openCode: detected.includes("opencode")
  }
}

export function generateCredentials() {
  return {
    username: "harness",
    password: randomBytes(18).toString("base64url")
  }
}

function stripOptionWithValue(args, option) {
  const result = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === option) {
      index += 1
      continue
    }
    result.push(args[index])
  }
  return result
}

function stripFlag(args, option) {
  return args.filter((value) => value !== option)
}

export function buildBridgeArgs(args, { backend, host, port }) {
  let result = stripOptionWithValue(args, "--username")
  result = stripOptionWithValue(result, "--password")
  result = stripFlag(result, "--single")
  if (!hasOption(result, "--backend")) result.push("--backend", backend)
  if (!hasOption(result, "--host")) result.push("--host", host)
  if (!hasOption(result, "--port")) result.push("--port", String(port))
  return result
}

export function buildDaemonArgs(args, { backend, host, port, openCode, openCodePort }) {
  const result = buildBridgeArgs(args, { backend, host, port })
  if (openCode && openCodePort && !hasOption(result, "--opencode-port")) {
    result.push("--opencode-port", String(openCodePort))
  }
  if (!openCode && !hasOption(result, "--no-opencode")) result.push("--no-opencode")
  return result
}

export function bridgeEnvironment(environment, username, password) {
  return {
    ...environment,
    HARNESS_REMOTE_USERNAME: username,
    HARNESS_REMOTE_PASSWORD: password
  }
}

export function canListen(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.unref()
    probe.once("error", () => resolve(false))
    probe.listen(port, host, () => probe.close(() => resolve(true)))
  })
}

export async function findAvailablePort(startPort = 4097, host = "0.0.0.0", attempts = 20, excludedPorts = []) {
  const excluded = new Set(excludedPorts)
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = startPort + offset
    if (port > 65_535) break
    if (excluded.has(port)) continue
    if (await canListen(port, host)) return port
  }
  throw new Error(`No available port found from ${startPort} through ${Math.min(65_535, startPort + attempts - 1)}.`)
}

export function lanAddresses(interfaces = networkInterfaces()) {
  const candidates = []
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) candidates.push({ name, address: address.address })
    }
  }
  const preferred = candidates.filter(({ name }) => !VIRTUAL_INTERFACE.test(name))
  return [...new Set((preferred.length ? preferred : candidates).map(({ address }) => address))]
}

export function launcherUsage() {
  return `Usage: harness-remote [options]\n\nQuick start options:\n  --backend <name>       Select omp, pi, claude, codex, or opencode (on multi-agent machines, selects the daemon primary)\n  --single               Force the legacy single-backend path instead of the machine daemon\n  --host <host>          Bind host (quick-start default: 0.0.0.0)\n  --port <port>          Preferred port (OpenCode single-host default: 4096; daemon/ACP default: 4097)\n  --username <username>  Override generated Basic Auth username\n  --password <password>  Override generated Basic Auth password\n  --help                 Show this help\n\nWith one detected agent, Harness starts the existing single-backend path. With multiple detected agents and at least one ACP backend, it starts the machine daemon automatically; OpenCode is included when installed and receives a free loopback port automatically.`
}

export async function startManagedOpenCode({ host, port, username, password, command = "opencode", Host = ManagedOpenCodeHost } = {}) {
  const managed = new Host({ command, host, port, username, password })
  await managed.start()
  return managed
}

export function createManagedShutdown(managed, processObject = process) {
  let signalCount = 0
  let exitCode = 0
  return (signal) => {
    signalCount += 1
    if (signalCount === 1) {
      exitCode = signal === "SIGINT" ? 130 : 143
      processObject.exitCode = exitCode
      managed.stop("SIGTERM")
      return
    }
    managed.stop("SIGKILL")
    processObject.exit(exitCode || 1)
  }
}

function spawnNodeEntrypoint(entrypoint, args, username, password) {
  const child = spawn(process.execPath, [entrypoint, ...args], {
    stdio: "inherit",
    env: bridgeEnvironment(process.env, username, password)
  })
  child.once("error", (error) => {
    process.stderr.write(`Failed to start Harness runtime: ${error.message}\n`)
    process.exitCode = 1
  })
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
  return child
}

async function main() {
  const args = process.argv.slice(2)
  if (hasOption(args, "--help")) {
    process.stdout.write(`${launcherUsage()}\n`)
    return
  }

  const plan = resolveLaunchPlan(args)
  const backend = plan.backend
  const host = optionValue(args, "--host") ?? "0.0.0.0"
  const defaultPort = plan.mode === "daemon" ? 4097 : backend === "opencode" ? 4096 : 4097
  const requestedPort = Number(optionValue(args, "--port") ?? defaultPort)
  if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535")
  }

  let port
  if (hasOption(args, "--port")) {
    if (!(await canListen(requestedPort, host))) {
      throw new Error(`Port ${requestedPort} is not available on ${host}. Choose another port or omit --port for automatic selection.`)
    }
    port = requestedPort
  } else {
    port = await findAvailablePort(requestedPort, host)
  }

  let openCodePort
  if (plan.mode === "daemon" && plan.openCode) {
    const explicitOpenCodePort = optionValue(args, "--opencode-port")
    if (explicitOpenCodePort) {
      openCodePort = Number(explicitOpenCodePort)
      if (!Number.isInteger(openCodePort) || openCodePort < 1 || openCodePort > 65_535) {
        throw new Error("--opencode-port must be an integer between 1 and 65535")
      }
      if (openCodePort === port || !(await canListen(openCodePort, "127.0.0.1"))) {
        throw new Error(`OpenCode port ${openCodePort} is not available. Choose another --opencode-port or omit it for automatic selection.`)
      }
    } else {
      openCodePort = await findAvailablePort(4096, "127.0.0.1", 20, [port])
    }
  }

  let username = optionValue(args, "--username")
  let password = optionValue(args, "--password")
  if (Boolean(username) !== Boolean(password)) {
    throw new Error("--username and --password must be supplied together")
  }
  if (!username) ({ username, password } = generateCredentials())

  const addresses = host === "0.0.0.0" ? lanAddresses() : [host]

  process.stdout.write("Harness Remote quick start\n\n")
  process.stdout.write("Enter this in the app:\n")
  if (addresses.length) {
    for (const address of addresses) process.stdout.write(`  Address   http://${address}:${port}\n`)
  } else {
    process.stdout.write(`  Address   http://<this machine's LAN address>:${port}\n`)
  }
  process.stdout.write(`  Username  ${username}\n`)
  process.stdout.write(`  Password  ${password}\n`)

  if (plan.mode === "daemon") {
    process.stdout.write("\nThat one connection serves every agent on this machine:\n")
    for (const agent of plan.detected) {
      if (agent === backend) process.stdout.write(`  ${agent} — primary agent\n`)
      else if (agent === "opencode" && openCodePort) {
        process.stdout.write(`  ${agent} — managed by the daemon on 127.0.0.1:${openCodePort}, internal only\n`)
      } else process.stdout.write(`  ${agent} — detected\n`)
    }
    process.stdout.write("There is nothing else to configure: no second address, no second password.\n")
  } else {
    process.stdout.write(`\nBackend: ${backend}\n`)
  }

  if (plan.mode === "daemon") {
    const daemonArgs = buildDaemonArgs(args, { backend, host, port, openCode: plan.openCode, openCodePort })
    process.stdout.write("\nStarting machine daemon...\n")
    const daemonPath = fileURLToPath(new URL("./daemon-cli.js", import.meta.url))
    spawnNodeEntrypoint(daemonPath, daemonArgs, username, password)
    return
  }

  if (backend === "opencode") {
    process.stdout.write("\nStarting managed OpenCode host...\n")
    const managed = await startManagedOpenCode({ host, port, username, password })
    process.stdout.write(`OpenCode is ready on ${host}:${port}. Keep this process running while Harness Remote is connected.\n`)

    let shuttingDown = false
    const shutdown = createManagedShutdown(managed)
    const handleSignal = (signal) => {
      shuttingDown = true
      shutdown(signal)
    }
    managed.on("unavailable", (error) => {
      if (!shuttingDown) {
        process.stderr.write(`${error.message}\n`)
        process.exitCode = 1
      }
    })
    process.on("SIGINT", () => handleSignal("SIGINT"))
    process.on("SIGTERM", () => handleSignal("SIGTERM"))
    return
  }

  const bridgeArgs = buildBridgeArgs(args, { backend, host, port })
  process.stdout.write("\nStarting existing bridge...\n")

  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url))
  spawnNodeEntrypoint(cliPath, bridgeArgs, username, password)
}

function isDirectInvocation() {
  if (!process.argv[1]) return false
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  }
}

if (isDirectInvocation()) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n\n${launcherUsage()}\n`)
    process.exitCode = 1
  })
}
