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
  codex: ["codex"]
}

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

export function findExecutable(name, { pathValue = process.env.PATH ?? "", platform = process.platform, exists = fs.existsSync } = {}) {
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const candidate of executableNames(name, platform)) {
      if (exists(path.join(directory, candidate))) return path.join(directory, candidate)
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
    throw new Error(`Multiple supported agents detected (${detected.join(", ")}). Re-run with --backend <${detected.join("|")}>.`)
  }
  throw new Error("No supported agent CLI was detected on PATH. Re-run with --backend <omp|pi|claude|codex> to select an ACP backend explicitly.")
}

export function generateCredentials() {
  return {
    username: "harness",
    password: randomBytes(18).toString("base64url")
  }
}

export function buildBridgeArgs(args, { backend, host, port, username, password }) {
  const result = [...args]
  if (!hasOption(result, "--backend")) result.push("--backend", backend)
  if (!hasOption(result, "--host")) result.push("--host", host)
  if (!hasOption(result, "--port")) result.push("--port", String(port))
  if (!hasOption(result, "--username") && username) result.push("--username", username)
  if (!hasOption(result, "--password") && password) result.push("--password", password)
  return result
}

function canListen(port, host) {
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

function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address
    }
  }
  return null
}

export function launcherUsage() {
  return `Usage: harness-remote [options]\n\nQuick start options:\n  --backend <name>       Select omp, pi, claude, or codex (auto-detected when unambiguous)\n  --host <host>          Bind host (quick-start default: 0.0.0.0)\n  --port <port>          Preferred port (quick-start default: first free port from 4097)\n  --username <username>  Override generated Basic Auth username\n  --password <password>  Override generated Basic Auth password\n  --help                 Show this help\n\nAll other options are forwarded to harness-remote-bridge.`
}

async function main() {
  const args = process.argv.slice(2)
  if (hasOption(args, "--help")) {
    process.stdout.write(`${launcherUsage()}\n`)
    return
  }

  const backend = resolveBackend(args)
  const host = optionValue(args, "--host") ?? "0.0.0.0"
  const requestedPort = Number(optionValue(args, "--port") ?? 4097)
  if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535")
  }
  const port = hasOption(args, "--port") ? requestedPort : await findAvailablePort(requestedPort, host)

  let username = optionValue(args, "--username")
  let password = optionValue(args, "--password")
  if (Boolean(username) !== Boolean(password)) {
    throw new Error("--username and --password must be supplied together")
  }
  const loopback = new Set(["127.0.0.1", "::1", "localhost"]).has(host)
  if (!loopback && !username) ({ username, password } = generateCredentials())

  const bridgeArgs = buildBridgeArgs(args, { backend, host, port, username, password })
  const address = host === "0.0.0.0" ? lanAddress() : host

  process.stdout.write("Harness Remote quick start\n")
  process.stdout.write(`Backend: ${backend}\n`)
  process.stdout.write(`Port: ${port}\n`)
  if (address) process.stdout.write(`Connect to: http://${address}:${port}\n`)
  else process.stdout.write(`Listening on ${host}:${port}; use this machine's LAN address in the client.\n`)
  if (username) {
    process.stdout.write(`Username: ${username}\n`)
    process.stdout.write(`Password: ${password}\n`)
  }
  process.stdout.write("\nStarting existing bridge...\n")

  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url))
  const child = spawn(process.execPath, [cliPath, ...bridgeArgs], { stdio: "inherit" })
  child.once("error", (error) => {
    process.stderr.write(`Failed to start bridge: ${error.message}\n`)
    process.exitCode = 1
  })
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n\n${launcherUsage()}\n`)
    process.exitCode = 1
  })
}
