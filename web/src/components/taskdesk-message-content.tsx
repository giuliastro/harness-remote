import { isInternalProtocolPart } from "../activity-model"
import { useActivityPreferences } from "../activity-preferences"
import { groupConversationParts, type ConversationPartGroup } from "../conversation-parts"
import { PaperclipIcon } from "../Icons"
import type { MessageEnvelope, MessagePart } from "../types"
import { ActivitySection, UnsupportedPart } from "./activity-timeline"
import { CopyButton, Markdown } from "./message-markdown"

type ContentGroupValue = Extract<ConversationPartGroup, { kind: "content" }>
type TaskDeskEnvelope = MessageEnvelope & { taskdesk?: { active?: boolean } }

/** Provider failures sometimes arrive twice: once as `message.info.error` and once as a normal text
 * part, with an HTTP status / `(type=...)` / `raw-http-request=...` suffix added by the transport.
 * Compare the human message rather than those wrappers so that copy is never mistaken for a real
 * final answer. */
function normalizeErrorComparable(value: string): string {
  return value
    .toLowerCase()
    .replace(/^\d{3}\s+/, "")
    .replace(/\s+raw-http-request=\S+/gi, "")
    .replace(/\s+\(type=[^)]+\)/gi, "")
    .replace(/\s+/g, " ")
    .trim()
}

function textMirrorsReportedError(text: string | undefined, reportedError: string): boolean {
  if (!text?.trim() || !reportedError.trim()) return false
  const candidate = normalizeErrorComparable(text)
  const expected = normalizeErrorComparable(reportedError)
  if (!candidate || !expected) return false
  if (candidate === expected) return true
  const longer = candidate.length >= expected.length ? candidate : expected
  const shorter = candidate.length >= expected.length ? expected : candidate
  if (!longer.startsWith(shorter)) return false
  // The field failure that motivated this guard repeats the provider sentence exactly twice. Keep
  // the tolerance bounded so a genuine recovery answer that merely quotes the old error still wins.
  return longer.length <= shorter.length * 2.35
}

function collapseRepeatedErrorBody(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean)
  if (words.length < 4) return value.trim()
  const midpoint = words.length / 2
  for (let split = Math.max(1, Math.floor(midpoint) - 1); split <= Math.min(words.length - 1, Math.ceil(midpoint) + 1); split += 1) {
    const left = words.slice(0, split).join(" ")
    const right = words.slice(split).join(" ")
    if (normalizeErrorComparable(left) && normalizeErrorComparable(left) === normalizeErrorComparable(right)) return left.trim()
  }
  return value.trim()
}

function cleanReportedErrorText(value: string): string {
  const raw = value.trim()
  if (!raw) return ""
  const status = raw.match(/^(\d{3})\s+/)?.[1] || ""
  const type = raw.match(/\(type=[^)]+\)/i)?.[0] || ""
  let body = raw
    .replace(/^\d{3}\s+/, "")
    .replace(/\s+raw-http-request=\S+/gi, "")
    .replace(/\s+\(type=[^)]+\)/gi, "")
    .trim()
  body = collapseRepeatedErrorBody(body)
  return [status, body, type].filter(Boolean).join(" ")
}

function hasTerminalAssistantText(parts: MessagePart[], reportedError = ""): boolean {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (isInternalProtocolPart(part)) continue
    if (part.type === "text") {
      if (typeof part.text === "string" && part.text.trim()) {
        if (reportedError && textMirrorsReportedError(part.text, reportedError)) continue
        return true
      }
      continue
    }
    if (part.type === "reasoning" || part.type === "tool") return false
  }
  return false
}

function AttachmentPartCard({ part }: { part: MessagePart }) {
  const label = part.filename || "Attached image"
  const isImage = (part.mime || "").startsWith("image/") && typeof part.url === "string" && part.url.startsWith("data:")
  return (
    <div className="uw-message-attachment" title={label}>
      {isImage ? <img src={part.url} alt={label} /> : <span className="uw-message-attachment-icon"><PaperclipIcon size={14} /></span>}
      <span>
        <strong>{label}</strong>
        <small>{part.mime || "attachment"}</small>
      </span>
    </div>
  )
}

