import type { PermissionRequest, QuestionRequest } from "./types"

export type NativeSessionGateEvidence = {
  kind: "authorization" | "question"
  label: string
  detail?: string
  boundaries: string[]
  omittedBoundaries: number
}

const MAX_LABEL_LENGTH = 240
const MAX_DETAIL_LENGTH = 240
const MAX_BOUNDARY_LENGTH = 160
const MAX_VISIBLE_BOUNDARIES = 3

function compact(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.replace(/\s+/g, " ").trim()
  if (!normalized) return undefined
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized
}

function permissionDetail(metadata: Record<string, unknown>): string | undefined {
  for (const key of ["reason", "description", "message"]) {
    const value = compact(metadata[key], MAX_DETAIL_LENGTH)
    if (value) return value
  }
  return undefined
}

function boundedBoundaries(patterns: readonly string[]): { boundaries: string[]; omittedBoundaries: number } {
  const safe = [...new Set(patterns
    .map((pattern) => compact(pattern, MAX_BOUNDARY_LENGTH))
    .filter((pattern): pattern is string => Boolean(pattern)))]
  return {
    boundaries: safe.slice(0, MAX_VISIBLE_BOUNDARIES),
    omittedBoundaries: Math.max(0, safe.length - MAX_VISIBLE_BOUNDARIES)
  }
}

/**
 * Convert structured native permission/question requests into a bounded review-only gate summary.
 * Permission evidence wins over questions because authorization is fail-closed and blocks execution.
 * No transcript/tool prose is read here; every displayed string comes from the native structured
 * request and is length/count bounded before presentation.
 */
export function nativeSessionGateEvidence(
  permissions: readonly PermissionRequest[],
  questions: readonly QuestionRequest[]
): NativeSessionGateEvidence | null {
  const permission = permissions[0]
  if (permission) {
    const boundary = boundedBoundaries(permission.patterns || [])
    const detail = permissionDetail(permission.metadata || {})
    return {
      kind: "authorization",
      label: compact(permission.permission, MAX_LABEL_LENGTH) || "Permission requested",
      ...(detail ? { detail } : {}),
      ...boundary
    }
  }

  const question = questions[0]?.questions?.[0]
  if (question) {
    return {
      kind: "question",
      label: compact(question.question, MAX_LABEL_LENGTH)
        || compact(question.header, MAX_LABEL_LENGTH)
        || "Input requested",
      boundaries: [],
      omittedBoundaries: 0
    }
  }

  return null
}
