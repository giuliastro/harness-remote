import type {
  AgentOption,
  CommandInfo,
  DiffFile,
  FileEntry,
  MessageEnvelope,
  MessagePart,
  ModelOption,
  QuestionRequest,
  Session,
  ToolState
} from "./types"

/**
 * Pure shape mappers from the OpenCode 2 (beta) wire format back into the app's existing types.
 *
 * Kept free of runtime sibling imports — everything here is either pure data transformation or a
 * type-only import — so the node test runner (which cannot resolve extensionless specifiers) can
 * load this file directly.
 */

export type V2Session = {
  id: string
  title?: string
  time: { created: number; updated: number }
  location?: { directory?: string }
  subpath?: string
  model?: { id?: string; providerID?: string; variant?: string }
  projectID?: string
  revert?: { messageID?: string; partID?: string }
  files?: Array<{ file: string; patch?: string; additions?: number; deletions?: number; status?: string }>
}

export function toSession(session: V2Session): Session {
  return {
    id: session.id,
    title: session.title ?? "",
    directory: session.location?.directory ?? "",
    time: { created: session.time.created, updated: session.time.updated },
    model: session.model && session.model.id
      ? { id: session.model.id, providerID: session.model.providerID ?? "", variant: session.model.variant }
      : undefined,
    project: session.projectID ? { id: session.projectID, worktree: session.location?.directory ?? "" } : undefined,
    revert: session.revert?.messageID ? { messageID: session.revert.messageID, partID: session.revert.partID } : undefined,
    summary: session.files?.length
      ? {
          files: session.files.length,
          additions: session.files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
          deletions: session.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
        }
      : undefined,
    external: false
  }
}

