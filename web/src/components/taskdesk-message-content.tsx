import { useEffect, useRef, useState } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { copyToClipboard } from "../clipboard"
import { activityLabel, groupConversationParts, type ConversationPartGroup } from "../conversation-parts"
import {
  AlertIcon, CheckIcon, CommandIcon, CopyIcon, FolderIcon, PaperclipIcon, PencilIcon, SearchIcon, ServerIcon,
  SparkIcon, TaskListIcon
} from "../Icons"
import type { MessageEnvelope, MessagePart, TodoItem } from "../types"

const REMARK_PLUGINS = [remarkGfm]
const INTERNAL_PROTOCOL_PARTS = new Set(["step-start", "step-finish", "snapshot", "patch"])
type ActivityGroupValue = Extract<ConversationPartGroup, { kind: "activity" }>
type ContentGroupValue = Extract<ConversationPartGroup, { kind: "content" }>
type TaskDeskEnvelope = MessageEnvelope & { taskdesk?: { active?: boolean } }

function isInternalProtocolPart(part: MessagePart): boolean {
  return INTERNAL_PROTOCOL_PARTS.has(part.type)
}

/** Reads the source text back out of a rendered subtree, so a copy carries what the agent wrote
 *  rather than what Markdown turned it into. Walking the hast node avoids reaching into React
 *  children, which by this point are elements and no longer strings. */
function hastText(node: unknown): string {
  if (!node || typeof node !== "object") return ""
  const element = node as { type?: string; value?: string; children?: unknown[] }
  if (element.type === "text") return element.value ?? ""
  if (!Array.isArray(element.children)) return ""
  return element.children.map(hastText).join("")
}

/**
 * `clipboard.ts` was written for this app's plain-http LAN case, where `navigator.clipboard` is
 * absent rather than merely refused, and until now only the retired 2.x shell used it: 3.0 shipped
 * with no way to copy anything out of a conversation at all. Every reference chat client offers this
 * on both code blocks and whole messages, and for an agent that answers with commands and patches it
 * is the most common thing to want from a reply.
 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])

  // An empty copy would silently replace whatever the user already had on the clipboard.
  if (!text.trim()) return null

  return (
    <button
      type="button"
      className={`uw-copy-button${copied ? " copied" : ""}`}
      // The label carries the state because the icon alone does not: a checkmark is not text.
      title={copied ? "Copied" : label}
      aria-label={copied ? "Copied" : label}
      onClick={() => {
        void copyToClipboard(text)
        setCopied(true)
      }}
    >
      {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
    </button>
  )
}

/** Stable identity: rebuilding this per render would remount every code block on every token. */
const MARKDOWN_COMPONENTS: Components = {
  pre({ node, children, ...rest }) {
    return (
      <div className="uw-code-block">
        <CopyButton text={hastText(node)} label="Copy code" />
        <pre {...rest}>{children}</pre>
      </div>
    )
  }
}

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

function parseTodos(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value)) return null
  const items = value.filter(
    (item): item is TodoItem => Boolean(item)
      && typeof item === "object"
      && typeof (item as TodoItem).content === "string"
  )
  return items.length ? items : null
}

