import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:net"
import { join } from "node:path"

export const EMBEDDED_DAEMON_HOST = "127.0.0.1"
export const EMBEDDED_DAEMON_PROFILE_ID = "desktop-local-runtime"
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const MAX_CAPTURED_STDERR = 4_096

export type EmbeddedDaemonEndpoint = {
  id: typeof EMBEDDED_DAEMON_PROFILE_ID
  host: typeof EMBEDDED_DAEMON_HOST
  port: number
  username: string
  password: string
}

export type EmbeddedDaemonReady = {
  endpoint: EmbeddedDaemonEndpoint
  pid: number | null
}

export type EmbeddedDaemonPathOptions = {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
}

export function embeddedDaemonEntry({ isPackaged, appPath, resourcesPath }: EmbeddedDaemonPathOptions): string {
  return isPackaged
    ? join(resourcesPath, "bridge-runtime", "src", "daemon-cli.js")
    : join(appPath, "..", "bridge", "src", "daemon-cli.js")
}

export function embeddedDaemonArgs(port: number, openCodePort: number, username: string, password: string): string[] {
  return [
    "--host", EMBEDDED_DAEMON_HOST,
    "--port", String(port),
    "--opencode-host", EMBEDDED_DAEMON_HOST,
    "--opencode-port", String(openCodePort),
    "--username", username,
    "--password", password
  ]
}

export function embeddedDaemonEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...environment, ELECTRON_RUN_AS_NODE: "1" }
}

export async function findLoopbackPort(startPort: number, excluded: readonly number[] = [], attempts = 64): Promise<number> {
  const excludedPorts = new Set(excluded)
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = startPort + offset
    if (port > 65_535) break
    if (excludedPorts.has(port)) continue
    if (await canBindLoopback(port)) return port
  }
  throw new Error(`No free loopback port found from ${startPort} through ${Math.min(65_535, startPort + attempts - 1)}`)
}

function canBindLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.unref()
    probe.once("error", () => resolve(false))
    probe.listen(port, EMBEDDED_DAEMON_HOST, () => probe.close(() => resolve(true)))
  })
}

function credentials(): { username: string; password: string } {
  return {
    username: "harness-desktop",
    password: randomBytes(24).toString("base64url")
  }
}

function appendTail(current: string, chunk: Buffer | string): string {
  return `${current}${chunk.toString()}`.slice(-MAX_CAPTURED_STDERR)
}

function cleanErrorDetail(value: string): string {
  const lines = value.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return lines.slice(-3).join(" | ").slice(0, 1_000)
}

export class EmbeddedDaemonRuntime {
  private child: ChildProcess | undefined
  private ready: EmbeddedDaemonReady | undefined
  private starting: Promise<EmbeddedDaemonReady> | undefined

  constructor(private readonly options: {
    entryPath: string
    executable?: string
    environment?: NodeJS.ProcessEnv
    startupTimeoutMs?: number
    shutdownTimeoutMs?: number
  }) {}

  get isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed && this.ready)
  }

  start(): Promise<EmbeddedDaemonReady> {
    if (this.ready && this.isRunning) return Promise.resolve(this.ready)
    if (this.starting) return this.starting
    this.starting = this.launch().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private async launch(): Promise<EmbeddedDaemonReady> {
    const port = await findLoopbackPort(4097)
    const openCodePort = await findLoopbackPort(4096, [port])
    const auth = credentials()
    const args = embeddedDaemonArgs(port, openCodePort, auth.username, auth.password)
    const child = spawn(this.options.executable ?? process.execPath, [this.options.entryPath, ...args], {
      env: embeddedDaemonEnvironment(this.options.environment),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    })
    this.child = child
    let stderr = ""
    child.stderr?.on("data", (chunk) => { stderr = appendTail(stderr, chunk) })

    const readyMarker = `Harness daemon ready at http://${EMBEDDED_DAEMON_HOST}:${port}`
    const startupTimeoutMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    try {
      await new Promise<void>((resolve, reject) => {
        let stdout = ""
        let settled = false
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          child.stdout?.off("data", onStdout)
          child.off("error", onError)
          child.off("exit", onExit)
          if (error) reject(error)
          else resolve()
        }
        const onStdout = (chunk: Buffer | string) => {
          stdout = `${stdout}${chunk.toString()}`.slice(-8_192)
          if (stdout.includes(readyMarker)) finish()
        }
        const onError = (error: Error) => finish(new Error(`Embedded daemon failed to start: ${error.message}`))
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          const detail = cleanErrorDetail(stderr)
          const suffix = detail ? `: ${detail}` : ""
          finish(new Error(`Embedded daemon exited before ready (${code ?? "unknown"}${signal ? `, ${signal}` : ""})${suffix}`))
        }
        const timer = setTimeout(() => {
          const detail = cleanErrorDetail(stderr)
          finish(new Error(`Embedded daemon did not become ready within ${startupTimeoutMs}ms${detail ? `: ${detail}` : ""}`))
        }, startupTimeoutMs)
        timer.unref?.()
        child.stdout?.on("data", onStdout)
        child.once("error", onError)
        child.once("exit", onExit)
      })
    } catch (error) {
      if (this.child === child) this.child = undefined
      if (!child.killed && child.exitCode === null) child.kill("SIGTERM")
      throw error
    }

    const result: EmbeddedDaemonReady = {
      endpoint: {
        id: EMBEDDED_DAEMON_PROFILE_ID,
        host: EMBEDDED_DAEMON_HOST,
        port,
        username: auth.username,
        password: auth.password
      },
      pid: child.pid ?? null
    }
    this.ready = result
    child.once("exit", () => {
      if (this.child === child) this.child = undefined
      if (this.ready === result) this.ready = undefined
    })
    return result
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.ready = undefined
    if (!child || child.exitCode !== null) return

    const shutdownTimeoutMs = this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.off("exit", finish)
        resolve()
      }
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL")
        finish()
      }, shutdownTimeoutMs)
      timer.unref?.()
      child.once("exit", finish)
      if (child.exitCode !== null) {
        finish()
        return
      }
      child.kill("SIGTERM")
    })
  }
}