export function toToolState(state: {
  status?: string
  input?: unknown
  content?: Array<{ type?: string; text?: string }>
  error?: { message?: string }
  time?: { created?: number; ran?: number; completed?: number }
  metadata?: Record<string, unknown>
}): ToolState {
  const status = state?.status ?? "pending"
  const output = (state?.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
  return {
    status,
    input: (state?.input ?? {}) as Record<string, unknown> | undefined,
    output: output || undefined,
    error: state?.error?.message,
    time: state?.time
      ? { start: state.time.created ?? 0, end: state.time.completed }
      : undefined,
    metadata: state?.metadata
  }
}

export type V2Message = {
  id: string
  type: string
  time: { created: number; completed?: number }
  text?: string
  description?: string
  files?: unknown[]
  agent?: string
  model?: { id?: string; providerID?: string; variant?: string }
  content?: Array<Record<string, unknown>>
  command?: string
  status?: string
  output?: { output?: string }
  skill?: string
  name?: string
  summary?: string
  recent?: string
  location?: unknown
}

/** Flattens one v2 message (a discriminated union) into the app's `MessageEnvelope` shape. */
export function toMessageEnvelope(message: V2Message, sessionID: string): MessageEnvelope {
  const role = message.type === "user" ? "user" : message.type === "assistant" ? "assistant" : "system"
  const info = {
    id: message.id,
    role,
    sessionID,
    time: { created: message.time.created, completed: message.time.completed }
  }

  const parts: MessagePart[] = []
  if (message.type === "user") {
    parts.push({ id: `${message.id}:text`, type: "text", text: message.text ?? "" })
  } else if (message.type === "assistant") {
    for (const [index, part] of (message.content ?? []).entries()) {
      const partID = typeof part.id === "string" ? part.id : `${message.id}:part:${index}`
      if (part.type === "text") {
        parts.push({ id: partID, messageID: message.id, type: "text", text: typeof part.text === "string" ? part.text : "" })
      } else if (part.type === "reasoning") {
        parts.push({ id: partID, messageID: message.id, type: "reasoning", text: typeof part.text === "string" ? part.text : "" })
      } else if (part.type === "tool") {
        const tool = part as {
          id?: string
          name?: string
          state?: { status?: string; input?: unknown; content?: Array<{ type?: string; text?: string }>; error?: { message?: string }; metadata?: Record<string, unknown> }
          time?: { created?: number; ran?: number; completed?: number }
        }
        parts.push({
          id: partID,
          messageID: message.id,
          type: "tool",
          tool: tool.name ?? "tool",
          callID: tool.id,
          state: toToolState(tool.state ?? {})
        })
      }
    }
  } else if (message.type === "shell") {
    parts.push({
      id: `${message.id}:shell`,
      messageID: message.id,
      type: "tool",
      tool: "shell",
      callID: message.id,
      state: {
        status: message.status === "running" ? "running" : "completed",
        input: message.command ? { command: message.command } : undefined,
        output: message.output?.output,
        time: { start: message.time.created, end: message.time.completed }
      }
    })
  } else {
    // Synthetic, system, skill, compaction and switch messages carry a summary line; render them as text.
    const text = message.text ?? (message.type === "compaction" ? `${message.summary ?? ""}${message.recent ? `\n\n${message.recent}` : ""}` : "")
    if (text) parts.push({ id: `${message.id}:text`, type: "text", text })
  }

  return { info, parts }
}

/** v2 returns messages newest-first by default; the app renders oldest-first. */
export function chronological(messages: V2Message[], sessionID: string): MessageEnvelope[] {
  return [...messages].reverse().map((message) => toMessageEnvelope(message, sessionID))
}

export function toModelOption(model: {
  id?: string
  modelID?: string
  providerID?: string
  name?: string
  description?: string
  status?: string
  enabled?: boolean
  limit?: { context?: number; input?: number; output?: number }
  capabilities?: { tools?: boolean; input?: string[] }
  variants?: Array<{ id?: string }>
}, defaultModelID?: string): ModelOption[] {
  const providerID = model.providerID ?? ""
  const modelID = model.modelID ?? model.id ?? ""
  if (!providerID || !modelID) return []
  const base: ModelOption = {
    providerID,
    providerName: providerID,
    modelID,
    modelName: model.name ?? modelID,
    description: model.description,
    status: model.status,
    contextLimit: model.limit?.context,
    outputLimit: model.limit?.output,
    tools: Boolean(model.capabilities?.tools),
    attachments: Boolean(model.capabilities?.input?.includes("image") || model.capabilities?.input?.includes("video")),
    // v2 model entries commonly carry only `id`; compare against the same id we resolved above so the
    // default flag survives when `modelID` is absent.
    isDefault: Boolean(modelID) && modelID === defaultModelID
  }
  const variants = (model.variants ?? []).map((variant) => variant.id).filter(Boolean) as string[]
  return [base, ...variants.map((variant) => ({ ...base, variant, isDefault: false }))]
}

export function toAgentOption(agent: { id: string; name?: string; description?: string; mode?: string; hidden?: boolean }): AgentOption {
  return {
    id: agent.id,
    name: agent.name ?? agent.id,
    description: agent.description,
    mode: (agent.mode as AgentOption["mode"]) ?? "all",
    hidden: agent.hidden
  }
}

export function toCommandOption(command: { name: string; description?: string }): CommandInfo {
  return { name: command.name, description: command.description }
}

export function toFileEntry(entry: { path: string; type: "file" | "directory" }, root: string): FileEntry {
  const name = entry.path.split("/").filter(Boolean).pop() ?? entry.path
  const absolute = entry.path.startsWith("/") ? entry.path : `${root.replace(/\/$/, "")}/${entry.path}`
  return { name, path: absolute, absolute, type: entry.type }
}

export function toDiffFile(file: { file: string; patch?: string; additions?: number; deletions?: number; status?: string }): DiffFile {
  return {
    file: file.file,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    patch: file.patch,
    status: file.status as DiffFile["status"]
  }
}

export type V2FormOption = { value: string; label: string; description?: string }
export type V2FormField = {
  key: string
  title?: string
  description?: string
  type?: string
  options?: V2FormOption[]
  custom?: boolean
  required?: boolean
}
export type V2Form = { id: string; sessionID: string; title?: string; fields: V2FormField[] }

/**
 * v2 "forms" replace the v1 question flow. The app UI only understands the flat `QuestionInfo`
 * shape and selects options by their display label, so we surface one question per field and keep
 * the protocol's `key`/`value`/`type` metadata for the reply step (see {@link toFormAnswer}).
 */
export function toQuestionRequest(form: V2Form): QuestionRequest {
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions: (form.fields ?? []).map((field) => ({
      question: field.title ?? field.key,
      header: form.title ?? field.title ?? field.key,
      options: (field.options ?? []).map((option) => ({ label: option.label, description: option.description ?? "" })),
      multiple: field.type === "multiselect",
      custom: field.custom ?? false
    }))
  }
}

/** Shape one field's selected values by the field's declared type (v2 accepts string | number | boolean | string[]). */
function shapeFieldValue(field: V2FormField, values: string[]): unknown {
  if (field.type === "multiselect") return values
  const first = values[0] ?? ""
  if (field.type === "number") {
    const parsed = Number(first)
    return Number.isFinite(parsed) ? parsed : first
  }
  if (field.type === "boolean" || field.type === "confirm") return first === "true" || first === "yes"
  return first
}

/**
 * Translate the app's per-question answers (arrays of the selected option *labels*, indexed to match
 * `form.fields`) back into v2's answer object: keyed by `field.key`, submitting each option's `value`
 * rather than its label, and typed per field. Free-text/custom answers with no matching option pass
 * through unchanged.
 */
export function toFormAnswer(form: V2Form, answersByIndex: string[][]): Record<string, unknown> {
  const answer: Record<string, unknown> = {}
  ;(form.fields ?? []).forEach((field, index) => {
    const labels = answersByIndex[index] ?? []
    const values = labels.map((label) => {
      const option = (field.options ?? []).find((candidate) => candidate.label === label)
      return option ? option.value : label
    })
    answer[field.key] = shapeFieldValue(field, values)
  })
  return answer
}
