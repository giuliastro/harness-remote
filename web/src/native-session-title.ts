/**
 * A native Session's title belongs to the harness, and most harnesses derive it from the first
 * prompt they were given. When that prompt was a TaskDesk handoff packet the harness titled the
 * Session with the transport envelope, so the sidebar and the chat header showed
 * "You are taking over an existing TaskDesk task. The context below was transferred by TaskDesk…"
 * instead of the work. Several such Sessions are indistinguishable from each other in a list.
 *
 * This is display only: the native title is never rewritten, and Rename still writes whatever the
 * user types. Any title that is not a handoff packet is passed through untouched apart from
 * whitespace collapsing, which the row markup needs anyway.
 */

const HANDOFF_PREFIX = "You are taking over an existing TaskDesk task."

/** Every section header `formatTaskHandoff` and the client's `wirePrompt` can emit. */
const HANDOFF_SECTIONS = [
  "TRANSFERRED TASK CONTEXT",
  "TASK OBJECTIVE",
  "CURRENT STATE",
  "PREVIOUS STEP",
  "PREVIOUS RESULT",
  "LATEST ERROR",
  "WORKSPACE RESTORE",
  "CHANGED FILES",
  "WORKSPACE CHANGES",
  "RECENT TASK STEPS",
  "YOUR ROLE",
  "TARGET HARNESS",
  "USER INSTRUCTION",
  // Not a section, but the packet's closing sentence bounds the last one exactly like a header does.
  "Continue from the shared workspace"
]

const MAX_TITLE_CHARS = 160

/**
 * A harness that flattens the packet into one line loses the newlines the section markers relied
 * on, so the section is bounded by whichever other header comes next rather than by a line break.
 */
function handoffSection(flat: string, name: string): string {
  const start = flat.indexOf(name)
  if (start < 0) return ""
  const from = start + name.length
  let end = flat.length
  for (const header of HANDOFF_SECTIONS) {
    if (header === name) continue
    const at = flat.indexOf(header, from)
    if (at >= 0 && at < end) end = at
  }
  return flat.slice(from, end).trim()
}

function clip(value: string): string {
  return value.length > MAX_TITLE_CHARS ? `${value.slice(0, MAX_TITLE_CHARS - 1)}…` : value
}

export function nativeSessionDisplayTitle(title: string | undefined, fallback = "Untitled Session"): string {
  const flat = (title || "").replace(/\s+/g, " ").trim()
  if (!flat) return fallback
  if (!flat.startsWith(HANDOFF_PREFIX)) return flat
  // The instruction is what the user asked for; the objective is the Task it belongs to. Either is
  // a real name for this Session, and the envelope itself is not.
  const readable = handoffSection(flat, "USER INSTRUCTION") || handoffSection(flat, "TASK OBJECTIVE")
  return readable ? clip(readable) : "Transferred TaskDesk Task"
}
