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

export function codexAdapterEnvironment({ environment = process.env, find = findCodexExecutable } = {}) {
  // An explicit adapter override remains authoritative, including its error reporting.
  if (environment.CODEX_PATH) return { CODEX_PATH: environment.CODEX_PATH }
  const command = find({ pathValue: environment.PATH ?? "" })
  // Without an installed binary the adapter retains its bundled Codex fallback.
  return command ? { CODEX_PATH: command } : {}
}
