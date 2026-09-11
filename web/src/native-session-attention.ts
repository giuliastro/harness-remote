import type { PermissionRequest, QuestionRequest, SessionStatus } from "./types"

export type NativeSessionAttentionKind = "none" | "informational" | "recoverable" | "authorization" | "rejected"

export type NativeSessionAttention = {
  kind: NativeSessionAttentionKind
  requiresUserAction: boolean
  failClosed: boolean
  reason: "permission" | "question" | "rejected" | "status" | "completed" | "none"
}

type AttentionInput = {
  status?: SessionStatus | null
  questions?: readonly QuestionRequest[]
  permissions?: readonly PermissionRequest[]
}

function normalizedStatus(status?: SessionStatus | null): string {
  return status?.type?.trim().toLowerCase().replace(/[\s_]+/g, "-") || ""
}

function statusContains(value: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => value === token || value.includes(token))
}

/**
 * Product-level attention semantics shared by the Session rail and detail surface.
 *
 * Permission/question payloads are authoritative when the running harness exposes them. Status text
 * is deliberately only a fallback: Harness Remote must not invent an authorization request from a
 * generic "waiting" or "working" state.
 */
export function classifyNativeSessionAttention({ status, questions = [], permissions = [] }: AttentionInput): NativeSessionAttention {
  if (permissions.length > 0) {
    return { kind: "authorization", requiresUserAction: true, failClosed: true, reason: "permission" }
  }

  const value = normalizedStatus(status)
  if (statusContains(value, ["rejected", "denied", "forbidden", "fail-closed"])) {
    return { kind: "rejected", requiresUserAction: false, failClosed: true, reason: "rejected" }
  }

  if (questions.length > 0) {
    return { kind: "recoverable", requiresUserAction: true, failClosed: true, reason: "question" }
  }

  if (statusContains(value, ["error", "fail", "attention", "blocked", "disconnected", "offline"])) {
    return { kind: "recoverable", requiresUserAction: true, failClosed: false, reason: "status" }
  }

  if (statusContains(value, ["completed", "complete", "done", "finished", "succeeded", "success"])) {
    return { kind: "informational", requiresUserAction: false, failClosed: false, reason: "completed" }
  }

  return { kind: "none", requiresUserAction: false, failClosed: false, reason: "none" }
}

export function sessionNeedsAttention(input: AttentionInput): boolean {
  const kind = classifyNativeSessionAttention(input).kind
  return kind === "recoverable" || kind === "authorization" || kind === "rejected"
}
