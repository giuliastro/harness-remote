import type { MessagePart } from "./types"

/**
 * The reading model behind a turn's Activity section.
 *
 * The harness hands over a flat list of parts - reasoning chunks, tool calls and the narration the
 * agent writes between them. Rendered one card per part, a twenty-step turn is twenty
 * indistinguishable boxes and the two sentences that explain what the agent is doing are buried
 * among them. This module regroups the list into what a reader actually scans:
 *
 * - a **note** is the agent talking to the user mid-turn ("Tests fail on Windows, checking the
 *   path handling"). It is the highest-value thing in the section, so it is never folded away
 *   inside another item;
 * - a **thought** is one uninterrupted stretch of reasoning, however many chunks it streamed in;
 * - a **steps** item is one uninterrupted run of tool calls, which render as compact one-line rows.
 *
 * Everything here is pure so the grouping and the wording it feeds are testable without React.
 */

export type ToolKind = "run" | "read" | "edit" | "search" | "web" | "task" | "todo" | "tool"

export type ActivityItem =
  | { kind: "note"; id: string; part: MessagePart }
  | { kind: "thought"; id: string; parts: MessagePart[] }
  | { kind: "steps"; id: string; parts: MessagePart[] }
  | { kind: "other"; id: string; part: MessagePart }

const INTERNAL_PROTOCOL_PARTS = new Set(["step-start", "step-finish", "snapshot", "patch"])

/** Wire states that mean a call is still open; see `conversation-parts.ts` for why it is an allow-list. */
export const LIVE_TOOL_STATUSES = new Set(["pending", "running", "in_progress"])

export function isInternalProtocolPart(part: MessagePart): boolean {
  return INTERNAL_PROTOCOL_PARTS.has(part.type)
}

function hasText(part: MessagePart): boolean {
  return typeof part.text === "string" && part.text.trim().length > 0
}

export function buildActivityTimeline(parts: MessagePart[]): ActivityItem[] {
  const items: ActivityItem[] = []
  for (const part of parts) {
    if (isInternalProtocolPart(part)) continue
    const previous = items[items.length - 1]
    if (part.type === "reasoning") {
      // An empty reasoning chunk still matters while it is open: it is the only sign the model is
      // thinking. Once closed with no text it carries nothing and is dropped.
      if (!hasText(part) && part.time?.end) continue
      if (previous?.kind === "thought") previous.parts.push(part)
      else items.push({ kind: "thought", id: `thought:${part.id}`, parts: [part] })
      continue
    }
    if (part.type === "tool") {
      if (previous?.kind === "steps") previous.parts.push(part)
      else items.push({ kind: "steps", id: `steps:${part.id}`, parts: [part] })
      continue
    }
    if (part.type === "text") {
      if (hasText(part)) items.push({ kind: "note", id: `note:${part.id}`, part })
      continue
    }
    items.push({ kind: "other", id: `other:${part.id}`, part })
  }
  return items
}

const TOOL_KIND_PATTERNS: Array<[ToolKind, RegExp]> = [
  ["todo", /(^|[\s_-])(todo\w*|update_plan|plan)($|[\s_-])/],
  ["run", /(^|[\s_-])(bash|shell|exec\w*|run|terminal|command|process|powershell|cmd)($|[\s_-])/],
  ["edit", /(^|[\s_-])(write|edit|notebook\w*|multiedit|patch|apply\w*|create|append|replace|str_replace\w*|delete|move|rename)($|[\s_-])/],
  ["read", /(^|[\s_-])(read\w*|cat|view|open|list|ls|tree)($|[\s_-])/],
  ["search", /(^|[\s_-])(grep|glob|search|find|rg|lookup|codesearch)($|[\s_-])/],
  ["web", /(^|[\s_-])(web\w*|fetch|http|browser|url|crawl)($|[\s_-])/],
  ["task", /(^|[\s_-])(task|agent|subagent|delegate)($|[\s_-])/]
]

function kindFromName(tool: string | undefined): ToolKind {
  const name = (tool || "").toLowerCase()
  for (const [kind, pattern] of TOOL_KIND_PATTERNS) {
    if (pattern.test(name)) return kind
  }
  return "tool"
}

