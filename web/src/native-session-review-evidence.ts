import type { ConversationRuntime, ConversationTurn } from "./conversation-runtime"

export type NativeSessionReviewAttention = {
  complete: boolean
  questions: number
  permissions: number
}

export type NativeSessionReviewEvidence = {
  state: "authorization" | "input" | "failed" | "stopped" | "completed"
  label: string
  summary: string
  nextAction: string
  detail?: string
}

const MAX_DETAIL_LENGTH = 240

function normalizeStatus(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[\s_]+/g, "-") : ""
}

function statusIs(value: unknown, tokens: readonly string[]): boolean {
  const normalized = normalizeStatus(value)
  return Boolean(normalized) && tokens.some((token) => normalized === token)
}

function structuredError(turn: ConversationTurn | null, conversation: ConversationRuntime): string | undefined {
  const value = typeof turn?.error === "string"
    ? turn.error
    : turn?.error?.message || conversation.error?.message
  if (!value?.trim()) return undefined
  const compact = value.replace(/\s+/g, " ").trim()
  return compact.length > MAX_DETAIL_LENGTH ? `${compact.slice(0, MAX_DETAIL_LENGTH - 1)}…` : compact
}

function hasRealTurn(conversation: ConversationRuntime): boolean {
  if (conversation.currentTurn?.prompt?.trim()) return true
  if (conversation.initialPrompt?.trim()) return true
  return conversation.turns.some((turn) => Boolean(turn.prompt?.trim()))
}

/**
 * Project structured Session/runtime state into a compact review summary.
 *
 * This deliberately does not read transcript text, reasoning, tool prose or assistant claims. Pending
 * permission/question requests and native runtime lifecycle fields are the only authority here. Known
 * pending gates stay visible even if the sibling endpoint is unavailable, while a successful/completed
 * label is withheld until both attention reads have completed.
 */
export function nativeSessionReviewEvidence(
  conversation: ConversationRuntime,
  attention: NativeSessionReviewAttention
): NativeSessionReviewEvidence | null {
  if (attention.permissions > 0) {
    const count = attention.permissions
    return {
      state: "authorization",
      label: "Needs authorization",
      summary: `${count} target-side authorization ${count === 1 ? "request is" : "requests are"} pending.`,
      nextAction: "Review and authorize the request on this machine before the agent continues."
    }
  }

  if (attention.questions > 0) {
    const count = attention.questions
    return {
      state: "input",
      label: "Needs input",
      summary: `${count} structured question ${count === 1 ? "is" : "are"} waiting for your answer.`,
      nextAction: "Answer the pending question before the agent continues."
    }
  }

  const current = conversation.currentTurn
  const status = current?.status || conversation.status
  const error = structuredError(current, conversation)
  if (conversation.status === "failed" || statusIs(status, ["failed", "failure", "error"]) || error) {
    return {
      state: "failed",
      label: "Failed",
      summary: "The latest native turn ended with structured failure evidence.",
      nextAction: "Review the failure, then retry or continue with a correction.",
      ...(error ? { detail: error } : {})
    }
  }

  if (conversation.status === "cancelled" || statusIs(status, ["cancelled", "canceled", "stopped", "aborted"])) {
    return {
      state: "stopped",
      label: "Stopped",
      summary: "The latest native turn was stopped before normal completion.",
      nextAction: "Send a new instruction when you want to continue."
    }
  }

  if (!attention.complete || !hasRealTurn(conversation)) return null
  if (
    conversation.status === "completed"
    || statusIs(status, ["completed", "complete", "done", "finished", "succeeded", "success"])
    || Boolean(current?.finishedAt || conversation.finishedAt)
  ) {
    return {
      state: "completed",
      label: "Completed",
      summary: "The latest native turn completed and no pending authorization or question is currently reported.",
      nextAction: "Review the Project changes, then continue or hand off if more work remains."
    }
  }

  return null
}
