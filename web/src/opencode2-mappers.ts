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
  // v2 `/api/command` entries carry no source of their own, so classify them explicitly — the UI
  // groups the picker by source and offers a skill-only filter (the OMP bridge does the same).
  return { name: command.name, description: command.description, source: "command" }
}

/**
 * One `GET /api/skill` entry (`SkillV2.Info`). The live contract requires `id`, `name`, `location`
 * and `content`; `description`, `slash` and `autoinvoke` are optional. `id` is the skill's stable
 * identity in the catalog (used to activate it), while `name` is its user-facing slash name.
 */
export type V2Skill = {
  id: string
  name: string
  location: string
  content: string
  description?: string
  /** `false` hides the skill from the V2 slash-command catalog. */
  slash?: boolean
  /** Skills the server activates on its own; not a picker-visibility control (`slash` is). */
  autoinvoke?: boolean
}

/**
 * Map one v2 `/api/skill` entry into the app's command representation. A skill's user-facing slash
 * name is its `name`; entries with `slash: false` (or no name) are hidden from the slash catalog and
 * map to `null`. The skill's stable `id` and `autoinvoke` flag ride along on the mapped entry so
 * activation and filtering stay possible after the merge (see {@link mergeCommandCatalog}).
 */
export function toSkillCommand(skill: V2Skill): CommandInfo | null {
  if (!skill.name || skill.slash === false) return null
  return {
    name: skill.name,
    description: skill.description,
    source: "skill",
    id: skill.id,
    autoinvoke: skill.autoinvoke
  }
}

/**
 * The exact wire body for `POST /api/session/{sessionID}/skill` (`v2.session.skill`): the endpoint
 * takes `{ skill, resume?, id? }`, forbids extra properties, and answers 204. Activation appends a
 * skill message and resumes execution, so the client always posts `resume: true` and omits the
 * optional `id`.
 */
export function toSkillActivationBody(skill: string): { skill: string; resume: boolean } {
  return { skill, resume: true }
}

/**
 * Combine the command and skill catalogs into one slash-name catalog without duplicate user-facing
 * names. Server commands win a name collision (skills have lower priority, matching OpenCode's own
 * slash handling), and the merged order preserves commands-then-skills.
 */
export function mergeCommandCatalog(commands: CommandInfo[], skills: CommandInfo[]): CommandInfo[] {
  const seen = new Set<string>()
  const merged: CommandInfo[] = []
  for (const entry of [...commands, ...skills]) {
    if (!entry.name || seen.has(entry.name)) continue
    seen.add(entry.name)
    merged.push(entry)
  }
  return merged
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

export type V2FormValue = string | number | boolean | string[]
export type V2FormOption = { value: string; label: string; description?: string }
export type V2FormWhen = { key: string; op: "eq" | "neq"; value: string | number | boolean }
export type V2FormField = {
  key: string
  title?: string
  description?: string
  // Documented v2 field types: string | number | integer | boolean | multiselect | external
  // (plus `select` for single-choice option fields). Unknown types fall back to a plain text input.
  type?: string
  options?: V2FormOption[]
  custom?: boolean
  required?: boolean
  when?: V2FormWhen[]
  url?: string
}
export type V2Form = { id: string; sessionID: string; title?: string; fields: V2FormField[] }

const BOOLEAN_OPTIONS: V2FormOption[] = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" }
]

function isBooleanField(field: V2FormField): boolean {
  return field.type === "boolean" || field.type === "confirm"
}

/** The choices the UI should render: real options, or synthesized Yes/No for a boolean field. */
function effectiveOptions(field: V2FormField): V2FormOption[] {
  if (field.options && field.options.length > 0) return field.options
  if (isBooleanField(field)) return BOOLEAN_OPTIONS
  return []
}

/** Plain-input fields (string/number/integer and unknown types) carry no choices and need a text box. */
function isFreeTextField(field: V2FormField): boolean {
  return effectiveOptions(field).length === 0 && field.type !== "external"
}

function isOptionalField(field: V2FormField): boolean {
  // `required` is optional in the v2 schema and only the literal value true makes a field required.
  // External fields are different: the protocol requires an explicit `true` acknowledgement.
  return field.type !== "external" && field.required !== true
}

function safeExternalUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 4096) return undefined
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined
  } catch {
    return undefined
  }
}

/**
 * v2 "forms" replace the v1 question flow. The app UI only understands the flat `QuestionInfo`
 * shape and selects options by their display label, so we surface one question per field, synthesize
 * controls for the option-less types (a text box for string/number/integer, Yes/No for boolean), and
 * keep the protocol's `key`/`value`/`type` metadata for the reply step (see {@link toFormAnswer}).
 */
