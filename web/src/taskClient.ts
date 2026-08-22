import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { desktopRequestResult, isDesktopPlatform } from "./desktopBridge"
import { unwrapPayload } from "./machinePayload"
import { authHeader, hasCredentials, machineBaseUrl } from "./serverConfig"
import type { ModelOption, ModelSelection, ServerConfig } from "./types"

const BROWSER_MACHINE_REQUEST_TIMEOUT_MS = 12_000
const LIST_STALE_GRACE_MS = 45_000
const MODEL_CATALOG_POLL_MS = 750
const MODEL_CATALOG_LOAD_TIMEOUT_MS = 120_000
const PENDING_CONTINUE_STORAGE_PREFIX = "harness-remote:pending-continue:"

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

export type MachineTaskRun = {
  id?: string
  sequence?: number
  agentId?: string
  model?: ModelSelection | null
  role?: string
  clientRequestId?: string
  sessionId?: string | null
  sessionID?: string | null
  status?: string
  transport?: string | null
  directory?: string
  prompt?: string
  outcome?: string
  outcomeVersion?: number
  contextRevision?: number
  handoffFromRunId?: string | null
  resumedFromRunId?: string | null
  handoffReason?: string
  workspaceRestoredAt?: string
  startedAt?: string
  finishedAt?: string
}

export type TaskCheckpoint = {
  id: string
  label: string
  kind: string
  runId?: string | null
  createdAt: string
  commit?: string
  baseHead?: string
  untrackedFiles?: string[]
  partial?: boolean
}

export type TaskContext = {
  version?: number
  revision?: number
  objective?: string
  currentState?: string
  latestOutcome?: { status?: string; agentId?: string; role?: string; text?: string; error?: string } | null
  runSummaries?: Array<Record<string, unknown>>
  changedFiles?: string[]
  workspace?: { dirty?: boolean; changeCount?: number; listedChangeCount?: number; truncated?: boolean }
  restore?: { at?: string; checkpointId?: string | null } | null
}

export type MachineTask = {
  id: string
  machineId: string
  projectId: string
  project: { name: string; path: string; kind: string }
  title?: string
  agentId: string
  prompt: string
  model?: ModelSelection | null
  status: string
  workspace: TaskWorkspace
  run: null | MachineTaskRun
  runs?: MachineTaskRun[]
  checkpoints?: TaskCheckpoint[]
  restoredCheckpointId?: string
  restoredAt?: string
  context?: TaskContext
  error?: { message?: string } | null
  finishedAt?: string | null
  createdAt: string
  updatedAt: string
}

export type TaskWorkspaceInspection = {
  managed: boolean
  dirty: boolean
  changeCount: number
  changedFiles?: string[]
  commitsAhead?: number
  commitsBehind?: number
  mergedIntoSource?: boolean
  branchMissing?: boolean
  sourceHead?: string
  branchHead?: string
}

export type TaskCleanup = {
  removed: boolean
  branchDeleted: boolean
}

export type TaskCleanupResponse = {
  task: MachineTask
  cleanup: TaskCleanup
}

export type TaskFinishResponse = {
  task: MachineTask
  result: TaskWorkspaceInspection
  cleanup: TaskCleanup
}

export type AgentModelCatalog = {
  models: ModelOption[]
  stale: boolean
  refreshedAt: string | null
  error?: string
  loading?: boolean
  source?: string
}

export type TaskContinueInput = {
  prompt: string
  agentId?: string
  model?: ModelSelection | null
  mode?: "fresh" | "resume"
  fresh?: boolean
  clientRequestId?: string
}

export type TaskCheckpointRestoreResponse = {
  task: MachineTask
  result: { restored: boolean; checkpointId: string; changeCount: number }
}

type TaskRequestOptions = {
  method?: "GET" | "POST" | "PATCH"
  body?: unknown
}

type TimedCache<T> = { value: T; at: number }
type PendingContinue = { fingerprint: string; clientRequestId: string }
const projectListCache = new Map<string, TimedCache<MachineProject[]>>()
const taskListCache = new Map<string, TimedCache<MachineTask[]>>()
const modelCatalogRequests = new Map<string, Promise<AgentModelCatalog>>()
const pendingContinueRequests = new Map<string, PendingContinue>()

function cacheKey(config: ServerConfig): string {
  return `${machineBaseUrl(config)}|${config.username || ""}`
}

