import type { MessageEnvelope } from "./types"

function sameEnvelope(left: MessageEnvelope, right: MessageEnvelope): boolean {
  if (left === right) return true
  if (left.info.id !== right.info.id) return false
  // Message pages arrive as freshly parsed JSON even when nothing changed. Preserve the existing
  // object when the wire payload is identical so long transcripts do not re-render on every poll.
  return JSON.stringify(left.info) === JSON.stringify(right.info)
    && JSON.stringify(left.parts) === JSON.stringify(right.parts)
}

function visibleText(message: MessageEnvelope): string {
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
}

function simpleTailMessage(message: MessageEnvelope): boolean {
  if (message.info.error) return false
  return message.parts.every((part) => part.type === "text" || part.type === "reasoning")
}

function createdAt(message: MessageEnvelope): number {
  return Number(message.info.time?.created) || 0
}

function sameTurnTime(left: MessageEnvelope, right: MessageEnvelope): boolean {
  const a = createdAt(left)
  const b = createdAt(right)
  return !a || !b || Math.abs(a - b) <= 10_000
}

function withStableID(message: MessageEnvelope, stableID: string): MessageEnvelope {
  if (message.info.id === stableID) return message
  const oldID = message.info.id
  return {
    ...message,
    info: { ...message.info, id: stableID },
    parts: message.parts.map((part) => ({
      ...part,
      id: typeof part.id === "string" && part.id.startsWith(`${oldID}:`)
        ? `${stableID}${part.id.slice(oldID.length)}`
        : part.id,
      messageID: stableID
    }))
  }
}

function currentTurn(messages: MessageEnvelope[]): { user: MessageEnvelope; assistants: MessageEnvelope[] } | null {
  let userIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].info.role === "user") {
      userIndex = index
      break
    }
  }
  if (userIndex < 0) return null
  return {
    user: messages[userIndex],
    assistants: messages.slice(userIndex + 1).filter((message) => message.info.role === "assistant")
  }
}

function assistantTerminal(message: MessageEnvelope): boolean {
  if (message.info.role !== "assistant") return false
  if (message.info.error || message.info.time?.completed) return true
  const info = message.info as MessageEnvelope["info"] & { finish?: unknown }
  return typeof info.finish === "string" && Boolean(info.finish.trim())
}

function compatibleSimpleAssistants(left: MessageEnvelope | undefined, right: MessageEnvelope | undefined): boolean {
  if (!left || !right || !simpleTailMessage(left) || !simpleTailMessage(right)) return false
  const a = visibleText(left)
  const b = visibleText(right)
  return Boolean(a && b && (a === b || a.startsWith(b) || b.startsWith(a)))
}

/**
 * The bridge records a prompt immediately under a temporary id, then OMP/PI persist the same user
 * turn under their own journal id. Persistence can happen before any assistant chunk exists. If that
 * id swap is treated as a second user message, the work-thread mapper sees two identical prompts:
 * the accepted Run binds to the first, now-orphaned one, while the answer/activity bind to the second.
 * The Session then looks blank or stuck on "starting" until navigation discards the temporary row.
 *
 * Preserve the current user's browser identity as soon as persistence proves it is the same turn.
 * An unfinished prior turn is safe to alias because a distinct next prompt cannot have been accepted
 * yet. Once the prior turn is terminal, require compatible assistant text as the extra proof so two
 * genuinely repeated prompts are never collapsed just because they were sent close together.
 */
function stabilizeCurrentUserIdentity(existing: MessageEnvelope[], latest: MessageEnvelope[]): MessageEnvelope[] {
  const previous = currentTurn(existing)
  const incoming = currentTurn(latest)
  if (!previous || !incoming || previous.user.info.id === incoming.user.info.id) return latest
  if (!simpleTailMessage(previous.user) || !simpleTailMessage(incoming.user)) return latest

  const previousPrompt = visibleText(previous.user).trim()
  const incomingPrompt = visibleText(incoming.user).trim()
  if (!previousPrompt || previousPrompt !== incomingPrompt || !sameTurnTime(previous.user, incoming.user)) return latest

  const previousTerminal = previous.assistants.some(assistantTerminal)
  if (previousTerminal && !compatibleSimpleAssistants(previous.assistants.at(-1), incoming.assistants.at(-1))) {
    return latest
  }

  return latest.map((message) =>
    message === incoming.user ? withStableID(message, previous.user.info.id) : message
  )
}

