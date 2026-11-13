import type { MessageEnvelope } from "./types"

export type MessageFeed = {
  messages: MessageEnvelope[]
  before?: string
  hasMore: boolean
}

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
function regressesAssistantText(current: MessageEnvelope, incoming: MessageEnvelope, page: MessageEnvelope[] = []): boolean {
  if (current.info.role !== "assistant" || incoming.info.role !== "assistant") return false
  const currentText = visibleText(current)
  const incomingText = visibleText(incoming)
  if (!(currentText.length > incomingText.length && currentText.startsWith(incomingText))) return false
  // Text that moved rather than shrank: a harness can serve one reply as a single message while it
  // runs and split it later (DeepSeek files a tool turn's final text as its own message). The text
  // missing here then lives in another message of the same page; keeping the old copy would draw it
  // twice.
  return !textMovedToAnotherMessage(current, incoming, currentText.slice(incomingText.length), page)
}

function textMovedToAnotherMessage(current: MessageEnvelope, incoming: MessageEnvelope, missing: string, page: MessageEnvelope[]): boolean {
  const missingText = missing.trim()
  if (!missingText) return false
  // A text part filed under another message id names its real owner, so that message carrying it is
  // proof the text moved.
  const owners = new Set(current.parts
    .filter((part) => part.type === "text" && typeof part.id === "string")
    .map((part) => part.id!.split(":")[0])
    .filter((owner) => owner && owner !== current.info.id))
  // Only the rest of the same turn can have received it: an identical short reply ("OK") in another
  // turn says nothing about this one.
  const start = page.findIndex((message) => message === incoming || message.info.id === incoming.info.id)
  if (start < 0) return false
  for (const message of page.slice(start + 1)) {
    if (message.info.role === "user") break
    if (message.info.role !== "assistant") continue
    if (owners.has(message.info.id) || visibleText(message).includes(missingText)) return true
  }
  return false
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
    return sameEnvelope(current, incoming) || regressesAssistantText(current, incoming, latest) ? current : incoming
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

/**
 * Merge a newest-page refresh into a feed that may already have older pages loaded.
 *
 * The incoming page always describes its own tail only, so its cursor cannot replace an older
 * frontier the user has already paged to. Keeping `existing.hasMore || latest.hasMore` resurrected
 * the "Earlier messages" button after every live refresh, even when every earlier turn was already
 * on screen. Only a page that actually reaches back past the retained prefix may move the frontier.
 */
export function mergeLatestMessageFeed(existing: MessageFeed, latest: MessageFeed): MessageFeed {
  const messages = mergeLatestMessagePage(existing.messages, latest.messages, { complete: !latest.hasMore })
  const latestIDs = new Set(latest.messages.map((message) => message.info.id))
  const retainedOlderPrefix = messages.length > 0
    && latest.messages.length > 0
    && !latestIDs.has(messages[0].info.id)
  const before = retainedOlderPrefix ? existing.before : latest.before
  const hasMore = retainedOlderPrefix ? existing.hasMore : latest.hasMore
  if (messages === existing.messages && before === existing.before && hasMore === existing.hasMore) return existing
  return { messages, before, hasMore }
}

/**
 * Load a Session's first feed through the newest user prompt.
 *
 * A harness can store one native message per assistant step, so a page of raw messages may contain
 * only activity from a turn whose prompt is older. The timeline is built from user turns, which made
 * that Session render as empty or cut off the earliest visible reply until the user clicked "Earlier
 * messages". Walk back a bounded number of pages until the first message is a prompt; the bridge
 * normally aligns pages to turns itself, so this is a
 * recovery path for older daemons and harnesses with a different message shape.
 */
export async function loadInitialMessageFeed(
  loadPage: (before: string | undefined, limit: number) => Promise<MessageFeed>,
  { initialLimit, olderLimit, maxOlderPages }: { initialLimit: number; olderLimit: number; maxOlderPages: number }
): Promise<MessageFeed> {
  let feed: MessageFeed = await loadPage(undefined, initialLimit)
  for (let olderPages = 0; olderPages < maxOlderPages; olderPages += 1) {
    if (!feed.hasMore || !feed.before || feed.messages[0]?.info.role === "user") return feed
    const older = await loadPage(feed.before, olderLimit)
    const messages = prependOlderMessagePage(feed.messages, older.messages)
    if (messages === feed.messages && older.before === feed.before && older.hasMore === feed.hasMore) return feed
    feed = { messages, before: older.before, hasMore: older.hasMore }
  }
  return feed
}