/** ACP's own classification, when the adapter sends one. `think` is what Claude reports for Task
 *  (a subagent) and for its plan tools; the name tells those two apart. */
const ACP_KINDS: Record<string, ToolKind> = {
  execute: "run", read: "read", edit: "edit", delete: "edit", move: "edit", search: "search", fetch: "web"
}

/**
 * What kind of work a call did. The order is from most to least trustworthy: the protocol's own
 * label, then a real tool name, then the shape of the input, and only last a title - which for a
 * shell call is the command line, where "git diff | cat" would otherwise read as a file read.
 */
export function toolKind(part: MessagePart): ToolKind {
  const acp = typeof part.kind === "string" ? ACP_KINDS[part.kind] : undefined
  if (acp) return acp
  const title = part.state?.title
  const named = part.tool && part.tool !== title ? kindFromName(part.tool) : "tool"
  if (named !== "tool") return named
  if (part.kind === "think") return /todo|plan/i.test(part.tool || "") ? "todo" : "task"
  const input = (part.state?.input && typeof part.state.input === "object" ? part.state.input : {}) as Record<string, unknown>
  if ("command" in input || "cmd" in input) return "run"
  if ("old_string" in input || "oldString" in input || "new_string" in input || "newString" in input) return "edit"
  if ("todos" in input) return "todo"
  if ("pattern" in input || "query" in input) return "search"
  if ("url" in input) return "web"
  if ("file_path" in input || "filePath" in input) return "content" in input ? "edit" : "read"
  return kindFromName(part.tool || title)
}

function inputString(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value.trim()
    // Codex reports a command as an argv array.
    if (Array.isArray(value) && value.length && value.every((item) => typeof item === "string")) return value.join(" ")
  }
  return ""
}

/**
 * Harnesses do not agree on the shape of a failure: a sentence, an `Error`, an argv array, or a
 * provider envelope such as `{ type: "tool.execution", message: "..." }`. Presentation needs one
 * string, and assuming it was already a string is what called `.split()` on an object and let a
 * single failed tool call take the whole app down through the global error boundary.
 */
export function textValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  if (value instanceof Error) return value.message
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("\n")
  if (typeof value === "object") {
    const record = value as {
      message?: unknown
      data?: { message?: unknown }
      type?: unknown
      name?: unknown
    }
    const nested = textValue(record.message)
      || textValue(record.data?.message)
      || textValue(record.type)
      || textValue(record.name)
    if (nested) return nested
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  return String(value)
}

function firstLine(value: unknown): string {
  const line = textValue(value).split(/\r?\n/).find((candidate) => candidate.trim()) ?? ""
  return line.trim()
}

