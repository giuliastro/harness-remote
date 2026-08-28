import type { MessagePage } from "./api"
import { lastNativeMessageModel } from "./native-session-model"
import type { MessageEnvelope, ModelSelection } from "./types"

export function canonicalNativeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim()
}

function messageText(message: MessageEnvelope): string {
  return (message.parts || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

/**
 * The old v3 handoff packet is transport context, not visible dialogue. Session projection uses only
 * the USER INSTRUCTION payload when matching native turns.
 */
export function visibleNativePrompt(message: MessageEnvelope): string {
  const value = canonicalNativeText(messageText(message))
  if (!value.startsWith("You are taking over an existing TaskDesk task.")) return value
  const marker = "\nUSER INSTRUCTION\n"
  const start = value.indexOf(marker)
  if (start < 0) return value
  const instructionStart = start + marker.length
  const footerStart = value.indexOf("\n\nContinue from the shared workspace", instructionStart)
  return canonicalNativeText(value.slice(instructionStart, footerStart >= 0 ? footerStart : undefined))
}

/**
 * PI can expose one live ACP id and a different persisted journal id for the same completed reply.
 * Alias only an unambiguous final-text match; repeated answers, errors and tool-bearing messages keep
 * their native identities.
 */
function piStableAssistantKey(message: MessageEnvelope): string | null {
  if (message.info.role !== "assistant" || message.info.error || !message.parts.length) return null
  if (message.parts.some((part) => part.type !== "text" && part.type !== "reasoning")) return null
  const textParts = message.parts.filter((part) => part.type === "text" && typeof part.text === "string")
  if (!textParts.length) return null
  const text = canonicalNativeText(textParts.map((part) => part.text || "").join("\n"))
  return text || null
}

export function stabilizePiTailMessageIDs(
  previous: MessageEnvelope[],
  next: MessageEnvelope[]
): MessageEnvelope[] {
  if (!previous.length || !next.length) return next

  const previousIDs = new Set(previous.map((message) => message.info.id))
  const nextIDs = new Set(next.map((message) => message.info.id))
  const previousByKey = new Map<string, MessageEnvelope[]>()
  const nextKeyCounts = new Map<string, number>()

  for (const message of previous) {
    if (nextIDs.has(message.info.id)) continue
    const key = piStableAssistantKey(message)
    if (!key) continue
    const candidates = previousByKey.get(key) ?? []
    candidates.push(message)
    previousByKey.set(key, candidates)
  }
  for (const message of next) {
    if (previousIDs.has(message.info.id)) continue
    const key = piStableAssistantKey(message)
    if (key) nextKeyCounts.set(key, (nextKeyCounts.get(key) ?? 0) + 1)
  }

  let changed = false
  const stabilized = next.map((message) => {
    if (previousIDs.has(message.info.id)) return message
    const key = piStableAssistantKey(message)
    if (!key || nextKeyCounts.get(key) !== 1) return message
    const candidates = previousByKey.get(key)
    if (candidates?.length !== 1) return message
    const stableID = candidates[0].info.id
    changed = true
    return {
      ...message,
      info: { ...message.info, id: stableID },
      parts: message.parts.map((part) => ({ ...part, messageID: stableID }))
    }
  })
  return changed ? stabilized : next
}

function nativeAssistantCompleted(message: MessageEnvelope): boolean {
  if (message.info.role !== "assistant") return false
  if (message.info.error || message.info.time?.completed) return true
  const info = message.info as MessageEnvelope["info"] & { finish?: unknown }
  return typeof info.finish === "string" && Boolean(info.finish.trim())
}

/**
 * Find completion evidence for the newest accepted OpenCode prompt from the transcript itself.
 * Prompt occurrence rather than timestamp keeps repeated identical prompts and clock skew correct.
 */
export function openCodeTranscriptCompletion(
  orderedPrompts: string[],
  page: MessagePage,
  before?: string
): { completedAt: number } | null {
  if (before || !orderedPrompts.length) return null
  const prompt = canonicalNativeText(orderedPrompts[orderedPrompts.length - 1] || "")
  if (!prompt) return null

  const occurrence = orderedPrompts
    .slice(0, -1)
    .filter((candidate) => canonicalNativeText(candidate) === prompt)
    .length

  let seen = 0
  let userIndex = -1
  for (let index = 0; index < page.messages.length; index += 1) {
    const message = page.messages[index]
    if (message.info.role !== "user" || visibleNativePrompt(message) !== prompt) continue
    if (seen === occurrence) {
      userIndex = index
      break
    }
    seen += 1
  }
  if (userIndex < 0) return null

  let completedAt = 0
  let completed = false
  for (let index = userIndex + 1; index < page.messages.length; index += 1) {
    const message = page.messages[index]
    if (message.info.role === "user") break
    if (!nativeAssistantCompleted(message)) continue
    completed = true
    completedAt = Math.max(
      completedAt,
      Number(message.info.time?.completed) || Number(message.info.time?.created) || 0
    )
  }
  return completed ? { completedAt } : null
}

/** Transcript sources verified to report the Session's current model on the current page. */
const TRANSCRIPT_MODEL_BACKENDS = new Set(["opencode", "codex", "omp"])

export function nativeSessionTranscriptModel(
  backend: string,
  page: MessagePage,
  before?: string
): ModelSelection | null {
  if (before || !TRANSCRIPT_MODEL_BACKENDS.has(backend)) return null
  return page.model ?? (backend === "opencode" ? lastNativeMessageModel(page.messages) : null)
}
