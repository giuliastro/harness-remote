import { useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { activityLabel, groupConversationParts, type ConversationPartGroup } from "../conversation-parts"
import type { MessageEnvelope, MessagePart } from "../types"

const REMARK_PLUGINS = [remarkGfm]
const INTERNAL_PROTOCOL_PARTS = new Set(["step-start", "step-finish", "snapshot", "patch"])
type ActivityGroupValue = Extract<ConversationPartGroup, { kind: "activity" }>
type ContentGroupValue = Extract<ConversationPartGroup, { kind: "content" }>
type TaskDeskEnvelope = MessageEnvelope & { taskdesk?: { active?: boolean } }

function isInternalProtocolPart(part: MessagePart): boolean {
  return INTERNAL_PROTOCOL_PARTS.has(part.type)
}

function hasTerminalAssistantText(parts: MessagePart[]): boolean {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (isInternalProtocolPart(part)) continue
    if (part.type === "text") {
      if (typeof part.text === "string" && part.text.trim()) return true
      continue
    }
    if (part.type === "reasoning" || part.type === "tool") return false
  }
  return false
}

function ToolPartCard({ part }: { part: MessagePart }) {
  const state = part.state
  const status = state?.status || "running"
  const input = state?.input || {}
  const command = typeof input.command === "string"
    ? input.command
    : typeof input.filePath === "string"
      ? input.filePath
      : typeof input.path === "string"
        ? input.path
        : ""
  const output = state?.error || state?.output || ""
  const [open, setOpen] = useState(status === "error")

  useEffect(() => {
    if (status === "error") setOpen(true)
  }, [status])

  return (
    <div className="uw-tool-stack">
      <details
        className={`uw-tool-card uw-tool-${status}`}
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          <span className="uw-tool-icon">{status === "completed" ? "✓" : status === "error" ? "!" : "⋯"}</span>
          <span className="uw-tool-title">{state?.title || part.tool || "Tool"}</span>
          {command ? <code>{command.length > 90 ? `${command.slice(0, 90)}…` : command}</code> : null}
          <span className="uw-tool-status">{status}</span>
        </summary>
        {open && output ? <pre>{output.length > 4_000 ? `${output.slice(0, 4_000)}\n…` : output}</pre> : null}
      </details>
    </div>
  )
}

function UnsupportedPart({ part }: { part: MessagePart }) {
  const label = part.filename || part.tool || part.type || "unknown"
  return <div className="uw-unsupported-part" title={`Unsupported message part: ${part.type}`}>{label}</div>
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
        <div className="uw-markdown td3-markdown">
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{text}</ReactMarkdown>
        </div>
      ) : null}
      {other.map((part) => <UnsupportedPart key={part.id} part={part} />)}
    </div>
  )
}

function ActivityPart({ part }: { part: MessagePart }) {
  if (isInternalProtocolPart(part)) return null
  if ((part.type === "reasoning" || part.type === "text") && part.text) {
    return (
      <div className={`uw-reasoning${part.type === "text" ? " uw-working-note" : ""}`}>
        <strong>{part.type === "reasoning" ? "Reasoning" : "Working note"}</strong>
        <div className="uw-markdown td3-markdown">
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{part.text}</ReactMarkdown>
        </div>
      </div>
    )
  }
  if (part.type === "tool") return <ToolPartCard part={part} />
  return <UnsupportedPart part={part} />
}

function ActivityGroup({ group }: { group: ActivityGroupValue }) {
  const [open, setOpen] = useState(group.status === "error")
  const previousStatus = useRef(group.status)

  useEffect(() => {
    const prior = previousStatus.current
    previousStatus.current = group.status
    // Activity stays collapsed by default, including while streaming. Errors are the only state
    // that opens automatically. This keeps reasoning available without making it compete with chat.
    if (group.status === "error") setOpen(true)
    else if (prior === "running" && group.status === "completed") setOpen(false)
  }, [group.status])

  return (
    <details
      className={`uw-tool-card uw-activity-group uw-tool-${group.status}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="uw-tool-icon">{group.status === "completed" ? "✓" : group.status === "error" ? "!" : "⋯"}</span>
        <span className="uw-tool-title">{activityLabel(group)}</span>
        <span className="uw-tool-status">{group.status}</span>
      </summary>
      {open ? (
        <div className="uw-activity-parts">
          {group.parts.map((part) => <ActivityPart key={part.id} part={part} />)}
        </div>
      ) : null}
    </details>
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
  return readableErrorValue(error.data?.message) || readableErrorValue(error.message) || error.name || "The coding agent failed to complete this turn."
}

/**
 * Render one logical conversation turn. Transport-level text chunks are joined into one Markdown
 * body, while reasoning, tools and working narration remain inside Activity. Internal OpenCode
 * step/snapshot/patch markers stay protocol data and never leak into the chat. While a Run is live,
 * the whole assistant payload stays inside Activity so streamed chunks never jump between working
 * state and final dialogue.
 */
export function TaskDeskMessageContent({ message }: { message: MessageEnvelope }) {
  const liveAssistant = message.info.role === "assistant" && Boolean((message as TaskDeskEnvelope).taskdesk?.active)
  const visibleParts = message.parts.filter((part) => !isInternalProtocolPart(part))
  const groups = groupConversationParts(visibleParts, {
    forceActivity: liveAssistant,
    forceRunning: liveAssistant
  })
  const hasFinalText = hasTerminalAssistantText(message.parts)
  const turnError = liveAssistant || hasFinalText ? "" : messageErrorText(message)
  const hasActivity = visibleParts.some((part) => part.type === "reasoning" || part.type === "tool")
  const interruptedWithoutFinal = message.info.role === "assistant"
    && !liveAssistant
    && !turnError
    && hasActivity
    && !hasFinalText

  return (
    <div className="uw-message-parts">
      {groups.map((group, groupIndex) => {
        const key = group.parts[0]?.id || `${message.info.id}:${groupIndex}`
        if (group.kind === "content") return <ContentGroup group={group} key={key} />
        return <ActivityGroup group={group} key={key} />
      })}
      {turnError ? <div className="uw-message-turn-error" role="alert"><strong>Turn failed</strong><span>{turnError}</span></div> : null}
      {interruptedWithoutFinal ? <div className="uw-message-turn-error" role="alert"><strong>Response interrupted</strong><span>The coding agent stopped before producing a final answer.</span></div> : null}
    </div>
  )
}
