import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { desktopRequestResult, isDesktopPlatform } from "./desktopBridge"
import { authHeader, hasCredentials, machineBaseUrl } from "./serverConfig"
import type { ServerConfig } from "./types"

const PROJECT_IDENTITY_TIMEOUT_MS = 20_000

export type GitProjectIdentity = {
  version: 1
  vcs: "git"
  repositoryFingerprint?: string
  historyFingerprint?: string
  head?: string
  branch?: string
  dirty?: boolean
}

export type ProjectContinuityEvidence = "match" | "different" | "unverified"

export type ProjectContinuityAssessment = {
  project: ProjectContinuityEvidence
  repository: ProjectContinuityEvidence
  history: ProjectContinuityEvidence
  branch: ProjectContinuityEvidence
  head: ProjectContinuityEvidence
  sourceDirty?: boolean
  targetDirty?: boolean
  /** True only when repository, branch and HEAD are proven equal and both worktrees are clean. */
  exactWorkspace: boolean
}

function unsupportedIdentityStatus(status: number | undefined): boolean {
  // 404 also covers an older daemon without the endpoint. In both cases the safe interpretation is
  // "cannot verify", never "same Project".
  return status === 404 || status === 405 || status === 501
}

function parseJSONValue(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) }
  catch { return null }
}

function validFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

export function parseGitProjectIdentity(value: unknown): GitProjectIdentity | null {
  const parsed = parseJSONValue(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const envelope = parsed as { identity?: unknown }
  if (envelope.identity === null) return null
  const candidate = envelope.identity as Partial<GitProjectIdentity> | undefined
  if (!candidate || candidate.version !== 1 || candidate.vcs !== "git") return null

  return {
    version: 1,
    vcs: "git",
    ...(validFingerprint(candidate.repositoryFingerprint) ? { repositoryFingerprint: candidate.repositoryFingerprint } : {}),
    ...(validFingerprint(candidate.historyFingerprint) ? { historyFingerprint: candidate.historyFingerprint } : {}),
    ...(typeof candidate.head === "string" && candidate.head ? { head: candidate.head } : {}),
    ...(typeof candidate.branch === "string" && candidate.branch ? { branch: candidate.branch } : {}),
    ...(typeof candidate.dirty === "boolean" ? { dirty: candidate.dirty } : {})
  }
}

/**
 * Load Project continuity evidence only when a cross-machine preflight needs it. Ordinary Session
 * discovery never calls this endpoint. Missing support or missing Project identity returns null so
 * callers fail closed instead of inferring equivalence from names or filesystem paths.
 */
export async function loadProjectIdentity(config: ServerConfig, projectId: string): Promise<GitProjectIdentity | null> {
  const normalizedProjectId = projectId.trim()
  if (!normalizedProjectId) return null
  const path = `/v1/project-identity?projectId=${encodeURIComponent(normalizedProjectId)}`

  if (isDesktopPlatform()) {
    const result = await desktopRequestResult(config, { path })
    if (!result.ok) {
      if (result.error.code === "http" && unsupportedIdentityStatus(result.error.status)) return null
      throw new Error(result.error.message)
    }
    return parseGitProjectIdentity(result.response.data)
  }

  const requestHeaders: Record<string, string> = { Accept: "application/json" }
  if (hasCredentials(config)) requestHeaders.Authorization = authHeader(config)
  const target = `${machineBaseUrl(config)}${path}`

  if (Capacitor.isNativePlatform()) {
    let response
    try {
      response = await CapacitorHttp.get({
        url: target,
        headers: requestHeaders,
        connectTimeout: PROJECT_IDENTITY_TIMEOUT_MS,
        readTimeout: PROJECT_IDENTITY_TIMEOUT_MS
      })
    } catch {
      throw new Error(`Cannot reach ${config.host}:${config.port}.`)
    }
    if (unsupportedIdentityStatus(response.status)) return null
    if (response.status >= 400) throw new Error(`HTTP ${response.status}`)
    return parseGitProjectIdentity(response.data)
  }

  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), PROJECT_IDENTITY_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(target, { headers: requestHeaders, signal: controller.signal })
  } catch {
    if (controller.signal.aborted) {
      throw new Error(`Project identity at ${config.host}:${config.port} timed out after ${PROJECT_IDENTITY_TIMEOUT_MS / 1000}s.`)
    }
    throw new Error(`Cannot reach ${config.host}:${config.port}.`)
  } finally {
    globalThis.clearTimeout(timer)
  }
  if (unsupportedIdentityStatus(response.status)) return null
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return parseGitProjectIdentity(await response.json())
}

function compareStringEvidence(left: string | undefined, right: string | undefined): ProjectContinuityEvidence {
  if (!left || !right) return "unverified"
  return left === right ? "match" : "different"
}

/**
 * Compare two machine-local Projects conservatively. A shared history root is useful evidence but
 * does not prove the repositories are the same (forks share roots), so only the privacy-preserving
 * repository fingerprint can promote Project identity to `match`. Any contradictory strong/history
 * evidence is `different`; missing evidence remains `unverified`.
 */
export function assessProjectContinuity(
  source: GitProjectIdentity | null | undefined,
  target: GitProjectIdentity | null | undefined
): ProjectContinuityAssessment {
  const repository = compareStringEvidence(source?.repositoryFingerprint, target?.repositoryFingerprint)
  const history = compareStringEvidence(source?.historyFingerprint, target?.historyFingerprint)
  const branch = compareStringEvidence(source?.branch, target?.branch)
  const head = compareStringEvidence(source?.head, target?.head)

  const project: ProjectContinuityEvidence = repository === "different" || history === "different"
    ? "different"
    : repository === "match"
      ? "match"
      : "unverified"

  const sourceDirty = source?.dirty
  const targetDirty = target?.dirty
  const exactWorkspace = project === "match"
    && branch === "match"
    && head === "match"
    && sourceDirty === false
    && targetDirty === false

  return {
    project,
    repository,
    history,
    branch,
    head,
    ...(typeof sourceDirty === "boolean" ? { sourceDirty } : {}),
    ...(typeof targetDirty === "boolean" ? { targetDirty } : {}),
    exactWorkspace
  }
}
