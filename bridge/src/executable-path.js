import fs from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

/**
 * GUI launches and service managers often hand the bridge a PATH that is shorter than the one a
 * login shell would build. On Linux the native installers for OMP, OpenCode and Claude Code put
 * their launchers in `~/.local/bin` (or their own hidden bin directory), so a machine could show
 * only the one harness that happened to live in the inherited nvm/npm directory - Copilot - while
 * the others looked uninstalled.
 *
 * These directories are only appended when they exist, and only when they are not already on
 * PATH. PATH lookup then finds the real user install without changing the priority the person
 * already configured in their shell.
 */
export function userExecutableDirectories({
  platform = process.platform,
  homeDirectory = homedir(),
  environment = process.env,
  exists = fs.existsSync
} = {}) {
  const directories = platform === "win32"
    ? [
        environment.APPDATA ? path.join(environment.APPDATA, "npm") : "",
        environment.LOCALAPPDATA ? path.join(environment.LOCALAPPDATA, "Programs", "nodejs") : "",
        path.join(homeDirectory, "AppData", "Roaming", "npm")
      ]
    : [
        path.join(homeDirectory, ".local", "bin"),
        path.join(homeDirectory, "bin"),
        path.join(homeDirectory, ".opencode", "bin"),
        path.join(homeDirectory, ".mimocode", "bin"),
        path.join(homeDirectory, ".bun", "bin"),
        path.join(homeDirectory, ".npm-global", "bin"),
        path.join(homeDirectory, ".cargo", "bin")
      ]
  return [...new Set(directories.filter(Boolean))]
    .filter((directory) => {
      try {
        return exists(directory)
      } catch {
        return false
      }
    })
}

export function mergeExecutablePath(pathValue, directories, delimiter = path.delimiter) {
  const values = []
  const seen = new Set()
  for (const source of [pathValue, ...directories]) {
    if (!source) continue
    for (const entry of String(source).split(delimiter)) {
      if (!entry || seen.has(entry)) continue
      seen.add(entry)
      values.push(entry)
    }
  }
  return values.length ? values.join(delimiter) : ""
}

/**
 * Add the known user install directories to this process's PATH before discovery or a harness
 * launch. Called by every bridge entrypoint, including the embedded daemon the desktop app runs.
 */
export function ensureRuntimeExecutablePath(options = {}) {
  const environment = options.environment ?? process.env
  const platform = options.platform ?? process.platform
  const homeDirectory = options.homeDirectory
    ?? environment.HOME
    ?? homedir()
  const delimiter = options.delimiter ?? path.delimiter
  const directories = userExecutableDirectories({
    platform,
    homeDirectory,
    environment,
    ...(options.exists ? { exists: options.exists } : {})
  })
  // Node exposes the Windows variable as `Path`, while a caller-provided object may already use
  // `PATH`. Preserve whichever spelling is present instead of creating a second, ignored entry.
  const pathKey = Object.hasOwn(environment, "PATH")
    ? "PATH"
    : Object.hasOwn(environment, "Path")
      ? "Path"
      : "PATH"
  const merged = mergeExecutablePath(environment[pathKey] ?? "", directories, delimiter)
  if (merged) environment[pathKey] = merged
  return environment[pathKey] ?? ""
}
