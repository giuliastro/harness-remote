import type { MessageEnvelope } from "./types"

function sameEnvelope(left: MessageEnvelope, right: MessageEnvelope): boolean {
  return left.info.id === right.info.id
    && left.info.role === right.info.role
    && left.info.time?.created === right.info.time?.created
    && left.info.time?.completed === right.info.time?.completed
    && left.info.error?.message === right.info.error?.message
    && JSON.stringify(left.parts) === JSON.stringify(right.parts)
}

function visibleText(message: MessageEnvelope): string {
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
}

function canonicalText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim()
}

function lastUserMessage(messages: MessageEnvelope[]): MessageEnvelope | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].info.role === "user") return messages[index]
  }
  return undefined
}

function lastAssistantAfterUser(messages: MessageEnvelope[], user: MessageEnvelope): MessageEnvelope | undefined {
  const userIndex = messages.lastIndexOf(user)
  for (let index = messages.length - 1; index > userIndex; index -= 1) {
    if (messages[index].info.role === "assistant") return messages[index]
  }
  return undefined
}

function stableAssistantCandidate(message?: MessageEnvelope): message is MessageEnvelope {
  if (!message || message.info.role !== "assistant" || message.info.error || !message.parts.length) return false
  if (message.parts.some((part) => part.type !== "text" && part.type !== "reasoning")) return false
  return Boolean(canonicalText(visibleText(message)))
}

/**
 * ACP streaming and native journals do not always use the same id for one logical assistant reply.
 * PI is the clearest example, but OMP can cross the same live -> journal boundary. When the selected
 * tail is still on the same user turn and the journal answer is exactly the streamed text or a prefix
 * extension/regression of it, keep the browser's live message identity. This is deliberately limited
 * to the final assistant of the final user turn: repeated historical answers, tools and divergent
 * rewrites must retain their native identities.
 */
function stabilizeTrailingAssistantIdentity(existing: MessageEnvelope[], latest: MessageEnvelope[]): MessageEnvelope[] {
  const currentUser = lastUserMessage(existing)
  const incomingUser = lastUserMessage(latest)
  if (!currentUser || !incomingUser) return latest
  const currentPrompt = canonicalText(visibleText(currentUser))
  const incomingPrompt = canonicalText(visibleText(incomingUser))
  if (!currentPrompt || currentPrompt !== incomingPrompt) return latest

  const currentAssistant = lastAssistantAfterUser(existing, currentUser)
  const incomingAssistant = lastAssistantAfterUser(latest, incomingUser)
  if (!stableAssistantCandidate(currentAssistant) || !stableAssistantCandidate(incomingAssistant)) return latest
  if (currentAssistant.info.id === incomingAssistant.info.id) return latest

  const currentText = canonicalText(visibleText(currentAssistant))
  const incomingText = canonicalText(visibleText(incomingAssistant))
  if (!(currentText === incomingText || currentText.startsWith(incomingText) || incomingText.startsWith(currentText))) return latest

  return latest.map((message) => message !== incomingAssistant ? message : {
    ...message,
    info: { ...message.info, id: currentAssistant.info.id },
    parts: message.parts.map((part) => ({ ...part, messageID: currentAssistant.info.id }))
  })
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
  if (!latest.length) return existing

  const stabilizedLatest = stabilizeTrailingAssistantIdentity(existing, latest)
  const existingIDs = new Set(existing.map((message) => message.info.id))
  const latestByID = new Map(stabilizedLatest.map((message) => [message.info.id, message]))
  let changed = false

  const merged = existing.map((message) => {
    const incoming = latestByID.get(message.info.id)
    if (!incoming || sameEnvelope(message, incoming) || regressesAssistantText(message, incoming)) return message
    changed = true
    return incoming
  })

  for (const message of stabilizedLatest) {
    if (existingIDs.has(message.info.id)) continue
    merged.push(message)
    changed = true
  }

  return changed ? merged : existing
}

export function prependOlderMessagePage(existing: MessageEnvelope[], older: MessageEnvelope[]): MessageEnvelope[] {
  if (!older.length) return existing
  if (!existing.length) return older
  const existingIDs = new Set(existing.map((message) => message.info.id))
  const prepend = older.filter((message) => !existingIDs.has(message.info.id))
  return prepend.length ? [...prepend, ...existing] : existing
}
