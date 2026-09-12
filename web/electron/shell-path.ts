import { spawn } from "node:child_process"
import { userInfo } from "node:os"
import { delimiter as platformPathDelimiter } from "node:path"

const PATH_START_MARKER = "__HARNESS_REMOTE_PATH_START__"
const PATH_END_MARKER = "__HARNESS_REMOTE_PATH_END__"
const DEFAULT_SHELL_TIMEOUT_MS = 2_000
const MAX_CAPTURED_STDOUT = 32_768

// Keep this command static. The shell is used only to materialize its effective PATH; no user or
// repository-controlled value is interpolated into the command string.
const PRINT_PATH_COMMAND = `printf '${PATH_START_MARKER}%s${PATH_END_MARKER}\\n' "$PATH"`

type ShellPathReader = (environment: NodeJS.ProcessEnv) => Promise<string | undefined>

export function parseLoginShellPathOutput(output: string): string | undefined {
  const start = output.lastIndexOf(PATH_START_MARKER)
  if (start < 0) return undefined
  const valueStart = start + PATH_START_MARKER.length
  const end = output.indexOf(PATH_END_MARKER, valueStart)
  if (end < 0) return undefined
  const value = output.slice(valueStart, end)
  if (!value || /[\u0000\r\n]/.test(value)) return undefined
  return value
}

export function mergeExecutablePath(
  shellPath: string | undefined,
  processPath: string | undefined,
  delimiter = platformPathDelimiter
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

function loginShell(environment: NodeJS.ProcessEnv): string {
  try {
    const configured = userInfo().shell
    if (configured) return configured
  } catch {
    // userInfo can fail in unusual sandbox/container setups; SHELL and the platform default remain.
  }
  return environment.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh")
}

export async function readLoginShellPath(
  environment: NodeJS.ProcessEnv = process.env,
  options: { platform?: NodeJS.Platform; timeoutMs?: number; shell?: string } = {}
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform
  if (platform === "win32") return undefined
  const shell = options.shell || loginShell(environment)
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS

  return await new Promise<string | undefined>((resolve) => {
    let stdout = ""
    let settled = false
    let child
    const finish = (value?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child?.stdout?.removeAllListeners("data")
      child?.removeAllListeners("error")
      child?.removeAllListeners("exit")
      resolve(value)
    }
    const timer = setTimeout(() => {
      if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL")
      finish()
    }, timeoutMs)
    timer.unref?.()

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
    // usable for terminals, CI and machines whose shell startup is slow or intentionally unusual.
    return resolved
  }
  const mergedPath = mergeExecutablePath(shellPath, environment.PATH, options.delimiter)
  if (mergedPath) resolved.PATH = mergedPath
  return resolved
}
