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