function tailPair(messages: MessageEnvelope[]): { user: MessageEnvelope; assistant: MessageEnvelope } | null {
  let userIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].info.role === "user") {
      userIndex = index
      break
    }
  }
  if (userIndex < 0) return null
  const assistants = messages.slice(userIndex + 1).filter((message) => message.info.role === "assistant")
  const assistant = assistants.length ? assistants[assistants.length - 1] : undefined
  return assistant ? { user: messages[userIndex], assistant } : null
}

/**
 * ACP-backed harnesses can expose one identity while a turn is live and a different persisted JSONL
 * identity once the same turn is durable. Treat only the unambiguous final user+assistant pair as the
 * same logical tail: same prompt text, same turn time, no tools/errors, and assistant text equal or a
 * strict prefix in either direction. This is intentionally narrower than general text deduplication,
 * so repeated historical answers remain separate turns.
 *
 * Normalizing here, before the conversation controller sees the refreshed page, also lets a complete
 * persisted assistant replace a live prefix under the same id instead of briefly appearing as a
 * duplicate or remaining cut off until reopen. PI and OMP both cross this live-ACP -> journal boundary.
 */
function stabilizeTailIdentity(existing: MessageEnvelope[], latest: MessageEnvelope[]): MessageEnvelope[] {
  latest = stabilizeCurrentUserIdentity(existing, latest)
  const previousTail = tailPair(existing)
  const incomingTail = tailPair(latest)
  if (!previousTail || !incomingTail) return latest
  if (!simpleTailMessage(previousTail.user) || !simpleTailMessage(incomingTail.user)) return latest
  if (!simpleTailMessage(previousTail.assistant) || !simpleTailMessage(incomingTail.assistant)) return latest

  const previousPrompt = visibleText(previousTail.user).trim()
  const incomingPrompt = visibleText(incomingTail.user).trim()
  if (!previousPrompt || previousPrompt !== incomingPrompt || !sameTurnTime(previousTail.user, incomingTail.user)) return latest

  const previousAnswer = visibleText(previousTail.assistant)
  const incomingAnswer = visibleText(incomingTail.assistant)
  if (!previousAnswer || !incomingAnswer) return latest
  if (!(previousAnswer === incomingAnswer || previousAnswer.startsWith(incomingAnswer) || incomingAnswer.startsWith(previousAnswer))) return latest

  let changed = false
  const stabilized = latest.map((message) => {
    if (message === incomingTail.user && message.info.id !== previousTail.user.info.id) {
      changed = true
      return withStableID(message, previousTail.user.info.id)
    }
    if (message === incomingTail.assistant && message.info.id !== previousTail.assistant.info.id) {
      changed = true
      return withStableID(message, previousTail.assistant.info.id)
    }
    return message
  })
  return changed ? stabilized : latest
}

/**
 * A live ACP reply can be ahead of its append-only journal for a brief moment after the turn becomes
 * idle. The next newest-page reconcile must never replace that complete in-memory reply with an older
 * prefix from disk: doing so makes the answer look cut until the Session is reopened after the journal
 * catches up. Only reject an unambiguous textual regression for the exact same assistant message id;
 * divergent native rewrites are still accepted.
 */
function regressesAssistantText(current: MessageEnvelope, incoming: MessageEnvelope): boolean {
  if (current.info.role !== "assistant" || incoming.info.role !== "assistant") return false
  const currentText = visibleText(current)
  const incomingText = visibleText(incoming)
  return currentText.length > incomingText.length && currentText.startsWith(incomingText)
}

/**
 * Refresh the newest page without discarding older pages the user explicitly loaded.
 * Reuse both message objects and the array itself when the server did not change anything.
 */
export function mergeLatestMessagePage(existing: MessageEnvelope[], latest: MessageEnvelope[]): MessageEnvelope[] {
  if (!existing.length) return latest
  latest = stabilizeTailIdentity(existing, latest)
  const latestByID = new Map(latest.map((message) => [message.info.id, message]))
  const existingIDs = new Set(existing.map((message) => message.info.id))
  let changed = false

  const merged = existing.map((message) => {
    const incoming = latestByID.get(message.info.id)
    if (!incoming || sameEnvelope(message, incoming) || regressesAssistantText(message, incoming)) return message
    changed = true
    return incoming
  })
  for (const message of latest) {
    if (existingIDs.has(message.info.id)) continue
    merged.push(message)
    changed = true
  }
  return changed ? merged : existing
}

/** Add an older page once, keeping the current tail and its object identities intact. */
export function prependOlderMessagePage(existing: MessageEnvelope[], older: MessageEnvelope[]): MessageEnvelope[] {
  if (!existing.length) return older
  const existingIDs = new Set(existing.map((message) => message.info.id))
  const additions = older.filter((message) => !existingIDs.has(message.info.id))
  return additions.length ? [...additions, ...existing] : existing
}