export function toQuestionRequest(form: V2Form): QuestionRequest {
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions: (form.fields ?? []).map((field) => {
      const options = effectiveOptions(field)
      return {
        question: field.title ?? field.key,
        header: form.title ?? field.title ?? field.key,
        options: options.map((option) => ({
          label: option.label,
          description: option.description ?? "",
          value: option.value
        })),
        multiple: field.type === "multiselect",
        // Free-text fields must expose the "other" input — it is their only control; option fields
        // expose it only when the protocol permits a custom value.
        custom: isFreeTextField(field) ? true : (field.custom ?? false),
        optional: isOptionalField(field),
        key: field.key,
        answerType: field.type as "string" | "number" | "integer" | "boolean" | "multiselect" | "external",
        when: field.when,
        externalUrl: field.type === "external" ? safeExternalUrl(field.url) : undefined
      }
    })
  }
}

/** Shape one field's answer by its declared type (v2 accepts string | number | integer | boolean | string[]). */
function shapeFieldValue(field: V2FormField, values: string[]): V2FormValue {
  if (field.type === "multiselect") return values
  const first = values[0] ?? ""
  if (field.type === "number") {
    const parsed = Number(first)
    return Number.isFinite(parsed) ? parsed : first
  }
  if (field.type === "integer") {
    const parsed = Number(first)
    return Number.isFinite(parsed) && Number.isInteger(parsed) ? parsed : first
  }
  if (isBooleanField(field)) return first === "true" || first === "yes"
  return first
}

function isActive(field: V2FormField, answer: Record<string, V2FormValue>): boolean {
  if (!field.when) return true
  return field.when.every((condition) => {
    const value = answer[condition.key]
    // This matches v2: an unanswered dependency makes both eq and neq conditions false.
    if (value === undefined) return false
    const hit = Array.isArray(value)
      ? value.some((item) => item === condition.value)
      : value === condition.value
    return condition.op === "eq" ? hit : !hit
  })
}

/** Resolve one mapped question's current value for conditional visibility in the shared UI. */
function questionValue(question: QuestionRequest["questions"][number], labels: string[]): V2FormValue | undefined {
  if (labels.length === 0) return undefined
  const values = labels.map((label) => question.options.find((option) => option.label === label)?.value ?? label)
  if (question.answerType === "multiselect") return values
  const first = values[0]
  if (question.answerType === "number") {
    const parsed = Number(first)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (question.answerType === "integer") {
    const parsed = Number(first)
    return Number.isFinite(parsed) && Number.isInteger(parsed) ? parsed : undefined
  }
  if (question.answerType === "boolean") return first === "true"
  if (question.answerType === "external") return true
  return first
}

/** Whether a mapped question applies to the answers currently entered for earlier questions. */
export function isQuestionActive(request: QuestionRequest, index: number, answersByIndex: string[][]): boolean {
  const question = request.questions[index]
  if (!question?.when) return true
  return question.when.every((condition) => {
    const dependencyIndex = request.questions.findIndex((candidate) => candidate.key === condition.key)
    if (dependencyIndex < 0) return false
    const value = questionValue(request.questions[dependencyIndex], answersByIndex[dependencyIndex] ?? [])
    if (value === undefined) return false
    const hit = Array.isArray(value)
      ? value.some((item) => item === condition.value)
      : value === condition.value
    return condition.op === "eq" ? hit : !hit
  })
}

/**
 * Translate the app's per-question answers (arrays of the selected option *labels*, indexed to match
 * `form.fields`) back into v2's answer object: keyed by `field.key`, submitting each option's `value`
 * rather than its label, and typed per field. Free-text/custom answers with no matching option pass
 * through unchanged. Optional or inactive fields left blank are omitted, while an external field is
 * sent as `true` only after the user explicitly acknowledges its out-of-band step.
 */
export function toFormAnswer(form: V2Form, answersByIndex: string[][]): Record<string, V2FormValue> {
  const answer: Record<string, V2FormValue> = {}
  ;(form.fields ?? []).forEach((field, index) => {
    const labels = answersByIndex[index] ?? []
    if (field.type === "external") {
      if (labels.length > 0) answer[field.key] = true
      return
    }
    // Conditions reference earlier fields, so the incrementally built answer is sufficient and
    // ensures stale UI values from fields that became inactive are never submitted.
    if (!isActive(field, answer) || labels.length === 0) return
    const options = effectiveOptions(field)
    const values = labels.map((label) => {
      const option = options.find((candidate) => candidate.label === label || candidate.value === label)
      return option ? option.value : label
    })
    answer[field.key] = shapeFieldValue(field, values)
  })
  return answer
}
