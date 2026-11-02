import fs from "node:fs"
import path from "node:path"
import { homedir } from "node:os"

function executableNames(name, platform = process.platform) {
  if (platform !== "win32") return [name]
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean)
    .map((extension) => extension.toLowerCase())
  // npm publishes a POSIX shim beside its .cmd shim. Windows must prefer a runnable
  // PATHEXT candidate so version probes and ACP launches never select that shell script.
  return [...extensions.map((extension) => `${name}${extension}`), name]
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

export function findCodexExecutable(options = {}) {
  const configured = options.codexPath ?? process.env.CODEX_PATH
  if (configured && executable(configured, options)) return configured
  const onPath = findExecutable("codex", options)
  if (onPath) return onPath
  const platform = options.platform ?? process.platform
  const home = options.homeDirectory ?? homedir()
  // GUI apps do not inherit the private PATH that Codex adds to its terminals.
  const candidates = platform === "linux"
    ? ["/usr/lib/chatgpt/resources/codex"]
    : platform === "darwin"
      ? ["/Applications", path.posix.join(home, "Applications")].flatMap((root) =>
        ["Codex.app", "ChatGPT.app"].map((app) => path.posix.join(root, app, "Contents/Resources/codex")))
      : []
  return candidates.find((candidate) => executable(candidate, options)) ?? null
}

/**
 * PI's installer puts its launcher in `~/.pi/agent/bin` and adds that directory to the user's
 * PATH. Windows applications (and terminals opened before the installer ran) can keep an older
 * environment for the rest of the session, which made an installed PI invisible even though its
 * Session journals were there. The history loader already treats this directory as PI's home, so
 * executable discovery uses the same fallback instead of requiring a fresh PATH.
 */
export function findPiExecutable(options = {}) {
  const configured = options.piPath ?? process.env.PI_PATH
  if (configured && executable(configured, options)) return configured
  const onPath = findExecutable("pi", options)
  if (onPath) return onPath
  const platform = options.platform ?? process.platform
  const home = options.homeDirectory ?? homedir()
  const agentDirectory = options.piAgentDirectory
    ?? process.env.PI_CODING_AGENT_DIR
    ?? path.join(home, ".pi", "agent")
  const names = platform === "win32" ? ["pi.cmd", "pi.exe", "pi.bat", "pi"] : ["pi"]
  return names
    .map((name) => path.join(agentDirectory, "bin", name))
    .find((candidate) => executable(candidate, options)) ?? null
}

export function codexAdapterEnvironment({ environment = process.env, find = findCodexExecutable } = {}) {
  // An explicit adapter override remains authoritative, including its error reporting.
  if (environment.CODEX_PATH) return { CODEX_PATH: environment.CODEX_PATH }
  const command = find({ pathValue: environment.PATH ?? "" })
  // Without an installed binary the adapter retains its bundled Codex fallback.
  return command ? { CODEX_PATH: command } : {}
}

export function findClaudeExecutable(options = {}) {
  const configured = options.claudePath ?? process.env.CLAUDE_CODE_EXECUTABLE
  if (configured && executable(configured, options)) return configured
  const onPath = findExecutable("claude", options)
  if (onPath) return onPath
  // A GUI launch can resolve a shell PATH without the private install directory used by the
  // official Claude Code installer.
  const home = options.homeDirectory ?? homedir()
  const candidate = path.join(home, ".local", "bin", "claude")
  return executable(candidate, options) ? candidate : null
}

/**
 * The Claude ACP adapter embeds the Agent SDK, whose native binary lookup can fail when npm
 * omitted optional platform packages. CLAUDE_CODE_EXECUTABLE is the SDK's documented override and
 * the installed `claude` CLI is the same executable the adapter would otherwise bundle.
 */
export function claudeAdapterEnvironment({ environment = process.env, find = findClaudeExecutable } = {}) {
  if (environment.CLAUDE_CODE_EXECUTABLE) return { CLAUDE_CODE_EXECUTABLE: environment.CLAUDE_CODE_EXECUTABLE }
  const command = find({ pathValue: environment.PATH ?? "" })
  return command ? { CLAUDE_CODE_EXECUTABLE: command } : {}
}
