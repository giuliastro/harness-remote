/**
 * The Codex desktop app wraps what the user typed in the UI state it was showing at the time — the
 * in-app browser, open files and the like — as leading `<…-context source="ambient-ui-state">`
 * blocks followed by a `## My request:` heading. The rollout and the ACP replay both carry that
 * wrapped text as the user message, so shown as is the app attributes to the user a page of context
 * they never wrote. Only the request after it is theirs.
 *
 * Stripped only when the message *starts* with one or more complete ambient blocks. A message
 * without them, one that merely mentions "My request", or one whose block never closes is returned
 * unchanged, as is a message that would be left empty.
 */
const AMBIENT_BLOCK = /^\s*<([A-Za-z][\w-]*-context)\s+source="ambient-ui-state"[^>]*>[\s\S]*?<\/\1>/
const AMBIENT_OPENING = /^\s*<[A-Za-z][\w-]*-context\s+source="ambient-ui-state"/
const REQUEST_HEADING = /^\s*## My request:[^\S\n]*(?:\n|$)/

export function stripAmbientContext(text) {
  if (typeof text !== "string") return text
  let rest = text
  let stripped = false
  for (let match = AMBIENT_BLOCK.exec(rest); match; match = AMBIENT_BLOCK.exec(rest)) {
    rest = rest.slice(match[0].length)
    stripped = true
  }
  // A further block that does not close is malformed: leave the whole message as it was written.
  if (!stripped || AMBIENT_OPENING.test(rest)) return text
  const request = rest.replace(REQUEST_HEADING, "").trim()
  return request || text
}
