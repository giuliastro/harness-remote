import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { delimiter as platformPathDelimiter, posix as posixPath, win32 as win32Path } from "node:path"

const PATH_START_MARKER = "__HARNESS_REMOTE_PATH_START__"
const PATH_END_MARKER = "__HARNESS_REMOTE_PATH_END__"
const DEFAULT_SHELL_TIMEOUT_MS = 2_000
const MAX_CAPTURED_STDOUT = 32_768

// Keep this command static. The shell is used only to materialize its exported PATH; no user or
// repository-controlled value is interpolated into the command string. Reading PATH through env
// also avoids shell-specific list semantics (for example Fish exposes PATH internally as a list).
const PRINT_PATH_COMMAND = `printf '${PATH_START_MARKER}\\n'; /usr/bin/env | /usr/bin/grep '^PATH='; printf '${PATH_END_MARKER}\\n'`

type ShellPathReader = (environment: NodeJS.ProcessEnv) => Promise<string | undefined>

export function parseLoginShellPathOutput(output: string): string | undefined {
  const start = output.lastIndexOf(PATH_START_MARKER)
  if (start < 0) return undefined
  const valueStart = start + PATH_START_MARKER.length
  const end = output.indexOf(PATH_END_MARKER, valueStart)
  if (end < 0) return undefined
  const block = output.slice(valueStart, end)
  const pathLine = block.split(/\r?\n/).find((line) => line.startsWith("PATH="))
  if (!pathLine) return undefined
  const value = pathLine.slice("PATH=".length)
  if (!value || /[\u0000\r\n]/.test(value)) return undefined
  return value
}

/**
 * Native installers put harness launchers in these per-user directories. A desktop launch can miss
 * them even when the login-shell probe succeeds, and a shell that times out leaves only the short
 * inherited PATH. Append the ones that exist so OMP, OpenCode and Claude are discoverable next to
 * an npm-installed Copilot.
 */
export function userExecutableDirectories(
  environment: NodeJS.ProcessEnv,
  options: {
    platform?: NodeJS.Platform
    homeDirectory?: string
    exists?: (path: string) => boolean
  } = {}
): string[] {
  const platform = options.platform ?? process.platform
  const home = options.homeDirectory ?? environment.HOME ?? homedir()
  const exists = options.exists ?? existsSync
  // Use the path semantics of the target platform, not the machine running the test. A Linux
  // fallback directory must keep POSIX separators even when the test suite runs on Windows.
  const join = platform === "win32" ? win32Path.join : posixPath.join
  const candidates = platform === "win32"
    ? [
        environment.APPDATA ? join(environment.APPDATA, "npm") : "",
        environment.LOCALAPPDATA ? join(environment.LOCALAPPDATA, "Programs", "nodejs") : ""
      ]
    : [
        join(home, ".local", "bin"),
        join(home, "bin"),
        join(home, ".opencode", "bin"),
        join(home, ".mimocode", "bin"),
        join(home, ".bun", "bin"),
        join(home, ".npm-global", "bin"),
        join(home, ".cargo", "bin")
      ]
  return [...new Set(candidates.filter(Boolean))].filter((candidate) => {
    try {
      return exists(candidate)
    } catch {
      return false
    }
  })
}

export function mergeExecutablePath(
  shellPath: string | undefined,
  processPath: string | undefined,
  delimiter: string = platformPathDelimiter
): string | undefined {
  const values: string[] = []
  const seen = new Set<string>()
  for (const source of [shellPath, processPath]) {
    if (!source) continue
    for (const entry of source.split(delimiter)) {
      if (!entry || seen.has(entry)) continue
      seen.add(entry)
      values.push(entry)
    }
  }
  return values.length > 0 ? values.join(delimiter) : undefined
}

function loginShell(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  try {
    const configured = userInfo().shell
    if (configured) return configured
  } catch {
    // userInfo can fail in unusual sandbox/container setups; SHELL and the platform default remain.
  }
  return environment.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh")
}

export async function readLoginShellPath(
  environment: NodeJS.ProcessEnv = process.env,
  options: { platform?: NodeJS.Platform; timeoutMs?: number; shell?: string } = {}
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform
  if (platform === "win32") return undefined
  const shell = options.shell || loginShell(environment, platform)
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS

  return await new Promise<string | undefined>((resolve) => {
    let stdout = ""
    let settled = false
    let child: ChildProcess | undefined
    let timer: NodeJS.Timeout | undefined
    const finish = (value?: string) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      child?.stdout?.removeAllListeners("data")
      child?.removeAllListeners("error")
      child?.removeAllListeners("exit")
      resolve(value)
    }

    try {
      child = spawn(shell, ["-ilc", PRINT_PATH_COMMAND], {
        env: environment,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true
      })
    } catch {
      finish()
      return
    }
    timer = setTimeout(() => {
      if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL")
      finish()
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-MAX_CAPTURED_STDOUT)
    })
    child.once("error", () => finish())
    child.once("exit", (code) => finish(code === 0 ? parseLoginShellPathOutput(stdout) : undefined))
  })
}

export async function resolveDesktopRuntimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform
    delimiter?: string
    homeDirectory?: string
    exists?: (path: string) => boolean
    readShellPath?: ShellPathReader
  } = {}
): Promise<NodeJS.ProcessEnv> {
  const platform = options.platform ?? process.platform
  const resolved = { ...environment }
  if (platform === "win32") return resolved

  let shellPath: string | undefined
  try {
    shellPath = await (options.readShellPath ?? ((env) => readLoginShellPath(env, { platform })))(environment)
  } catch {
    // Discovery is a reliability enhancement, never a startup dependency. The inherited PATH remains
    // usable for terminals, CI and machines whose shell startup is slow or intentionally unusual;
    // the known user install directories below still get a chance to fill the gap.
    shellPath = undefined
  }
  // Even a successful shell read can omit `~/.local/bin` on a distribution that only exports it
  // for interactive prompts. The known user install directories are appended last, so they add
  // reachability without overriding the order the user's shell chooses.
  const fallbackDirectories = userExecutableDirectories(environment, {
    platform,
    ...(options.homeDirectory ? { homeDirectory: options.homeDirectory } : {}),
    ...(options.exists ? { exists: options.exists } : {})
  })
  const mergedPath = mergeExecutablePath(
    mergeExecutablePath(shellPath, environment.PATH, options.delimiter),
    fallbackDirectories.join(options.delimiter ?? platformPathDelimiter),
    options.delimiter
  )
  if (mergedPath) resolved.PATH = mergedPath
  return resolved
}
