import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { desktopRequestResult, isDesktopPlatform } from "./desktopBridge"
import { unwrapPayload } from "./machinePayload"
import { authHeader, hasCredentials, machineBaseUrl } from "./serverConfig"
import type { ModelOption, ModelSelection, ServerConfig } from "./types"

export type MachineProject = {
  id: string
  machineId: string
  name: string
  path: string
  kind: "git" | "directory" | string
  configured?: boolean
}

export type TaskWorkspace = {
  mode: "project" | "worktree" | string
  path: string
  branch?: string
  source?: string
}

export type MachineTask = {
  id: string
  machineId: string
  projectId: string
  project: { name: string; path: string; kind: string }
  agentId: string
  prompt: string
  status: string
  workspace: TaskWorkspace
  run: null | { id?: string; sessionId?: string; sessionID?: string; status?: string }
  createdAt: string
  updatedAt: string
}

export type AgentModelCatalog = {
  models: ModelOption[]
  stale: boolean
  refreshedAt: string | null
  error?: string
}

type TaskRequestOptions = {
  method?: "GET" | "POST"
  body?: unknown
  timeoutMs?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 12_000
const DEFAULT_READ_TIMEOUT_MS = 30_000
export const MODEL_REFRESH_TIMEOUT_MS = 5_000

function requestHeaders(config: ServerConfig, body: boolean): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (hasCredentials(config)) headers.Authorization = authHeader(config)
  if (body) headers["Content-Type"] = "application/json"
  return headers
}

function responseDetail(value: unknown, fallback: string): string {
  if (!value) return fallback
  if (typeof value === "string") {
    try { return responseDetail(JSON.parse(value), fallback) } catch { return value || fallback }
  }
  if (typeof value === "object") {
    const candidate = value as { error?: unknown; message?: unknown }
    if (typeof candidate.error === "string") return candidate.error
    if (typeof candidate.message === "string") return candidate.message
  }
  return fallback
}

export function parseTaskPayload<T>(value: unknown, label: string): T {
  const candidate = unwrapPayload(value)
  if (typeof candidate === "string") {
    throw new Error(`${label} returned an incompatible response. Make sure this profile can reach the Harness machine daemon.`)
  }
  return candidate as T
}

function unauthorizedDetail(config: ServerConfig): string {
  return hasCredentials(config)
    ? "HTTP 401: the server rejected these credentials."
    : "HTTP 401: this server requires a username and password, and none were sent."
}

function timeoutError(path: string, timeoutMs: number) {
  return new Error(`${path} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`)
}

async function machineRequest<T>(config: ServerConfig, path: string, options: TaskRequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET"
  const timeoutMs = options.timeoutMs
  if (isDesktopPlatform()) {
    const request = desktopRequestResult(config, { path, method, body: options.body })
    const result = timeoutMs
      ? await Promise.race([
        request,
        new Promise<never>((_, reject) => setTimeout(() => reject(timeoutError(path, timeoutMs)), timeoutMs))
      ])
      : await request
    if (!result.ok) {
      if (result.error.code === "http" && result.error.status === 401) throw new Error(unauthorizedDetail(config))
      throw new Error(result.error.message)
    }
    return parseTaskPayload<T>(result.response.data, path)
  }

  const target = `${machineBaseUrl(config)}${path}`
  const headers = requestHeaders(config, options.body !== undefined)
  if (Capacitor.isNativePlatform()) {
    let response
    try {
      response = await CapacitorHttp.request({
        url: target,
        method,
        headers,
        data: options.body,
        connectTimeout: timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        readTimeout: timeoutMs ?? DEFAULT_READ_TIMEOUT_MS
      })
    } catch (error) {
      if (timeoutMs) throw timeoutError(path, timeoutMs)
      const detail = error instanceof Error && error.message ? ` ${error.message}` : ""
      throw new Error(`Cannot reach ${config.host}:${config.port}.${detail}`)
    }
    if (response.status === 401) throw new Error(unauthorizedDetail(config))
    if (response.status >= 400) throw new Error(responseDetail(response.data, `HTTP ${response.status}`))
    return parseTaskPayload<T>(response.data, path)
  }

  const controller = timeoutMs ? new AbortController() : undefined
  const timer = timeoutMs ? setTimeout(() => controller?.abort(), timeoutMs) : undefined
  let response: Response
  try {
    response = await fetch(target, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller?.signal
    })
  } catch {
    if (timeoutMs && controller?.signal.aborted) throw timeoutError(path, timeoutMs)
    throw new Error(`Cannot reach ${config.host}:${config.port}.`)
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (response.status === 401) throw new Error(unauthorizedDetail(config))
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try { detail = responseDetail(await response.text(), detail) } catch { /* keep status */ }
    throw new Error(detail)
  }
  return parseTaskPayload<T>(await response.text(), path)
}

function requireArray<T>(value: unknown, key: string, path: string): T[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>)[key])) {
    throw new Error(`${path} returned an incompatible response.`)
  }
  return (value as Record<string, unknown>)[key] as T[]
}

function requireModelCatalog(value: unknown, path: string): AgentModelCatalog {
  if (!value || typeof value !== "object" || !Array.isArray((value as AgentModelCatalog).models)) {
    throw new Error(`${path} returned an incompatible response.`)
  }
  const catalog = value as AgentModelCatalog
  return {
    models: catalog.models,
    stale: Boolean(catalog.stale),
    refreshedAt: typeof catalog.refreshedAt === "string" ? catalog.refreshedAt : null,
    ...(typeof catalog.error === "string" ? { error: catalog.error } : {})
  }
}

export const taskClient = {
  async listProjects(config: ServerConfig): Promise<MachineProject[]> {
    const payload = await machineRequest<unknown>(config, "/v1/projects")
    return requireArray<MachineProject>(payload, "projects", "/v1/projects")
  },

  async listTasks(config: ServerConfig): Promise<MachineTask[]> {
    const payload = await machineRequest<unknown>(config, "/v1/tasks")
    return requireArray<MachineTask>(payload, "tasks", "/v1/tasks")
  },

  async listAgentModels(config: ServerConfig, agentId: string): Promise<AgentModelCatalog> {
    const path = `/v1/agents/${encodeURIComponent(agentId)}/models`
    return requireModelCatalog(await machineRequest<unknown>(config, path, { timeoutMs: MODEL_REFRESH_TIMEOUT_MS }), path)
  },

  async createTask(config: ServerConfig, input: { projectId: string; agentId: string; prompt: string; model?: ModelSelection }): Promise<MachineTask> {
    return machineRequest<MachineTask>(config, "/v1/tasks", { method: "POST", body: input })
  },

  prepareWorktree(config: ServerConfig, taskId: string): Promise<MachineTask> {
    return machineRequest<MachineTask>(config, `/v1/tasks/${encodeURIComponent(taskId)}/worktree`, { method: "POST", body: {} })
  },

  launch(config: ServerConfig, taskId: string): Promise<MachineTask> {
    return machineRequest<MachineTask>(config, `/v1/tasks/${encodeURIComponent(taskId)}/launch`, { method: "POST", body: {} })
  }
}
