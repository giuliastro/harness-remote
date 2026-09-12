import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { desktopRequestResult, isDesktopPlatform } from "./desktopBridge"
import { authHeader, hasCredentials, machineBaseUrl } from "./serverConfig"
import type { ServerConfig } from "./types"

const OUTCOME_TIMEOUT_MS = 12_000
const MAX_WIRE_FILES = 200
const MAX_WIRE_PATH_LENGTH = 1024

export type MachineProjectOutcomeFile = {
  path: string
  originalPath?: string
  indexStatus: string
  worktreeStatus: string
}

export type MachineProjectOutcome = {
  version: 1
  vcs: "git"
  head?: string
  branch?: string
  dirty?: boolean
  files?: MachineProjectOutcomeFile[]
  totalChangedFiles?: number
  filesTruncated?: boolean
}

function headers(config: ServerConfig): Record<string, string> {
  const value: Record<string, string> = { Accept: "application/json" }
  if (hasCredentials(config)) value.Authorization = authHeader(config)
  return value
}

function unsupportedStatus(status: number | undefined): boolean {
  return status === 404 || status === 405 || status === 501
}

function safeRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > MAX_WIRE_PATH_LENGTH || value.includes("\0")) return undefined
  const normalized = value.replace(/\\/g, "/")
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) return undefined
  return normalized
}

function statusChar(value: unknown): string | undefined {
  return typeof value === "string" && value.length === 1 ? value : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

function parseOutcomePayload(value: unknown, projectId: string): MachineProjectOutcome | null {
  if (typeof value === "string") {
    try { value = JSON.parse(value) }
    catch { throw new Error("Invalid Project outcome response") }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Project outcome response")
  const payload = value as { projectId?: unknown; outcome?: unknown }
  if (payload.projectId !== projectId) throw new Error("Project outcome response does not match the requested Project")
  if (payload.outcome === null) return null
  if (!payload.outcome || typeof payload.outcome !== "object" || Array.isArray(payload.outcome)) {
    throw new Error("Invalid Project outcome response")
  }

  const source = payload.outcome as Record<string, unknown>
  if (source.version !== 1 || source.vcs !== "git") throw new Error("Unsupported Project outcome response")

  const files: MachineProjectOutcomeFile[] = []
  if (source.files !== undefined) {
    if (!Array.isArray(source.files)) throw new Error("Invalid Project outcome file list")
    for (const entry of source.files.slice(0, MAX_WIRE_FILES)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
      const candidate = entry as Record<string, unknown>
      const path = safeRelativePath(candidate.path)
      const indexStatus = statusChar(candidate.indexStatus)
      const worktreeStatus = statusChar(candidate.worktreeStatus)
      if (!path || indexStatus === undefined || worktreeStatus === undefined) continue
      const originalPath = safeRelativePath(candidate.originalPath)
      files.push({ path, indexStatus, worktreeStatus, ...(originalPath ? { originalPath } : {}) })
    }
  }

  const head = typeof source.head === "string" && source.head.trim() ? source.head.trim() : undefined
  const branch = typeof source.branch === "string" && source.branch.trim() ? source.branch.trim() : undefined
  const dirty = typeof source.dirty === "boolean" ? source.dirty : undefined
  const totalChangedFiles = nonNegativeInteger(source.totalChangedFiles)
  const filesTruncated = typeof source.filesTruncated === "boolean" ? source.filesTruncated : undefined

  return {
    version: 1,
    vcs: "git",
    ...(head ? { head } : {}),
    ...(branch ? { branch } : {}),
    ...(dirty !== undefined ? { dirty } : {}),
    ...(source.files !== undefined ? { files } : {}),
    ...(totalChangedFiles !== undefined ? { totalChangedFiles } : {}),
    ...(filesTruncated !== undefined ? { filesTruncated } : {})
  }
}

/**
 * Read optional, daemon-owned Project outcome evidence. Older daemons deliberately degrade to null
 * so this review surface can roll out without becoming a prerequisite for opening native Sessions.
 */
export async function loadMachineProjectOutcome(config: ServerConfig, projectId: string): Promise<MachineProjectOutcome | null> {
  const id = projectId.trim()
  if (!id) return null
  const path = `/v1/project-outcome?projectId=${encodeURIComponent(id)}`

  if (isDesktopPlatform()) {
    const result = await desktopRequestResult(config, { path })
    if (!result.ok) {
      if (result.error.code === "http" && unsupportedStatus(result.error.status)) return null
      throw new Error(result.error.message)
    }
    return parseOutcomePayload(result.response.data, id)
  }

  const target = `${machineBaseUrl(config)}${path}`
  if (Capacitor.isNativePlatform()) {
    let response
    try {
      response = await CapacitorHttp.get({
        url: target,
        headers: headers(config),
        connectTimeout: OUTCOME_TIMEOUT_MS,
        readTimeout: OUTCOME_TIMEOUT_MS
      })
    } catch {
      throw new Error(`Cannot reach ${config.host}:${config.port}.`)
    }
    if (unsupportedStatus(response.status)) return null
    if (response.status >= 400) throw new Error(`HTTP ${response.status}`)
    return parseOutcomePayload(response.data, id)
  }

  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), OUTCOME_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(target, { headers: headers(config), signal: controller.signal })
  } catch {
    if (controller.signal.aborted) {
      throw new Error(`Project outcome at ${config.host}:${config.port} timed out after ${OUTCOME_TIMEOUT_MS / 1000}s.`)
    }
    throw new Error(`Cannot reach ${config.host}:${config.port}.`)
  } finally {
    globalThis.clearTimeout(timer)
  }
  if (unsupportedStatus(response.status)) return null
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return parseOutcomePayload(await response.json(), id)
}