function TodoListView({ items }: { items: TodoItem[] }) {
  return (
    <div className="uw-tool-todo-list" aria-label="Todo list">
      {items.map((item, index) => (
        <div className={`uw-tool-todo-item ${item.status || "pending"}`} key={item.id || `${index}:${item.content}`}>
          <span className="uw-tool-todo-status" aria-hidden="true">
            {item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : "○"}
          </span>
          <span>{item.content}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Beautiful UI's tool-call pattern names the *kind* of work before the tool that did it: a file read
 * and a shell command are different enough that one identical grey row for both is what makes a long
 * Activity block unreadable. The harness only reports a tool name, so the kind is derived from it
 * once, here, and every visual difference hangs off the class this returns.
 */
type ToolKind = "read" | "edit" | "run" | "search" | "web" | "task" | "tool"

const TOOL_KINDS: Record<ToolKind, RegExp | null> = {
  run: /(^|[-_])(bash|shell|exec|run|terminal|command|process)/,
  edit: /(^|[-_])(write|edit|patch|apply|create|append|multiedit|replace)/,
  read: /(^|[-_])(read|cat|view|open|list|ls|tree)/,
  search: /(^|[-_])(grep|glob|search|find|rg|lookup)/,
  web: /(^|[-_])(web|fetch|http|browser|url|crawl)/,
  task: /(^|[-_])(task|agent|todo|plan|delegate)/,
  tool: null
}

/**
 * Real icons rather than the unicode glyphs this started with. A "\u25a4" is a character borrowed to
 * look like a picture: it inherits the text metrics, sits on the text baseline, and renders as a
 * different shape on every platform - which on Android was a box. These are the same stroked set the
 * rest of the app already draws with.
 */
const TOOL_KIND_ICON: Record<ToolKind, (props: { size?: number }) => JSX.Element> = {
  read: FolderIcon, edit: PencilIcon, run: CommandIcon, search: SearchIcon,
  web: ServerIcon, task: TaskListIcon, tool: SparkIcon
}

function toolKind(tool: string | undefined): ToolKind {
  const name = (tool || "").toLowerCase()
  for (const [kind, pattern] of Object.entries(TOOL_KINDS) as [ToolKind, RegExp | null][]) {
    if (pattern && pattern.test(name)) return kind
  }
  return "tool"
}

/**
 * A call's cost is the second thing worth knowing after its name - "which step is slow" is otherwise
 * unanswerable from a transcript. Sub-second calls stay unlabelled on purpose: a "0.4s" on every row
 * is noise rather than information.
 */
function formatDuration(time: { start: number; end?: number } | undefined): string {
  if (!time?.start || !time.end) return ""
  const ms = time.end - time.start
  if (!Number.isFinite(ms) || ms < 1_000 || ms > 86_400_000) return ""
  if (ms < 60_000) return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

/**
 * The protocol words were reaching the screen unchanged, so a finished call read "completed" and a
 * failed one "error". Same rule as `activityStatusLabel` below, applied to the row that carries it.
 */
function toolStatusLabel(status: string): string {
  if (status === "running") return "Working"
  if (status === "completed") return "Done"
  if (status === "error") return "Failed"
  if (status === "incomplete") return "No result"
  return status
}

/**
 * The live Activity header is the only thing on screen while a turn is thinking, and "Working" with
 * no clock behind it reads the same at two seconds as at two minutes. The elapsed time is taken from
 * the harness's own part timestamps wherever it sends them, so a reopened Session shows the age of
 * the work rather than the age of the render.
 */
function activityStartedAt(group: ActivityGroupValue): number | undefined {
  for (const part of group.parts) {
    const start = part.state?.time?.start ?? part.time?.start
    if (typeof start === "number" && start > 0) return start
  }
  return undefined
}

function useElapsedLabel(startedAt: number | undefined, running: boolean): string {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running || !startedAt) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [running, startedAt])

  if (!running || !startedAt) return ""
  const seconds = Math.floor((now - startedAt) / 1000)
  // A harness that reports seconds where the type says milliseconds would otherwise render a clock
  // reading in decades. Out-of-range means "no timestamp worth showing", not "show it anyway".
  if (seconds < 2 || seconds > 86_400) return ""
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/**
 * `incomplete` is the bridge's marker for a call whose turn ended before the harness reported an
 * outcome: finished work with nothing to show, so it takes neither the spinner nor the failure mark.
 * The spinner is a bare span the stylesheet turns: an SVG that has to re-rasterise every frame is
 * the wrong thing to put on a phone once six of them are on screen at once.
 */
function ToolStatusIcon({ status }: { status: string }): JSX.Element {
  return (
    <span className="uw-tool-icon" aria-hidden="true">
      {status === "completed" ? <CheckIcon size={12} />
        : status === "error" ? <AlertIcon size={12} />
          : status === "incomplete" ? <span className="bui-status-none" />
            : <span className="bui-spinner" />}
    </span>
  )
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
  const todos = (part.tool || "").toLowerCase() === "todowrite" ? parseTodos(input.todos) : null
  const kind = toolKind(part.tool)
  const KindIcon = TOOL_KIND_ICON[kind]
  const duration = formatDuration(state?.time)
  const [open, setOpen] = useState(status === "error")

  useEffect(() => {
    if (status === "error") setOpen(true)
  }, [status])

  return (
    <div className="uw-tool-stack">
      <details
        className={`uw-tool-card uw-tool-${status} bui-tool bui-tool-${kind}`}
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          {/* `incomplete` is the bridge's marker for a call whose turn ended before the harness
              reported an outcome: it is finished work with nothing to show, so it takes neither the
              running ellipsis nor the failure mark. */}
          <ToolStatusIcon status={status} />
          <span className="uw-tool-title">
            <span className="bui-tool-kind" aria-hidden="true">{KindIcon({ size: 12 })}</span>
            {state?.title || part.tool || "Tool"}
          </span>
          {command ? <code>{command.length > 90 ? `${command.slice(0, 90)}…` : command}</code> : null}
          {/* Duration and status share one grid cell so the summary keeps the column count its
              stylesheet lays out; a fifth child would put the status under the command instead. */}
          <span className="bui-tool-meta">
            {duration ? <span className="bui-tool-duration">{duration}</span> : null}
            <span className="uw-tool-status">{toolStatusLabel(status)}</span>
          </span>
        </summary>
        {/* The truncated body is what is on screen, but the copy carries the whole output: a stack
            trace clipped at 4000 characters is the half you cannot paste anywhere useful. */}
        {open && todos ? <TodoListView items={todos} /> : null}
        {open && output && !todos ? (
          <div className="uw-code-block">
            <CopyButton text={output} label="Copy output" />
            <pre>{output.length > 4_000 ? `${output.slice(0, 4_000)}\n…` : output}</pre>
          </div>
        ) : null}
      </details>
    </div>
  )
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
        <>
          <div className="uw-markdown">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>
          </div>
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

function ActivityPart({ part }: { part: MessagePart }) {
  if (isInternalProtocolPart(part)) return null
  if ((part.type === "reasoning" || part.type === "text") && part.text) {
    return (
      <div className={`uw-reasoning${part.type === "text" ? " uw-working-note" : ""}`}>
        <strong>{part.type === "reasoning" ? "Reasoning" : "Working note"}</strong>
        <div className="uw-markdown">
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>{part.text}</ReactMarkdown>
        </div>
      </div>
    )
  }
  if (part.type === "tool") return <ToolPartCard part={part} />
  return <UnsupportedPart part={part} />
}

/**
 * The 3.0 shell used to relabel this with `font-size: 0` plus a `content: "Working"` pseudo-element.
 * User-facing copy in CSS is invisible to translation and to anything that reads the DOM, and it
 * left the raw protocol word "running" as the element's real text.
 */
function activityStatusLabel(status: string): string {
  return status === "running" ? "Working" : status
}

function ActivityGroup({ group }: { group: ActivityGroupValue }) {
  const [open, setOpen] = useState(group.status === "error")
  const previousStatus = useRef(group.status)
  const running = group.status === "running"
  const elapsed = useElapsedLabel(activityStartedAt(group), running)

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
      className={`uw-tool-card uw-activity-group uw-tool-${group.status} bui-activity`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <ToolStatusIcon status={group.status} />
        <span className="uw-tool-title">{activityLabel(group)}</span>
        <span className="bui-tool-meta">
          {elapsed ? <span className="bui-tool-duration">{elapsed}</span> : null}
          <span className="uw-tool-status">{activityStatusLabel(group.status)}</span>
        </span>
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
        return <ActivityGroup group={group} key={key} />
      })}
      {turnError ? <div className="uw-message-turn-error" role="alert"><strong>Turn failed</strong><span>{turnError}</span></div> : null}
      {interruptedWithoutFinal ? <div className="uw-message-turn-error" role="alert"><strong>Response interrupted</strong><span>The coding agent stopped before producing a final answer.</span></div> : null}
      {stopped ? <div className="uw-message-turn-stopped" role="note">Interrupted</div> : null}
    </div>
  )
}