function pendingContinueKey(config: ServerConfig, taskId: string): string {
  return `${cacheKey(config)}|${taskId}`
}

function pendingContinueStorageKey(key: string): string {
  return `${PENDING_CONTINUE_STORAGE_PREFIX}${encodeURIComponent(key)}`
}

function storage(): Storage | null {
  try { return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage } catch { return null }
}

function readPendingContinue(key: string): PendingContinue | null {
  const memory = pendingContinueRequests.get(key)
  if (memory) return memory
  const store = storage()
  if (!store) return null
  try {
    const parsed = JSON.parse(store.getItem(pendingContinueStorageKey(key)) || "null") as PendingContinue | null
    if (!parsed || typeof parsed.fingerprint !== "string" || typeof parsed.clientRequestId !== "string") return null
    pendingContinueRequests.set(key, parsed)
    return parsed
  } catch {
    return null
  }
}

function rememberPendingContinue(key: string, pending: PendingContinue): PendingContinue {
  pendingContinueRequests.set(key, pending)
  try { storage()?.setItem(pendingContinueStorageKey(key), JSON.stringify(pending)) } catch {}
  return pending
}

function clearPendingContinue(key: string): void {
  pendingContinueRequests.delete(key)
  try { storage()?.removeItem(pendingContinueStorageKey(key)) } catch {}
}

function newClientRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `hr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function continueFingerprint(input: TaskContinueInput): string {
  return JSON.stringify({
    prompt: input.prompt,
    agentId: input.agentId ?? null,
    model: input.model ?? null,
    mode: input.mode ?? null,
    fresh: input.fresh ?? null
  })
}

function hasClientRequest(task: MachineTask, clientRequestId: string): boolean {
  if (task.run?.clientRequestId === clientRequestId) return true
  return Array.isArray(task.runs) && task.runs.some((run) => run?.clientRequestId === clientRequestId)
}

function isActiveTask(task: MachineTask): boolean {
  return task.status === "starting" || task.status === "running"
}

function readRecent<T>(cache: Map<string, TimedCache<T>>, key: string): T | null {
  const cached = cache.get(key)
  if (!cached || Date.now() - cached.at > LIST_STALE_GRACE_MS) return null
  return cached.value
}

function remember<T>(cache: Map<string, TimedCache<T>>, key: string, value: T): T {
  cache.set(key, { value, at: Date.now() })
  return value
}

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

async function machineRequest<T>(config: ServerConfig, path: string, options: TaskRequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET"
  if (isDesktopPlatform()) {
    const result = await desktopRequestResult(config, { path, method, body: options.body })
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
        connectTimeout: 12_000,
        readTimeout: 30_000
      })
    } catch (error) {
      const detail = error instanceof Error && error.message ? ` ${error.message}` : ""
      throw new Error(`Cannot reach ${config.host}:${config.port}.${detail}`)
    }
    if (response.status === 401) throw new Error(unauthorizedDetail(config))
    if (response.status >= 400) throw new Error(responseDetail(response.data, `HTTP ${response.status}`))
    return parseTaskPayload<T>(response.data, path)
  }

  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), BROWSER_MACHINE_REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(target, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${path} at ${config.host}:${config.port} timed out after ${BROWSER_MACHINE_REQUEST_TIMEOUT_MS / 1000}s.`)
    }
    throw new Error(`Cannot reach ${config.host}:${config.port}.`)
  } finally {
    globalThis.clearTimeout(timer)
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
  const catalog = value as AgentModelCatalog & { lastError?: string }
  return {
    models: catalog.models,
    stale: Boolean(catalog.stale),
    refreshedAt: typeof catalog.refreshedAt === "string" ? catalog.refreshedAt : null,
    ...(catalog.loading === true ? { loading: true } : {}),
    ...(typeof catalog.source === "string" ? { source: catalog.source } : {}),
    ...(typeof catalog.error === "string" ? { error: catalog.error } : typeof catalog.lastError === "string" ? { error: catalog.lastError } : {})
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}

async function loadAgentModelCatalog(config: ServerConfig, agentId: string): Promise<AgentModelCatalog> {
  const path = `/v1/agents/${encodeURIComponent(agentId)}/models?waitMs=4000`
  const started = Date.now()
  while (true) {
    const catalog = requireModelCatalog(await machineRequest<unknown>(config, path), path)
    if (!catalog.loading) return catalog
    if (Date.now() - started >= MODEL_CATALOG_LOAD_TIMEOUT_MS) {
      throw new Error(`${agentId} model discovery is still starting after ${MODEL_CATALOG_LOAD_TIMEOUT_MS / 1000}s.`)
    }
    await sleep(MODEL_CATALOG_POLL_MS)
  }
}

function trustVersionedOutcome(run: MachineTaskRun): MachineTaskRun {
  return typeof run.outcome === "string" && run.outcomeVersion !== 2
    ? { ...run, outcome: undefined }
    : run
}

function normalizeTaskOutcomes(task: MachineTask): MachineTask {
  return {
    ...task,
    run: task.run ? trustVersionedOutcome(task.run) : null,
    ...(Array.isArray(task.runs) ? { runs: task.runs.map(trustVersionedOutcome) } : {})
  }
}

function normalizeTaskList(value: unknown, key: string, path: string): MachineTask[] {
  return requireArray<MachineTask>(value, key, path).map(normalizeTaskOutcomes)
}

export const taskClient = {
  async listProjects(config: ServerConfig): Promise<MachineProject[]> {
    const key = cacheKey(config)
    try {
      const payload = await machineRequest<unknown>(config, "/v1/projects")
      return remember(projectListCache, key, requireArray<MachineProject>(payload, "projects", "/v1/projects"))
    } catch (error) {
      const cached = readRecent(projectListCache, key)
      if (cached) return cached
      throw error
    }
  },

  async listTasks(config: ServerConfig): Promise<MachineTask[]> {
    const key = cacheKey(config)
    try {
      let tasks: MachineTask[]
      try {
        tasks = normalizeTaskList(await machineRequest<unknown>(config, "/v1/work-threads"), "workThreads", "/v1/work-threads")
      } catch (error) {
        // Compatibility with a daemon from before the Work Thread product endpoint existed.
        if (!/404|not found|cannot reach/i.test(error instanceof Error ? error.message : String(error))) throw error
        tasks = normalizeTaskList(await machineRequest<unknown>(config, "/v1/tasks"), "tasks", "/v1/tasks")
      }
      return remember(taskListCache, key, tasks)
    } catch (error) {
      const cached = readRecent(taskListCache, key)
      if (cached) return cached
      throw error
    }
  },

  async getWorkThread(config: ServerConfig, taskId: string): Promise<MachineTask> {
    return normalizeTaskOutcomes(await machineRequest<MachineTask>(config, `/v1/work-threads/${encodeURIComponent(taskId)}`))
  },

  renameWorkThread(config: ServerConfig, taskId: string, title: string): Promise<MachineTask> {
    return machineRequest<MachineTask>(config, `/v1/work-threads/${encodeURIComponent(taskId)}`, { method: "PATCH", body: { title } })
  },

  async listAgentModels(config: ServerConfig, agentId: string): Promise<AgentModelCatalog> {
    const key = `${cacheKey(config)}|${agentId}`
    const existing = modelCatalogRequests.get(key)
    if (existing) return existing
    const operation = loadAgentModelCatalog(config, agentId)
    let wrapped: Promise<AgentModelCatalog>
    wrapped = operation.finally(() => {
      if (modelCatalogRequests.get(key) === wrapped) modelCatalogRequests.delete(key)
    })
    modelCatalogRequests.set(key, wrapped)
    return wrapped
  },

  async createTask(config: ServerConfig, input: { projectId: string; agentId: string; prompt: string; model?: ModelSelection }): Promise<MachineTask> {
    return machineRequest<MachineTask>(config, "/v1/tasks", { method: "POST", body: input })
  },

  prepareWorktree(config: ServerConfig, taskId: string): Promise<MachineTask> {
    return machineRequest<MachineTask>(config, `/v1/tasks/${encodeURIComponent(taskId)}/worktree`, { method: "POST", body: {} })
  },

  launch(config: ServerConfig, taskId: string): Promise<MachineTask> {
    return machineRequest<MachineTask>(config, `/v1/tasks/${encodeURIComponent(taskId)}/launch`, { method: "POST", body: {} })
  },

  async continueTask(config: ServerConfig, taskId: string, input: string | TaskContinueInput): Promise<MachineTask> {
    const body = typeof input === "string" ? { prompt: input } : input
    const key = pendingContinueKey(config, taskId)
    const fingerprint = continueFingerprint(body)
    const remembered = readPendingContinue(key)
    const pending = remembered && remembered.fingerprint === fingerprint
      ? remembered
      : rememberPendingContinue(key, {
          fingerprint,
          clientRequestId: body.clientRequestId?.trim() || newClientRequestId()
        })
    const requestBody: TaskContinueInput = { ...body, clientRequestId: pending.clientRequestId }
    try {
      const next = normalizeTaskOutcomes(await machineRequest<MachineTask>(config, `/v1/tasks/${encodeURIComponent(taskId)}/continue`, { method: "POST", body: requestBody }))
      clearPendingContinue(key)
      return next
    } catch (error) {
      // The POST may have crossed the daemon acceptance boundary even if Android/browser lost its
      // response. Reconcile before surfacing a transport error. The persisted clientRequestId makes
      // this unambiguous even when the native Run has already completed.
      try {
        const latest = normalizeTaskOutcomes(await machineRequest<MachineTask>(config, `/v1/work-threads/${encodeURIComponent(taskId)}`))
        if (hasClientRequest(latest, pending.clientRequestId)) {
          clearPendingContinue(key)
          return latest
        }
      } catch {}
      throw error
    }
  },

  context(config: ServerConfig, taskId: string): Promise<TaskContext> {
    return machineRequest<TaskContext>(config, `/v1/tasks/${encodeURIComponent(taskId)}/context`)
  },

  async cancelWorkThread(config: ServerConfig, taskId: string): Promise<MachineTask> {
    try {
      return normalizeTaskOutcomes(await machineRequest<MachineTask>(config, `/v1/work-threads/${encodeURIComponent(taskId)}/cancel`, { method: "POST", body: {} }))
    } catch (error) {
      // Native abort may have succeeded just before the HTTP response was lost. A terminal
      // authoritative Work Thread beats a stale red transport error; an active one does not.
      try {
        const latest = normalizeTaskOutcomes(await machineRequest<MachineTask>(config, `/v1/work-threads/${encodeURIComponent(taskId)}`))
        if (!isActiveTask(latest)) return latest
      } catch {}
      throw error
    }
  },

  async listCheckpoints(config: ServerConfig, taskId: string): Promise<TaskCheckpoint[]> {
    const path = `/v1/work-threads/${encodeURIComponent(taskId)}/checkpoints`
    return requireArray<TaskCheckpoint>(await machineRequest<unknown>(config, path), "checkpoints", path)
  },

  async createCheckpoint(config: ServerConfig, taskId: string, input: { label?: string; kind?: string; runId?: string | null } = {}): Promise<TaskCheckpoint | null> {
    const path = `/v1/work-threads/${encodeURIComponent(taskId)}/checkpoints`
    const result = await machineRequest<{ checkpoint: TaskCheckpoint | null }>(config, path, { method: "POST", body: input })
    return result.checkpoint ?? null
  },

  restoreCheckpoint(config: ServerConfig, taskId: string, checkpointId: string): Promise<TaskCheckpointRestoreResponse> {
    return machineRequest<TaskCheckpointRestoreResponse>(config, `/v1/work-threads/${encodeURIComponent(taskId)}/checkpoints/${encodeURIComponent(checkpointId)}/restore`, { method: "POST", body: {} })
  },

  inspectResult(config: ServerConfig, taskId: string): Promise<TaskWorkspaceInspection> {
    return machineRequest<TaskWorkspaceInspection>(config, `/v1/tasks/${encodeURIComponent(taskId)}/result`)
  },

  inspectWorkspace(config: ServerConfig, taskId: string): Promise<TaskWorkspaceInspection> {
    return machineRequest<TaskWorkspaceInspection>(config, `/v1/tasks/${encodeURIComponent(taskId)}/worktree`)
  },

  cleanupWorkspace(config: ServerConfig, taskId: string): Promise<TaskCleanupResponse> {
    return machineRequest<TaskCleanupResponse>(config, `/v1/tasks/${encodeURIComponent(taskId)}/worktree/cleanup`, { method: "POST", body: {} })
  },

  finish(config: ServerConfig, taskId: string): Promise<TaskFinishResponse> {
    return machineRequest<TaskFinishResponse>(config, `/v1/tasks/${encodeURIComponent(taskId)}/finish`, { method: "POST", body: {} })
  }
}