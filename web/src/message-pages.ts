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
 *
 * The page is the transcript's own tail, in its own order, so from the first message it shares
 * with the feed onwards it replaces the feed: a message first seen between two known ones (a running
 * reply the daemon files above a queued prompt) lands where the page puts it, and a feed message
 * the page no longer carries there is gone from the transcript. Only messages before that overlap -
 * older pages the user loaded - are kept. A `complete` page, one with nothing older, replaces the
 * feed entirely: the daemon can serve the same turn under a second set of ids once a harness's own
 * export becomes the source (OpenCode 2 when idle), and keeping both sets drew every prompt twice
 * and attached its reply to the invisible copy.
 */
export function mergeLatestMessagePage(
  existing: MessageEnvelope[],
  latest: MessageEnvelope[],
  { complete = false }: { complete?: boolean } = {}
): MessageEnvelope[] {
  if (!existing.length) return latest
  const existingByID = new Map(existing.map((message) => [message.info.id, message]))
  const latestIDs = new Set(latest.map((message) => message.info.id))
  const reuse = (incoming: MessageEnvelope) => {
    const current = existingByID.get(incoming.info.id)
    if (!current) return incoming
    return sameEnvelope(current, incoming) || regressesAssistantText(current, incoming) ? current : incoming
  }
  const firstOverlap = existing.findIndex((message) => latestIDs.has(message.info.id))
  const older = complete
    ? []
    : firstOverlap >= 0
      ? existing.slice(0, firstOverlap).filter((message) => !latestIDs.has(message.info.id))
      : existing
  const merged = [...older, ...latest.map(reuse)]
  const unchanged = merged.length === existing.length && merged.every((message, index) => message === existing[index])
  return unchanged ? existing : merged
}

/** Add an older page once, keeping the current tail and its object identities intact. */
export function prependOlderMessagePage(existing: MessageEnvelope[], older: MessageEnvelope[]): MessageEnvelope[] {
  if (!existing.length) return older
  const existingIDs = new Set(existing.map((message) => message.info.id))
  const additions = older.filter((message) => !existingIDs.has(message.info.id))
  return additions.length ? [...additions, ...existing] : existing
}