/** ACP titles quote the command in backticks; the row already sets it in monospace. */
function unquote(value: string): string {
  return value.replace(/`/g, "").trim()
}

export type ToolDescription = {
  kind: ToolKind
  /** The harness tool name, shown when no verb fits the kind. */
  name: string
  /** What the call acted on: the command, the file, the pattern. One line. */
  target: string
  /** The title is a whole sentence and the row should show it instead of verb + target. */
  titleOnly: boolean
  /** The full command, for the expanded view; empty when it adds nothing to `target`. */
  command: string
  path: string
  edit?: { before: string; after: string }
}

export function describeTool(part: MessagePart): ToolDescription {
  const state = part.state
  const input = (state?.input && typeof state.input === "object" ? state.input : {}) as Record<string, unknown>
  const name = (part.tool || state?.title || "tool").trim()
  const title = unquote((state?.title || "").trim())
  const kind = toolKind(part)
  const command = inputString(input, ["command", "cmd", "script"])
  const path = inputString(input, ["filePath", "file_path", "path", "notebook_path", "target_file", "file", "directory"])
  const pattern = inputString(input, ["pattern", "query", "regex", "q"])
  const url = inputString(input, ["url", "uri"])
  const description = inputString(input, ["description", "prompt", "subagent_type"])

  let target = ""
  if (kind === "run") target = firstLine(command) || description
  else if (kind === "read" || kind === "edit") target = path
  else if (kind === "search") target = pattern ? (path ? `${pattern}  ·  ${path}` : pattern) : path
  else if (kind === "web") target = url || pattern
  else if (kind === "task") target = firstLine(description)
  else if (kind === "tool") target = firstLine(command) || path || pattern || url || firstLine(description)
  // The ACP title is often already the best one-line description ("Read src/app.ts"); it is the
  // fallback whenever the structured input did not name a target, provided it says more than the
  // bare tool name does.
  if (!target && title && title.toLowerCase() !== name.toLowerCase()) target = firstLine(title)

  const before = inputString(input, ["oldString", "old_string", "old_str"])
  const after = inputString(input, ["newString", "new_string", "new_str", "content"])
  return {
    kind,
    name,
    target,
    // A harness that sends no tool name sends a sentence as the title ("Run npm test"). Putting a
    // verb in front of it would read "Ran Run npm test", so such a title is shown as it is.
    titleOnly: !target && /\s/.test(title) && unquote(name).toLowerCase() === title.toLowerCase(),
    // A shell call always shows its full command when opened: the row clips it to one line.
    command: kind === "run" || command !== target ? command : "",
    path,
    edit: kind === "edit" && (before || after) ? { before, after } : undefined
  }
}

export function toolStatus(part: MessagePart): "running" | "completed" | "error" | "incomplete" {
  const status = part.state?.status || "running"
  if (LIVE_TOOL_STATUSES.has(status)) return "running"
  if (status === "error" || status === "failed") return "error"
  if (status === "completed") return "completed"
  return "incomplete"
}

export function isThoughtRunning(parts: MessagePart[]): boolean {
  return parts.some((part) => typeof part.time?.start === "number" && part.time.start > 0 && !part.time.end)
}

function partTime(part: MessagePart): { start?: number; end?: number } {
  return part.type === "tool" ? part.state?.time ?? {} : part.time ?? {}
}

/** First start to last end across the parts, or undefined when the harness sent no usable clock. */
export function spanMs(parts: MessagePart[]): number | undefined {
  let start = Infinity
  let end = -Infinity
  for (const part of parts) {
    const time = partTime(part)
    if (typeof time.start === "number" && time.start > 0) start = Math.min(start, time.start)
    if (typeof time.end === "number" && time.end > 0) end = Math.max(end, time.end)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  const ms = end - start
  return ms >= 0 && ms <= 86_400_000 ? ms : undefined
}

export function startedAt(parts: MessagePart[]): number | undefined {
  for (const part of parts) {
    const start = partTime(part).start
    if (typeof start === "number" && start > 0) return start
  }
  return undefined
}

/** Sub-second spans stay unlabelled: "0.4s" on every row is noise rather than information. */
export function formatSpan(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 1_000) return ""
  if (ms < 60_000) return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
}

export type ActivitySummary = {
  counts: Partial<Record<ToolKind, number>>
  tools: number
  notes: number
  thoughts: number
  durationMs?: number
}

export function summarizeActivity(parts: MessagePart[]): ActivitySummary {
  const summary: ActivitySummary = { counts: {}, tools: 0, notes: 0, thoughts: 0 }
  for (const item of buildActivityTimeline(parts)) {
    if (item.kind === "note") summary.notes += 1
    if (item.kind === "thought") summary.thoughts += 1
    if (item.kind !== "steps") continue
    for (const part of item.parts) {
      const kind = toolKind(part)
      summary.counts[kind] = (summary.counts[kind] ?? 0) + 1
      summary.tools += 1
    }
  }
  summary.durationMs = spanMs(parts.filter((part) => !isInternalProtocolPart(part)))
  return summary
}

export type CurrentStep =
  | { kind: "tool"; part: MessagePart }
  | { kind: "thinking" }
  | { kind: "writing" }

/** What a live turn is doing right now, for the one line its collapsed header has room for. */
export function currentStep(parts: MessagePart[]): CurrentStep | null {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (isInternalProtocolPart(part)) continue
    if (part.type === "tool") return toolStatus(part) === "running" ? { kind: "tool", part } : null
    if (part.type === "reasoning") return part.time?.end ? null : { kind: "thinking" }
    if (part.type === "text") return hasText(part) ? { kind: "writing" } : null
    return null
  }
  return null
}

/** The most recent thing the agent said to the user, for the live "latest update" view. */
export function latestNote(parts: MessagePart[]): MessagePart | undefined {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part.type === "text" && hasText(part)) return part
  }
  return undefined
}
