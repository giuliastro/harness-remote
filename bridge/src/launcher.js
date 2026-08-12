#!/usr/bin/env node
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import { networkInterfaces } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const BACKEND_EXECUTABLES = {
  omp: ["omp"],
  pi: ["pi"],
  claude: ["claude"],
  codex: ["codex"],
  opencode: ["opencode"]
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"])
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

export function buildBridgeArgs(args, { backend, host, port }) {
  let result = stripOptionWithValue(args, "--username")
  result = stripOptionWithValue(result, "--password")
  if (!hasOption(result, "--backend")) result.push("--backend", backend)
  if (!hasOption(result, "--host")) result.push("--host", host)
  if (!hasOption(result, "--port")) result.push("--port", String(port))
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

export async function findAvailablePort(startPort = 4097, host = "0.0.0.0", attempts = 20) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = startPort + offset
    if (port > 65_535) break
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
  return `Usage: harness-remote [options]\n\nQuick start options:\n  --backend <name>       Select omp, pi, claude, codex, or opencode (auto-detected when unambiguous)\n  --host <host>          Bind host (quick-start default: 0.0.0.0)\n  --port <port>          Preferred port (quick-start default: first free port from 4097)\n  --username <username>  Override generated Basic Auth username\n  --password <password>  Override generated Basic Auth password\n  --help                 Show this help\n\nAll other options are forwarded to harness-remote-bridge for ACP-backed agents.`
}

function openCodeGuidance({ host, port, username, password }) {
  return `OpenCode was found on PATH. OpenCode connects directly to Harness Remote and does not use the ACP bridge.\n\nStart it directly:\n\n  OPENCODE_SERVER_USERNAME=${username} OPENCODE_SERVER_PASSWORD=${password} opencode serve --hostname ${host} --port ${port}\n\nThen select the OpenCode backend in Harness Remote and use the address/credentials above.`
}

async function main() {
  const args = process.argv.slice(2)
  if (hasOption(args, "--help")) {
    process.stdout.write(`${launcherUsage()}\n`)
    return
  }

  const backend = resolveBackend(args)
  const host = optionValue(args, "--host") ?? "0.0.0.0"
  const defaultPort = backend === "opencode" ? 4096 : 4097
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

  let username = optionValue(args, "--username")
  let password = optionValue(args, "--password")
  if (Boolean(username) !== Boolean(password)) {
    throw new Error("--username and --password must be supplied together")
  }
  if (!username) ({ username, password } = generateCredentials())

  const addresses = host === "0.0.0.0" ? lanAddresses() : [host]

  process.stdout.write("Harness Remote quick start\n")
  process.stdout.write(`Backend: ${backend}\n`)
  process.stdout.write(`Port: ${port}\n`)
  if (addresses.length) {
    for (const address of addresses) process.stdout.write(`Connect to: http://${address}:${port}\n`)
  } else {
    process.stdout.write(`Listening on ${host}:${port}; use this machine's LAN address in the client.\n`)
  }
  process.stdout.write(`Username: ${username}\n`)
  process.stdout.write(`Password: ${password}\n`)

  if (backend === "opencode") {
    process.stdout.write(`\n${openCodeGuidance({ host, port, username, password })}\n`)
    return
  }

  const bridgeArgs = buildBridgeArgs(args, { backend, host, port })
  process.stdout.write("\nStarting existing bridge...\n")

  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url))
  const child = spawn(process.execPath, [cliPath, ...bridgeArgs], {
    stdio: "inherit",
    env: bridgeEnvironment(process.env, username, password)
  })
  child.once("error", (error) => {
    process.stderr.write(`Failed to start bridge: ${error.message}\n`)
    process.exitCode = 1
  })
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
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
