import { spawnSync } from "node:child_process"
import { findExecutable } from "./executable-discovery.js"

const COMMANDS = ["opencode2", "opencode-legacy", "opencode1", "opencode"]

/** Only a successful, bounded version probe identifies the shared executable's generation. */
export function readOpenCodeVersion(command, { platform = process.platform, environment = process.env, run = spawnSync } = {}) {
  const shim = platform === "win32" && /\.(?:cmd|bat)$/i.test(command)
  const result = run(shim ? environment.ComSpec ?? "cmd.exe" : command,
    shim ? ["/d", "/s", "/c", command, "--version"] : ["--version"], {
      encoding: "utf8", timeout: 3_000, maxBuffer: 16_384, windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"], env: environment
    })
  return !result.error && result.status === 0 ? result.stdout.trim() : ""
}

export function openCodeGeneration(version) {
  const match = /^(?:opencode\s+)?v?(\d+)\.\d+\.\d+(?:[-+][\w.-]+)?$/i.exec(version.trim())
  return match ? Number(match[1]) : null
}

export function discoverOpenCodeExecutables(options = {}) {
  const find = options.find ?? ((name) => findExecutable(name, options))
  const readVersion = options.readVersion ?? ((command) => readOpenCodeVersion(command, options))
  const seen = new Set()
  return COMMANDS.flatMap((name) => {
    const command = find(name)
    if (!command || seen.has(command)) return []
    seen.add(command)
    const version = readVersion(command)
    return [{ name, command, version, generation: openCodeGeneration(version) }]
  })
}

export function resolveOpenCodeCommand(generation, options = {}) {
  return discoverOpenCodeExecutables(options).find((candidate) => candidate.generation === generation)?.command ?? null
}

export function assertLegacyOpenCode(command, options = {}) {
  const version = (options.readVersion ?? ((value) => readOpenCodeVersion(value, options)))(command)
  if (openCodeGeneration(version) === 1) return
  throw new Error(`OpenCode Legacy requires a v1 executable; ${command} reported ${version || "an unknown version"}. Select --backend opencode2 for OpenCode 2 ACP, or provide a v1 --opencode-command.`)
}