function ContentGroup({ group }: { group: ContentGroupValue }) {
  const text = group.parts
    .filter((part) => part.type === "text" && typeof part.text === "string" && part.text.trim())
    .map((part) => part.text!.trim())
    .join("\n\n")
  const other = group.parts.filter((part) => part.type !== "text" && !isInternalProtocolPart(part))

  return (
    <div className="uw-message-content-group">
      {text ? (
        <>
          <Markdown text={text} />
          {/* Below the message rather than floating over it: a hover-revealed control is unreachable
              on the touch devices this app is mostly used from. */}
          <div className="uw-message-actions">
            <CopyButton text={text} label="Copy message" />
          </div>
        </>
      ) : null}
      {other.length ? (
        <div className="uw-message-attachments" aria-label="Attachments">
          {other.map((part) => (
            part.type === "file" || part.type === "image" || Boolean(part.mime && part.url)
              ? <AttachmentPartCard key={part.id} part={part} />
              : <UnsupportedPart key={part.id} part={part} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function readableErrorValue(value: unknown, depth = 0): string {
  if (depth > 4 || value == null) return ""
  if (typeof value === "string") {
    const text = value.trim()
    if (!text) return ""
    if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
      try {
        const nested = readableErrorValue(JSON.parse(text), depth + 1)
        if (nested) return nested
      } catch {
        // A provider error is often plain text that happens to begin with punctuation.
      }
    }
    return text
  }
  if (typeof value !== "object") return ""
  const record = value as Record<string, unknown>
  for (const key of ["message", "error", "detail", "data"]) {
    const text = readableErrorValue(record[key], depth + 1)
    if (text) return text
  }
  return ""
}

function messageErrorText(message: MessageEnvelope): string {
  const error = message.info.error
  if (!error) return ""
  const raw = readableErrorValue(error.data?.message)
    || readableErrorValue(error.message)
    || error.name
    || "The coding agent failed to complete this turn."
  const mirroredText = message.parts.find((part) =>
    part.type === "text"
    && typeof part.text === "string"
    && textMirrorsReportedError(part.text, raw)
  )?.text
  // Prefer the transport copy only when it mirrors the structured error: it may carry the useful
  // HTTP status / provider type that the structured payload omitted. Cleaning below removes only
  // duplicate prose and the private raw-request path.
  return cleanReportedErrorText(mirroredText || raw)
}

function assistantTurnCompleted(message: MessageEnvelope): boolean {
  if (message.info.time?.completed) return true
  const info = message.info as MessageEnvelope["info"] & { finish?: unknown }
  if (typeof info.finish === "string" && info.finish.trim()) return true
  return message.parts.some((part) => part.type === "step-finish")
}

/**
 * Render one logical conversation turn. Transport-level text chunks are joined into one Markdown
 * body, while reasoning, tools and working narration remain inside Activity. Internal OpenCode
 * step/snapshot/patch markers stay protocol data and never leak into the chat. While a Run is live,
 * the whole assistant payload stays inside Activity so streamed chunks never jump between working
 * state and final dialogue. A provider error can arrive one live-refresh frame before the owning
 * Conversation flips from running to failed; that terminal error wins over the stale active bit.
 */
export function TaskDeskMessageContent({ message }: { message: MessageEnvelope }) {
  const reportedError = messageErrorText(message)
  const hasFinalText = hasTerminalAssistantText(message.parts, reportedError)
  // Preserve recovery semantics: an old/intermediate error must not replace a later real answer.
  // When there is no final answer, however, the native error is already authoritative even if the
  // Conversation runtime still says running for one reconciliation frame.
  const liveTurnFailed = Boolean(reportedError) && !hasFinalText
  const liveAssistant = message.info.role === "assistant"
    && Boolean((message as TaskDeskEnvelope).taskdesk?.active)
    && !liveTurnFailed
  const visibleParts = message.parts.filter((part) => {
    if (isInternalProtocolPart(part)) return false
    // Some native providers emit their terminal failure as both structured error metadata and a
    // normal assistant text chunk. That chunk is transport duplication, not model prose.
    return !(reportedError && part.type === "text" && textMirrorsReportedError(part.text, reportedError))
  })
  const activityPreferences = useActivityPreferences()
  const groups = groupConversationParts(visibleParts, {
    forceActivity: liveAssistant,
    forceRunning: liveAssistant
  })
  const turnError = liveAssistant || hasFinalText ? "" : reportedError
  const hasActivity = visibleParts.some((part) => part.type === "reasoning" || part.type === "tool")
  // A deliberate interruption is a fact about the turn, not a failure: one neutral line, in place,
  // whichever harness recorded it. It also explains a missing final answer, so the red banner below
  // is only for a turn that stopped without anyone stopping it.
  const stopped = message.info.role === "assistant" && !liveAssistant && message.info.interrupted === true
  const interruptedWithoutFinal = message.info.role === "assistant"
    && !liveAssistant
    && !stopped
    && !turnError
    && assistantTurnCompleted(message)
    && hasActivity
    && !hasFinalText

  return (
    <div className="uw-message-parts">
      {groups.map((group, groupIndex) => {
        const key = group.parts[0]?.id || `${message.info.id}:${groupIndex}`
        if (group.kind === "content") return <ContentGroup group={group} key={key} />
        return <ActivitySection group={group} preferences={activityPreferences} key={key} />
      })}
      {turnError ? <div className="uw-message-turn-error" role="alert"><strong>Turn failed</strong><span>{turnError}</span></div> : null}
      {interruptedWithoutFinal ? <div className="uw-message-turn-error" role="alert"><strong>Response interrupted</strong><span>The coding agent stopped before producing a final answer.</span></div> : null}
      {stopped ? <div className="uw-message-turn-stopped" role="note">Interrupted</div> : null}
    </div>
  )
}
