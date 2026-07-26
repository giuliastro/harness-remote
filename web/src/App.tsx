import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { App as CapacitorApp } from "@capacitor/app"
import type { PluginListenerHandle } from "@capacitor/core"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { api, isValidServerConfig } from "./api"
import { ACTIVE_BACKEND_STORAGE_KEY, BACKEND_STORAGE_KEYS, LEGACY_STORAGE_KEY } from "./storageKeys"
import {
  createFetchOpenCodeEventSubscription,
  createNativeOpenCodeEventSubscription,
  eventPayload,
  eventType,
  isNativeEventTransport,
  type EventStreamStatus
} from "./opencode-events"
import { createTranslator, languageOptions, normalizeLanguage, type LanguageCode } from "./i18n"
import { DEFAULT_HARNESS_CAPABILITIES } from "./backendCapabilities"
import { BACKEND_CLIENTS } from "./backendClient"
import type { AgentOption, CommandInfo, DiffFile, FileEntry, FileStatusEntry, HarnessCapabilities, MessageEnvelope, MessagePart, ModelOption, ModelSelection, PathInfo, ProjectDashboard, QuestionInfo, QuestionRequest, ServerConfig, Session, SessionStatus, SessionView, TodoItem } from "./types"
import {
  SettingsIcon,
  FolderIcon,
  ChatIcon,
  HelpIcon,
  PlusIcon,
  TrashIcon,
  StopCircleIcon,
  SendIcon,
  SaveIcon,
  TestIcon,
  LoadingIcon,
  RefreshIcon,
  PencilIcon,
  CloseIcon
} from "./Icons"

const REMARK_PLUGINS = [remarkGfm]

const LANGUAGE_STORAGE_KEY = "opencode.remote.language"
const MODEL_STORAGE_KEY = "opencode.remote.model"
const AGENT_STORAGE_KEY = "opencode.remote.agent"
const THEME_STORAGE_KEY = "opencode.remote.theme"
const NEW_SESSION_DIRECTORY_STORAGE_KEY = "opencode.remote.newSessionDirectory"

type Translator = ReturnType<typeof createTranslator>

function isBridgeBackend(backend: ServerConfig["backend"]): boolean {
  return backend === "omp" || backend === "pi"
}

function backendDisplayName(backend: ServerConfig["backend"]): string {
  if (backend === "omp") return "Oh My Pi"
  if (backend === "pi") return "PI"
  return "OpenCode"
}

function defaultConfig(backend: ServerConfig["backend"]): ServerConfig {
  return {
    backend,
    host: "",
    port: backend === "opencode" ? 4096 : 4097,
    username: backend === "opencode" ? "opencode" : backend,
    password: ""
  }
}

function parseStoredConfig(value: string | null, backend: ServerConfig["backend"]): ServerConfig | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<ServerConfig>
    const storedBackend = parsed.backend === "omp" || parsed.backend === "opencode" || parsed.backend === "pi" ? parsed.backend : backend
    return { ...defaultConfig(storedBackend), ...parsed, backend: storedBackend }
  } catch {
    return null
  }
}

function readConfig(backend: ServerConfig["backend"]): ServerConfig {
  const saved = parseStoredConfig(localStorage.getItem(BACKEND_STORAGE_KEYS[backend]), backend)
  if (saved) return { ...saved, backend }
  const legacy = parseStoredConfig(localStorage.getItem(LEGACY_STORAGE_KEY), "opencode")
  return legacy?.backend === backend ? legacy : defaultConfig(backend)
}

function initialConfig(): ServerConfig {
  const legacy = parseStoredConfig(localStorage.getItem(LEGACY_STORAGE_KEY), "opencode")
  const storedBackend = localStorage.getItem(ACTIVE_BACKEND_STORAGE_KEY)
  const backend = storedBackend === "omp" || storedBackend === "opencode" || storedBackend === "pi" ? storedBackend : legacy?.backend ?? "opencode"
  const config = readConfig(backend)
  localStorage.setItem(BACKEND_STORAGE_KEYS[backend], JSON.stringify(config))
  localStorage.setItem(ACTIVE_BACKEND_STORAGE_KEY, backend)
  return config
}

function formatTime(epoch: number): string {
  if (!epoch) return "-"
  return new Date(epoch).toLocaleString()
}

function extractText(msg: MessageEnvelope): string {
  return msg.parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n")
    .trim()
}

/** Wraps a message with its extracted text, reusing the previous wrapper when the underlying message object is
 *  unchanged. applyStreamedPartUpdate/applyStreamedPartDelta already keep unrelated messages referentially
 *  identical across streamed updates — without this cache, mapping over the whole array would create a brand
 *  new wrapper object for every message on every token, defeating memoization of per-message rendering. */
const renderedMessageCache = new WeakMap<MessageEnvelope, MessageEnvelope & { text: string }>()

function toRenderedMessage(message: MessageEnvelope): MessageEnvelope & { text: string } {
  const cached = renderedMessageCache.get(message)
  if (cached) return cached
  const wrapped = { ...message, text: extractText(message) }
  renderedMessageCache.set(message, wrapped)
  return wrapped
}

function assistantPayloadLength(items: MessageEnvelope[]): number {
  return items
    .filter((message) => message.info.role !== "user")
    .reduce((sum, message) => sum + extractText(message).length, 0)
}

function messagesHaveSameContent(left: MessageEnvelope[], right: MessageEnvelope[]): boolean {
  return left.length === right.length && left.every((message, index) => {
    const candidate = right[index]
    return candidate?.info.role === message.info.role && extractText(candidate) === extractText(message)
  })
}

function messagesExtendContent(current: MessageEnvelope[], next: MessageEnvelope[]): boolean {
  if (next.length < current.length) return false
  return current.every((message, index) => {
    const candidate = next[index]
    return candidate?.info.role === message.info.role && extractText(candidate).startsWith(extractText(message))
  })
}

function normalizeMessageMarkdown(text: string): string {
  return text.includes("\n") ? text : text.replace(/\s-\s(?=\S)/g, "\n- ")
}

function capitalizeFirst(text: string): string {
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

const MODAL_TITLE_MAX_LENGTH = 80
/**
 * How long the open session may go without an SSE event before the poll treats the stream as not
 * covering it. Comfortably above opencode's 10s server heartbeat so a merely idle session isn't
 * mistaken for a broken one the instant it stops streaming.
 */
const SESSION_STREAM_QUIET_MS = 12_000

function truncateForTitle(text: string, maxLength: number = MODAL_TITLE_MAX_LENGTH): string {
  const singleLine = text.replace(/\s+/g, " ").trim()
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine
}

function toolCommandLabel(part: MessagePart): string {
  const input = part.state?.input
  if (!input) return part.tool || "tool"
  if (typeof input.command === "string") return input.command
  if (typeof input.filePath === "string") return `${part.tool}: ${input.filePath}`
  return `${part.tool}(${JSON.stringify(input)})`
}

/** Counts changed lines between two strings using an LCS-based line diff. Skipped (returns null) for inputs large
 *  enough that the O(n*m) table would be expensive — callers fall back to no diff stats in that case. */
function diffLineStats(oldText: string, newText: string): { additions: number; deletions: number } | null {
  const a = oldText.split("\n")
  const b = newText.split("\n")
  if (a.length * b.length > 250_000) return null
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const lcsLength = dp[0][0]
  return { additions: b.length - lcsLength, deletions: a.length - lcsLength }
}

/** Builds a simple unified-style diff (no hunk headers, every line shown) between two strings, for rendering
 *  with DiffLines. Skipped (returns null) for the same size cutoff as diffLineStats. */
function buildSimpleDiff(oldText: string, newText: string): string | null {
  const a = oldText.split("\n")
  const b = newText.split("\n")
  if (a.length * b.length > 250_000) return null
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const lines: string[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push(` ${a[i]}`)
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(`-${a[i]}`)
      i++
    } else {
      lines.push(`+${b[j]}`)
      j++
    }
  }
  while (i < a.length) {
    lines.push(`-${a[i]}`)
    i++
  }
  while (j < b.length) {
    lines.push(`+${b[j]}`)
    j++
  }
  return lines.join("\n")
}

/** Shortens a tool's absolute file path to a path relative to the session's working directory, when the file
 *  actually lives under it — long absolute paths otherwise get truncated in the single-line summary row. */
function relativizePath(path: string, directory: string | undefined): string {
  if (!directory) return path
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  const normalizedPath = normalize(path)
  const normalizedDir = normalize(directory)
  if (normalizedPath === normalizedDir) return "."
  const prefix = `${normalizedDir}/`
  if (normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())) {
    return normalizedPath.slice(prefix.length)
  }
  return path
}

function parseTodos(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value)) return null
  const items = value.filter(
    (item): item is TodoItem => Boolean(item) && typeof item === "object" && typeof (item as TodoItem).content === "string"
  )
  return items.length > 0 ? items : null
}

function parseQuestions(value: unknown): QuestionInfo[] | null {
  if (!Array.isArray(value)) return null
  const items = value.filter(
    (item): item is QuestionInfo => Boolean(item) && typeof item === "object" && typeof (item as QuestionInfo).question === "string"
  )
  return items.length > 0 ? items : null
}

/** Turns a raw tool call into a human-readable description of what the bot did, plus a +/- line-diff summary
 *  when the tool is an edit with old/new content to compare. */
function describeToolAction(
  part: MessagePart,
  directory: string | undefined,
  t: Translator
): { label: string; diff: { additions: number; deletions: number } | null } {
  const input = (part.state?.input ?? {}) as Record<string, unknown>
  const tool = (part.tool || "").toLowerCase()
  const filePath = typeof input.filePath === "string" ? relativizePath(input.filePath, directory) : undefined

  switch (tool) {
    case "read":
      return { label: filePath ? t('action.readFileNamed', { file: filePath }) : t('action.readFile'), diff: null }
    case "write": {
      const content = typeof input.content === "string" ? input.content : null
      const diff = content !== null ? diffLineStats("", content) : null
      return { label: filePath ? t('action.wroteFileNamed', { file: filePath }) : t('action.wroteFile'), diff }
    }
    case "edit": {
      const oldString = typeof input.oldString === "string" ? input.oldString : null
      const newString = typeof input.newString === "string" ? input.newString : null
      const diff = oldString !== null && newString !== null ? diffLineStats(oldString, newString) : null
      return { label: filePath ? t('action.editedFileNamed', { file: filePath }) : t('action.editedFile'), diff }
    }
    case "bash":
      return {
        label: typeof input.command === "string" ? t('action.ranCommandNamed', { command: input.command }) : t('action.ranCommand'),
        diff: null
      }
    case "glob":
      return {
        label: typeof input.pattern === "string" ? t('action.searchedFilesFor', { pattern: input.pattern }) : t('action.searchedFiles'),
        diff: null
      }
    case "grep":
      return {
        label: typeof input.pattern === "string" ? t('action.searchedCodeFor', { pattern: input.pattern }) : t('action.searchedCode'),
        diff: null
      }
    case "webfetch":
      return { label: typeof input.url === "string" ? t('action.fetchedUrlNamed', { url: input.url }) : t('action.fetchedUrl'), diff: null }
    case "todowrite": {
      const todos = parseTodos(input.todos)
      if (!todos) return { label: t('action.updatedTodos'), diff: null }
      const done = todos.filter((item) => item.status === "completed").length
      return { label: t('action.todoSummary', { done, total: todos.length }), diff: null }
    }
    case "question": {
      const questions = parseQuestions(input.questions)
      if (!questions) return { label: t('action.askedQuestion'), diff: null }
      return {
        label: questions.length === 1 ? t('action.askedQuestionNamed', { question: questions[0].question }) : t('action.askedQuestions', { n: questions.length }),
        diff: null
      }
    }
    case "task":
      return {
        label:
          typeof input.description === "string"
            ? t('action.ranSubagentNamed', { description: input.description })
            : t('action.ranSubagent'),
        diff: null
      }
    case "skill":
      return {
        label: typeof input.name === "string" ? t('action.usedSkillNamed', { name: input.name }) : t('action.usedSkill'),
        diff: null
      }
    default:
      return { label: toolCommandLabel(part), diff: null }
  }
}

function TodoListView({ items }: { items: TodoItem[] }) {
  return (
    <div className="message-todo-list">
      {items.map((item) => (
        <div key={item.id} className="todo-item">
          <span className={`todo-status ${item.status}`}>
            {item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : "○"}
          </span>
          <span>{item.content}</span>
        </div>
      ))}
    </div>
  )
}

function QuestionListView({ questions }: { questions: QuestionInfo[] }) {
  return (
    <div className="question-options">
      {questions.map((question, index) => (
        <div key={index} className="question-block">
          <div className="question-header">{question.header}</div>
          <p className="question-text">{question.question}</p>
          {question.options.length > 0 && (
            <div className="question-options">
              {question.options.map((option) => (
                <div key={option.label} className="question-option static">
                  <span className="question-option-label">{option.label}</span>
                  {option.description && <span className="question-option-description">{option.description}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function DiffLines({ patch }: { patch: string }) {
  const lines = patch.split("\n")
  return (
    <pre className="message-diff-patch">
      {lines.map((line, index) => {
        let className = "diff-line-context"
        if (line.startsWith("+++") || line.startsWith("---")) className = "diff-line-meta"
        else if (line.startsWith("+")) className = "diff-line-add"
        else if (line.startsWith("-")) className = "diff-line-del"
        else if (line.startsWith("@@")) className = "diff-line-hunk"
        return (
          <div key={index} className={className}>
            {line}
          </div>
        )
      })}
    </pre>
  )
}

function PatchPartView({
  config,
  sessionID,
  messageID,
  files,
  timestamp,
  t
}: {
  config: ServerConfig
  sessionID: string
  messageID: string
  files: string[]
  timestamp?: string
  t: Translator
}) {
  const [diffs, setDiffs] = useState<DiffFile[] | null>(null)
  const [expandedDiff, setExpandedDiff] = useState<DiffFile | null>(null)

  useEffect(() => {
    let cancelled = false
    api.loadMessageDiff(config, sessionID, messageID).then((result) => {
      if (!cancelled) setDiffs(result)
    }).catch(() => {
      if (!cancelled) setDiffs([])
    })
    return () => {
      cancelled = true
    }
  }, [config.host, config.port, config.username, config.password, sessionID, messageID])

  if (diffs === null) {
    return (
      <div className="message-patch">
        {files.map((file) => (
          <div key={file} className="message-patch-file">{file}</div>
        ))}
      </div>
    )
  }

  if (diffs.length === 0) return null

  return (
    <div className="message-patch">
      {diffs.map((diff) => (
        <button
          key={diff.file}
          type="button"
          className="message-diff-row"
          onClick={() => setExpandedDiff(diff)}
          aria-label={t('action.showDiffFor', { file: diff.file })}
        >
          <span className="message-diff-file">{diff.file}</span>
          <span className="message-diff-stats">
            {diff.additions > 0 && <span className="diff-stat-add">+{diff.additions}</span>}
            {diff.deletions > 0 && <span className="diff-stat-del">-{diff.deletions}</span>}
          </span>
        </button>
      ))}

      {expandedDiff && (
        <Modal title={expandedDiff.file} timestamp={timestamp} onClose={() => setExpandedDiff(null)} t={t}>
          {expandedDiff.patch && <DiffLines patch={expandedDiff.patch} />}
        </Modal>
      )}
    </div>
  )
}

const BOTTOM_STICK_THRESHOLD = 80

let modalTitleSequence = 0

/** Shared full-detail modal — everything that isn't the primary output text (thoughts, tool calls, edits) is
 *  surfaced through this rather than inline collapsible/expandable regions. */
function Modal({
  title,
  timestamp,
  onClose,
  children,
  t
}: {
  title: string
  timestamp?: string
  onClose: () => void
  children: ReactNode
  t: Translator
}) {
  const [titleID] = useState(() => `modal-title-${++modalTitleSequence}`)
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal-card diff-modal fade-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleID}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="diff-modal-header">
          <div className="diff-modal-heading">
            <h2 id={titleID}>{title}</h2>
            {timestamp && <small className="diff-modal-timestamp">{timestamp}</small>}
          </div>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t('action.close')}
          </button>
        </div>
        <div className="diff-modal-body">{children}</div>
      </section>
    </div>
  )
}

function QuestionCard({
  config,
  directory,
  request,
  onResolved,
  t
}: {
  config: ServerConfig
  directory: string
  request: QuestionRequest
  onResolved: (id: string) => void
  t: Translator
}) {
  const [selections, setSelections] = useState<string[][]>(() => request.questions.map(() => []))
  const [customValues, setCustomValues] = useState<string[]>(() => request.questions.map(() => ""))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleOption(questionIndex: number, label: string, multiple: boolean) {
    setSelections((current) => {
      const next = [...current]
      const existing = next[questionIndex]
      next[questionIndex] = multiple
        ? existing.includes(label)
          ? existing.filter((value) => value !== label)
          : [...existing, label]
        : existing.includes(label)
          ? []
          : [label]
      return next
    })
  }

  function setCustomValue(questionIndex: number, value: string) {
    setCustomValues((current) => {
      const next = [...current]
      next[questionIndex] = value
      return next
    })
  }

  const canSubmit = request.questions.every((question, index) => {
    return selections[index].length > 0 || (question.custom && customValues[index].trim().length > 0)
  })

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const answers = request.questions.map((_, index) => {
        const customValue = customValues[index].trim()
        return customValue ? [...selections[index], customValue] : selections[index]
      })
      await api.replyQuestion(config, request.id, answers, directory)
      onResolved(request.id)
    } catch (err) {
      setError((err as Error).message)
      setSubmitting(false)
    }
  }

  async function reject() {
    setSubmitting(true)
    setError(null)
    try {
      await api.rejectQuestion(config, request.id, directory)
      onResolved(request.id)
    } catch (err) {
      setError((err as Error).message)
      setSubmitting(false)
    }
  }

  return (
    <article className="message assistant question-card fade-in" aria-label={t('question.ariaLabel')}>
      {request.questions.map((question, index) => (
        <div key={index} className="question-block">
          <div className="question-header">{question.header}</div>
          <p className="question-text">{question.question}</p>
          <div className="question-options">
            {question.options.map((option) => (
              <button
                key={option.label}
                type="button"
                className={`question-option ${selections[index].includes(option.label) ? "selected" : ""}`}
                onClick={() => toggleOption(index, option.label, Boolean(question.multiple))}
                disabled={submitting}
              >
                <span className="question-option-label">{option.label}</span>
                {option.description && <span className="question-option-description">{option.description}</span>}
              </button>
            ))}
          </div>
          {question.custom && (
            <input
              type="text"
              className="question-custom-input"
              placeholder={t('question.otherPlaceholder')}
              value={customValues[index]}
              onChange={(event) => setCustomValue(index, event.target.value)}
              disabled={submitting}
            />
          )}
        </div>
      ))}
      {error && <p className="question-error">{error}</p>}
      <div className="question-actions">
        <button type="button" className="btn-secondary" onClick={reject} disabled={submitting}>
          {t('question.skip')}
        </button>
        <button type="button" className="btn-primary" onClick={submit} disabled={submitting || !canSubmit}>
          {t('question.sendAnswer')}
        </button>
      </div>
    </article>
  )
}

function ToolPartView({
  part,
  directory,
  timestamp,
  t
}: {
  part: MessagePart
  directory: string | undefined
  timestamp?: string
  t: Translator
}) {
  const [open, setOpen] = useState(false)
  const status = part.state?.status || "pending"
  const command = toolCommandLabel(part)
  const { label, diff } = describeToolAction(part, directory, t)
  const tool = (part.tool || "").toLowerCase()
  const input = (part.state?.input ?? {}) as Record<string, unknown>
  let patch: string | null = null
  if (tool === "edit" && typeof input.oldString === "string" && typeof input.newString === "string") {
    patch = buildSimpleDiff(input.oldString, input.newString)
  } else if (tool === "write" && typeof input.content === "string") {
    patch = buildSimpleDiff("", input.content)
  }
  const todos = tool === "todowrite" ? parseTodos(input.todos) : null
  const questions = tool === "question" ? parseQuestions(input.questions) : null
  return (
    <>
      <button type="button" className={`message-tool-summary message-tool-${status}`} onClick={() => setOpen(true)}>
        <span className="message-tool-label">{label}</span>
        <span className="message-tool-meta">
          {diff && (diff.additions > 0 || diff.deletions > 0) && (
            <span className="message-tool-diff-stats">
              {diff.additions > 0 && <span className="diff-stat-add">+{diff.additions}</span>}
              {diff.deletions > 0 && <span className="diff-stat-del">-{diff.deletions}</span>}
            </span>
          )}
          {status === "error" && (
            <span className="message-tool-status-error" title={t('action.toolFailed')} aria-label={t('action.toolFailed')}>
              ✕
            </span>
          )}
          {(status === "pending" || status === "running") && (
            <span className="message-tool-status-pending" title={t('action.running')} aria-label={t('action.running')}>
              …
            </span>
          )}
        </span>
      </button>

      {open && (
        <Modal title={truncateForTitle(label)} timestamp={timestamp} onClose={() => setOpen(false)} t={t}>
          {todos ? (
            <TodoListView items={todos} />
          ) : questions ? (
            <QuestionListView questions={questions} />
          ) : (
            <>
              <pre className="message-tool-command">{command}</pre>
              {patch ? (
                <DiffLines patch={patch} />
              ) : (
                part.state?.output && <pre className="message-tool-output">{part.state.output}</pre>
              )}
            </>
          )}
          {part.state?.error && <pre className="message-tool-output message-tool-error">{part.state.error}</pre>}
        </Modal>
      )}
    </>
  )
}

function ReasoningPartView({ part, timestamp, t }: { part: MessagePart; timestamp?: string; t: Translator }) {
  const [open, setOpen] = useState(false)
  if (!part.text) return null
  const label = reasoningLabel([part], t)
  return (
    <>
      <button type="button" className="message-reasoning-summary" onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && (
        <Modal title={label} timestamp={timestamp} onClose={() => setOpen(false)} t={t}>
          <pre className="message-reasoning-text">{part.text}</pre>
        </Modal>
      )}
    </>
  )
}

function MessagePartView({
  part,
  config,
  sessionID,
  directory,
  timestamp,
  t
}: {
  part: MessagePart
  config: ServerConfig
  sessionID: string
  directory?: string
  timestamp?: string
  t: Translator
}) {
  if (part.type === "text") {
    if (!part.text) return null
    return (
      <div className="message-content">
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{normalizeMessageMarkdown(part.text)}</ReactMarkdown>
      </div>
    )
  }

  if (part.type === "reasoning") {
    return <ReasoningPartView part={part} timestamp={timestamp} t={t} />
  }

  if (part.type === "tool") {
    return <ToolPartView part={part} directory={directory} timestamp={timestamp} t={t} />
  }

  if (part.type === "patch") {
    if (!part.files || part.files.length === 0 || !part.messageID) return null
    return (
      <PatchPartView
        config={config}
        sessionID={sessionID}
        messageID={part.messageID}
        files={part.files}
        timestamp={timestamp}
        t={t}
      />
    )
  }

  return null
}

const ACTION_GROUP_TYPES = new Set(["reasoning", "tool", "patch"])

type TimelineItem = { kind: "action-group"; parts: MessagePart[] } | { kind: "part"; part: MessagePart }

/** Walks a message's parts in order and collapses each run of consecutive thinking/tool-call/edit parts into a
 *  single action-group item, alternating with the output text parts as they actually occurred — so a turn that
 *  thinks, calls a tool, replies, thinks again, calls another tool, and replies again renders as two separate
 *  "thought for Xs, used N tools" rows interleaved with their two outputs, rather than one merged blob. A run of
 *  just one action part skips the group wrapper entirely and renders as that part directly. */
function buildMessageTimeline(parts: MessagePart[]): TimelineItem[] {
  const items: TimelineItem[] = []
  let buffer: MessagePart[] = []
  const flush = () => {
    if (buffer.length === 0) return
    items.push(buffer.length === 1 ? { kind: "part", part: buffer[0] } : { kind: "action-group", parts: buffer })
    buffer = []
  }
  for (const part of parts) {
    if (part.type === "step-start" || part.type === "step-finish") continue
    if (part.type === "text" && !part.text) continue
    if (ACTION_GROUP_TYPES.has(part.type)) {
      buffer.push(part)
    } else {
      flush()
      items.push({ kind: "part", part })
    }
  }
  flush()
  return items
}

function formatActionDuration(ms: number, t: Translator): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return t('action.durationSeconds', { n: seconds })
  const minutes = Math.round(seconds / 60)
  return t('action.durationMinutes', { n: minutes })
}

/** Groups tool calls by what kind of action they represent (reads, searches, commands, ...) so a run of tool
 *  calls summarizes as "read 5 files, searched 1 time" instead of a meaningless "ran 6 tools". */
function summarizeToolCounts(toolParts: MessagePart[], t: Translator): string[] {
  const counts = new Map<string, number>()
  const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
  for (const part of toolParts) {
    const tool = (part.tool || "").toLowerCase()
    switch (tool) {
      case "read":
        bump("read")
        break
      case "write":
        bump("write")
        break
      case "edit":
        bump("edit")
        break
      case "bash":
        bump("bash")
        break
      case "glob":
      case "grep":
        bump("search")
        break
      case "webfetch":
        bump("webfetch")
        break
      case "task":
        bump("task")
        break
      case "skill":
        bump("skill")
        break
      case "todowrite":
        bump("todo")
        break
      case "question":
        bump("question")
        break
      default:
        bump("other")
        break
    }
  }

  const pieces: string[] = []
  const push = (key: string, oneKey: string, manyKey: string) => {
    const count = counts.get(key)
    if (count) pieces.push(count === 1 ? t(oneKey) : t(manyKey, { n: count }))
  }
  push("read", "action.countReadOne", "action.countReadMany")
  push("write", "action.countWriteOne", "action.countWriteMany")
  push("edit", "action.countEditOne", "action.countEditMany")
  push("search", "action.countSearchOne", "action.countSearchMany")
  push("bash", "action.countBashOne", "action.countBashMany")
  push("webfetch", "action.countWebfetchOne", "action.countWebfetchMany")
  push("task", "action.countTaskOne", "action.countTaskMany")
  push("skill", "action.countSkillOne", "action.countSkillMany")
  push("todo", "action.countTodoOne", "action.countTodoMany")
  push("question", "action.countQuestionOne", "action.countQuestionMany")
  push("other", "action.countOtherOne", "action.countOtherMany")
  return pieces
}

/** "Thought for Xs"/"Thought for Xm" when the reasoning part(s) carry timing, else a plain "Thinking". */
function reasoningLabel(reasoningParts: MessagePart[], t: Translator): string {
  let minStart: number | undefined
  let maxEnd: number | undefined
  for (const part of reasoningParts) {
    const time = part.time
    if (!time) continue
    if (minStart === undefined || time.start < minStart) minStart = time.start
    const end = time.end ?? Date.now()
    if (maxEnd === undefined || end > maxEnd) maxEnd = end
  }
  return minStart !== undefined && maxEnd !== undefined
    ? t('action.thoughtFor', { duration: formatActionDuration(maxEnd - minStart, t) })
    : t('action.thinking')
}

function summarizeActionGroup(parts: MessagePart[], t: Translator): string {
  const reasoningParts = parts.filter((part) => part.type === "reasoning")
  const toolParts = parts.filter((part) => part.type === "tool")
  const editCount = parts
    .filter((part) => part.type === "patch")
    .reduce((sum, part) => sum + (part.files?.length ?? 0), 0)

  const pieces: string[] = []
  if (reasoningParts.length > 0) pieces.push(reasoningLabel(reasoningParts, t))
  pieces.push(...summarizeToolCounts(toolParts, t))
  if (editCount > 0) pieces.push(editCount === 1 ? t('action.madeEditOne') : t('action.madeEditMany', { n: editCount }))
  if (pieces.length === 0) pieces.push(t('action.actionsFallback'))
  return capitalizeFirst(pieces.join(", "))
}

function ActionGroupView({
  parts,
  config,
  sessionID,
  directory,
  timestamp,
  t
}: {
  parts: MessagePart[]
  config: ServerConfig
  sessionID: string
  directory?: string
  timestamp?: string
  t: Translator
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="message-action-summary" onClick={() => setOpen(true)}>
        <span>{summarizeActionGroup(parts, t)}</span>
      </button>

      {open && (
        <Modal title={summarizeActionGroup(parts, t)} timestamp={timestamp} onClose={() => setOpen(false)} t={t}>
          <div className="message-action-details">
            {parts.map((part, index) => (
              <Fragment key={part.id}>
                {index > 0 && <hr className="message-action-divider" />}
                <MessagePartView part={part} config={config} sessionID={sessionID} directory={directory} timestamp={timestamp} t={t} />
              </Fragment>
            ))}
          </div>
        </Modal>
      )}
    </>
  )
}

function toFileStatusList(input: FileStatusEntry[] | Record<string, FileStatusEntry>): FileStatusEntry[] {
  if (Array.isArray(input)) return input
  return Object.entries(input).map(([path, value]) => ({ path, ...value }))
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function summarizeJson(value: unknown): string {
  if (value === null || value === undefined) return "-"
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

function configKey(config: ServerConfig): string {
  return JSON.stringify({
    backend: config.backend,
    host: config.host.trim(),
    port: config.port,
    username: config.username.trim(),
    password: config.password
  })
}

function canTestConfig(config: ServerConfig): boolean {
  return Boolean(config.username.trim()) && isValidServerConfig(config)
}

function modelKey(model: ModelSelection): string {
  return [model.providerID, model.modelID, model.variant ?? ""].map(encodeURIComponent).join("|")
}

function modelFromKey(value: string | null): ModelSelection | null {
  if (!value) return null
  const [providerID, modelID, variant] = value.split("|").map((part) => decodeURIComponent(part))
  if (!providerID || !modelID) return null
  return { providerID, modelID, variant: variant || undefined }
}

function modelStorageScope(backend: ServerConfig["backend"], sessionID?: string): string {
  return `${backend}:${sessionID ?? "new"}`
}

function readStoredModel(backend: ServerConfig["backend"], sessionID?: string): string | null {
  try {
    const stored = JSON.parse(localStorage.getItem(MODEL_STORAGE_KEY) ?? "{}") as Record<string, unknown>
    const value = stored[modelStorageScope(backend, sessionID)]
    return typeof value === "string" ? value : null
  } catch {
    return null
  }
}

function writeStoredModel(backend: ServerConfig["backend"], sessionID: string | undefined, value: string): void {
  let stored: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(localStorage.getItem(MODEL_STORAGE_KEY) ?? "{}")
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>
  } catch {
    // Replace the legacy global string with scoped selections.
  }
  stored[modelStorageScope(backend, sessionID)] = value
  localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(stored))
}

function sameModel(a: ModelSelection | null | undefined, b: ModelSelection | null | undefined): boolean {
  return Boolean(a && b && a.providerID === b.providerID && a.modelID === b.modelID && (a.variant ?? "") === (b.variant ?? ""))
}

function modelSearchText(option: ModelOption): string {
  return [option.modelName, option.modelID, option.providerName, option.providerID, option.variant ?? ""].join(" ").toLowerCase()
}

function agentLabel(agent: AgentOption): string {
  return agent.name || agent.id
}

function normalizeDirectory(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isProjectDirectory(pathInfo: PathInfo): boolean {
  return pathInfo.worktree !== "/"
}

function messageActivityTime(message: MessageEnvelope): number {
  return Math.max(message.info.time.created, message.info.time.completed ?? 0)
}

function toSessionView(session: Session, status?: SessionStatus, activityTime = session.time.updated): SessionView {
  return {
    id: session.id,
    title: session.title,
    directory: session.directory,
    updated: activityTime,
    status: status?.type ?? "idle",
    files: session.summary?.files ?? 0,
    additions: session.summary?.additions ?? 0,
    deletions: session.summary?.deletions ?? 0,
    model: session.model ? { providerID: session.model.providerID, modelID: session.model.id, variant: session.model.variant } : undefined
  }
}

function formatLimit(value?: number): string {
  if (!value) return "-"
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

function createOptimisticUserMessage(sessionID: string, text: string): MessageEnvelope {
  const now = Date.now()
  return {
    info: {
      id: `optimistic-${now}`,
      role: "user",
      sessionID,
      time: { created: now }
    },
    parts: [
      {
        id: `optimistic-part-${now}`,
        type: "text",
        text
      }
    ]
  }
}

function createLocalAssistantMessage(sessionID: string, text: string): MessageEnvelope {
  const now = Date.now()
  return {
    info: {
      id: `local-assistant-${now}`,
      role: "assistant",
      sessionID,
      time: { created: now, completed: now }
    },
    parts: [
      {
        id: `local-assistant-part-${now}`,
        type: "text",
        text
      }
    ]
  }
}

/** Reasoning text should only ever grow while streaming — if an incoming snapshot is shorter than what's already shown, a reset/truncated event landed; keep the longer text instead of visibly erasing it. */
function reconcileReasoningPart(previous: MessagePart | undefined, incoming: MessagePart): MessagePart {
  if (incoming.type !== "reasoning" || !previous || previous.type !== "reasoning") return incoming
  const previousText = previous.text ?? ""
  const incomingText = incoming.text ?? ""
  return incomingText.length >= previousText.length ? incoming : { ...incoming, text: previousText }
}

/** GET /session/{id}/message doesn't return reasoning parts, only the live event stream does — keep any streamed-in reasoning the refetch would otherwise silently drop. */
function partsEqual(a: MessagePart[], b: MessagePart[]): boolean {
  return a === b || (a.length === b.length && JSON.stringify(a) === JSON.stringify(b))
}

/** Reuses the previous message object whenever the merged result is logically unchanged, instead of always
 *  returning a fresh `{ ...message }` wrapper. The periodic 3.5s poll calls this for every message in the
 *  conversation regardless of whether anything actually changed, and a fresh reference per message would defeat
 *  the WeakMap/memo caching that keeps unrelated messages from re-rendering while one is actively streaming. */
function mergeFetchedMessages(current: MessageEnvelope[], fetched: MessageEnvelope[]): MessageEnvelope[] {
  const currentByID = new Map(current.map((message) => [message.info.id, message]))
  return fetched.map((message) => {
    const previous = currentByID.get(message.info.id)
    if (!previous) return message
    const previousPartsByID = new Map(previous.parts.map((part) => [part.id, part]))
    const parts = message.parts.map((part) => reconcileReasoningPart(previousPartsByID.get(part.id), part))
    const fetchedPartIDs = new Set(message.parts.map((part) => part.id))
    const missingReasoning = previous.parts.filter((part) => part.type === "reasoning" && !fetchedPartIDs.has(part.id))
    const mergedParts = missingReasoning.length === 0 ? parts : [...missingReasoning, ...parts]
    return partsEqual(previous.parts, mergedParts) ? previous : { ...message, parts: mergedParts }
  })
}

function applyStreamedPartUpdate(messages: MessageEnvelope[], sessionID: string, part: MessagePart): MessageEnvelope[] {
  let changed = false
  const next = messages.map((message) => {
    if (message.info.sessionID !== sessionID || message.info.id !== part.messageID) return message
    changed = true
    const exists = message.parts.some((existing) => existing.id === part.id)
    const parts = exists
      ? message.parts.map((existing) => (existing.id === part.id ? reconcileReasoningPart(existing, part) : existing))
      : [...message.parts, part]
    return { ...message, parts }
  })
  return changed ? next : messages
}

function applyStreamedPartDelta(
  messages: MessageEnvelope[],
  sessionID: string,
  messageID: string,
  partID: string,
  field: string,
  delta: string
): MessageEnvelope[] {
  let changed = false
  const next = messages.map((message) => {
    if (message.info.sessionID !== sessionID || message.info.id !== messageID) return message
    const parts = message.parts.map((existing) => {
      if (existing.id !== partID) return existing
      changed = true
      const current = (existing as Record<string, unknown>)[field]
      const nextValue = (typeof current === "string" ? current : "") + delta
      return { ...existing, [field]: nextValue }
    })
    return changed ? { ...message, parts } : message
  })
  return changed ? next : messages
}

function hasMatchingUserMessage(messages: MessageEnvelope[], optimistic: MessageEnvelope): boolean {
  const text = extractText(optimistic)
  return messages.some((message) => (
    message.info.sessionID === optimistic.info.sessionID &&
    message.info.role === "user" &&
    extractText(message) === text
  ))
}

type RenderGroup =
  | { kind: "message"; message: MessageEnvelope & { text: string } }
  | {
      kind: "run"
      key: string
      items: TimelineItem[]
      messagesByID: Map<string, MessageEnvelope & { text: string }>
      sessionID: string
    }

/** Groups consecutive non-user messages into a single "run" and builds one continuous timeline across all of
 *  their parts (via buildMessageTimeline), instead of computing each message's timeline in isolation. This is
 *  what lets a trailing action-group in one message merge with a leading action-group in the next — a run of
 *  thought/tool-call parts with no real text between them collapses into one summary row regardless of which
 *  message boundary it happened to be split across. User messages always start a fresh group. */
function groupRenderedMessages(messages: (MessageEnvelope & { text: string })[]): RenderGroup[] {
  const groups: RenderGroup[] = []
  let buffer: (MessageEnvelope & { text: string })[] = []
  const flush = () => {
    if (buffer.length === 0) return
    // A run exists to merge action groups that a message boundary split apart. With nothing
    // groupable there is nothing to merge, and folding the messages together would glue two
    // separate replies into one bubble — which is what an OMP session looks like while a queued
    // prompt is running, since it produces text parts only.
    if (!buffer.some((message) => message.parts.some((part) => ACTION_GROUP_TYPES.has(part.type)))) {
      for (const message of buffer) groups.push({ kind: "message", message })
    } else {
      const items = buildMessageTimeline(buffer.flatMap((message) => message.parts))
      const messagesByID = new Map(buffer.map((message) => [message.info.id, message]))
      groups.push({
        kind: "run",
        key: `run-${buffer[0].info.id}`,
        items,
        messagesByID,
        sessionID: buffer[buffer.length - 1].info.sessionID
      })
    }
    buffer = []
  }
  for (const message of messages) {
    if (message.info.role === "user") {
      flush()
      groups.push({ kind: "message", message })
    } else {
      buffer.push(message)
    }
  }
  flush()
  return groups
}

/** Renders one run's continuous timeline (see groupRenderedMessages) as a single message bubble, resolving
 *  each item's timestamp to the specific message that produced it. */
function ConversationRunView({
  items,
  messagesByID,
  sessionID,
  config,
  directory,
  t
}: {
  items: TimelineItem[]
  messagesByID: Map<string, MessageEnvelope & { text: string }>
  sessionID: string
  config: ServerConfig
  directory: string | undefined
  t: Translator
}) {
  const fallback = [...messagesByID.values()].pop()
  const timestampFor = (part: MessagePart) => {
    const owner = (part.messageID && messagesByID.get(part.messageID)) || fallback
    return owner ? formatTime(owner.info.time.created) : undefined
  }
  return (
    <article className="message assistant fade-in">
      {items.map((item) =>
        item.kind === "action-group" ? (
          <ActionGroupView
            key={`group-${item.parts[0].id}`}
            parts={item.parts}
            config={config}
            sessionID={sessionID}
            directory={directory}
            timestamp={timestampFor(item.parts[item.parts.length - 1])}
            t={t}
          />
        ) : (
          <MessagePartView
            key={item.part.id}
            part={item.part}
            config={config}
            sessionID={sessionID}
            directory={directory}
            timestamp={timestampFor(item.part)}
            t={t}
          />
        )
      )}
    </article>
  )
}

/** One message's parts. Memoized on the message object identity so that streaming a token into one message
 *  (which necessarily re-renders MessagesPane) doesn't re-run timeline/diff formatting for every other message
 *  in the conversation — toRenderedMessage keeps unrelated messages referentially stable across updates. */
const MessageArticle = memo(function MessageArticle({
  message,
  config,
  directory,
  t
}: {
  message: MessageEnvelope & { text: string }
  config: ServerConfig
  directory: string | undefined
  t: Translator
}) {
  return (
    <article className={`message ${message.info.role} fade-in`}>
      {buildMessageTimeline(message.parts).map((item) =>
        item.kind === "action-group" ? (
          <ActionGroupView
            key={`group-${item.parts[0].id}`}
            parts={item.parts}
            config={config}
            sessionID={message.info.sessionID}
            directory={directory}
            timestamp={formatTime(message.info.time.created)}
            t={t}
          />
        ) : (
          <MessagePartView
            key={item.part.id}
            part={item.part}
            config={config}
            sessionID={message.info.sessionID}
            directory={directory}
            timestamp={formatTime(message.info.time.created)}
            t={t}
          />
        )
      )}
    </article>
  )
})

/** Renders the message list, pending questions, and typing bubble. Memoized so that unrelated state changes in
 *  the parent (most importantly typing into the composer) don't re-run the per-message formatting/diffing work
 *  on every keystroke. */
const MessagesPane = memo(function MessagesPane({
  loadingSessionID,
  selectedID,
  renderedMessages,
  timelineGroups,
  showTypingBubble,
  pendingQuestions,
  config,
  directory,
  t,
  messagesRef,
  messagesEndRef,
  onMessagesScroll,
  onQuestionResolved
}: {
  loadingSessionID: string | null
  selectedID: string | null
  renderedMessages: (MessageEnvelope & { text: string })[]
  timelineGroups: RenderGroup[]
  showTypingBubble: boolean
  pendingQuestions: QuestionRequest[]
  config: ServerConfig
  directory: string | undefined
  t: Translator
  messagesRef: RefObject<HTMLDivElement>
  messagesEndRef: RefObject<HTMLDivElement>
  onMessagesScroll: () => void
  onQuestionResolved: (id: string) => void
}) {
  return (
    <div className="messages-wrap">
      <div className="messages" ref={messagesRef} onScroll={onMessagesScroll}>
        {loadingSessionID === selectedID ? (
          <div className="empty-state compact">
            <LoadingIcon size={32} />
            <p>{t('detail.loading')}</p>
          </div>
        ) : renderedMessages.length === 0 && !showTypingBubble && pendingQuestions.length === 0 ? (
          <div className="empty-state compact">
            <ChatIcon size={40} className="icon-empty-state" />
            <p>{t('detail.emptyTitle')}</p>
            <p className="subtle">{t('detail.emptyHint')}</p>
          </div>
        ) : (
          <>
            {timelineGroups.map((group) =>
              group.kind === "message" ? (
                <MessageArticle key={group.message.info.id} message={group.message} config={config} directory={directory} t={t} />
              ) : (
                <ConversationRunView
                  key={group.key}
                  items={group.items}
                  messagesByID={group.messagesByID}
                  sessionID={group.sessionID}
                  config={config}
                  directory={directory}
                  t={t}
                />
              )
            )}
            {directory !== undefined &&
              pendingQuestions.map((request) => (
                <QuestionCard
                  key={request.id}
                  config={config}
                  directory={directory}
                  request={request}
                  onResolved={onQuestionResolved}
                  t={t}
                />
              ))}
            {showTypingBubble && (
              <article className="message assistant typing-bubble fade-in" aria-label={t('detail.waiting')}>
                <div className="typing-dots" aria-hidden="true">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </div>
              </article>
            )}
            <div ref={messagesEndRef} className="messages-end" aria-hidden="true" />
          </>
        )}
      </div>
    </div>
  )
})

function App() {
  type NoticeType = "info" | "success" | "error"
  type ThemePreference = "system" | "light" | "dark"
  const [config, setConfig] = useState<ServerConfig>(initialConfig)
  const [language, setLanguage] = useState<LanguageCode>(() => {
    return normalizeLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY) || navigator.language)
  })
  const [theme, setTheme] = useState<ThemePreference>(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    return saved === "light" || saved === "dark" || saved === "system" ? saved : "system"
  })
  const t = useMemo(() => createTranslator(language), [language])

  const [draftConfig, setDraftConfig] = useState<ServerConfig>(config)
  const [capabilities, setCapabilities] = useState<HarnessCapabilities>(() => DEFAULT_HARNESS_CAPABILITIES[config.backend])
  const [connectedVersion, setConnectedVersion] = useState<string>("")
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [commandFilter, setCommandFilter] = useState<"all" | "skill">("all")
  const [agentOptions, setAgentOptions] = useState<AgentOption[]>([])
  const [agentLoadError, setAgentLoadError] = useState<string | null>(null)
  const [selectedAgentID, setSelectedAgentID] = useState<string>(() => localStorage.getItem(AGENT_STORAGE_KEY) || "build")
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [modelLoadError, setModelLoadError] = useState<string | null>(null)
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(() => readStoredModel(config.backend))
  const [modelQuery, setModelQuery] = useState("")
  const [helpPage, setHelpPage] = useState<"overview" | "server" | "network" | "troubleshooting" | "commands">(
    "overview"
  )
  const [view, setView] = useState<"settings" | "sessions" | "detail" | "help">(() => {
    return config.host && config.port > 0 ? "sessions" : "settings"
  })

  const [sessions, setSessions] = useState<SessionView[]>([])
  const [selectedID, setSelectedID] = useState<string | null>(null)
  const [newSessionDirectory, setNewSessionDirectory] = useState(() => localStorage.getItem(NEW_SESSION_DIRECTORY_STORAGE_KEY) ?? "")
  const [showNewSessionPicker, setShowNewSessionPicker] = useState(false)
  const [pickerPath, setPickerPath] = useState("")
  const [pickerItems, setPickerItems] = useState<FileEntry[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageEnvelope[]>([])
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<MessageEnvelope[]>([])
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [diffFiles, setDiffFiles] = useState<DiffFile[]>([])
  const [pendingQuestions, setPendingQuestions] = useState<QuestionRequest[]>([])

  const [projectDashboard, setProjectDashboard] = useState<ProjectDashboard | null>(null)

  const [dashboardError, setDashboardError] = useState<string | null>(null)
  const [todosExpanded, setTodosExpanded] = useState(false)
  const [query, setQuery] = useState("")
  const [composer, setComposer] = useState("")
  const [busySending, setBusySending] = useState(false)
  const [loadingSessionID, setLoadingSessionID] = useState<string | null>(null)
  const [testingConnection, setTestingConnection] = useState(false)
  const [creatingSession, setCreatingSession] = useState(false)
  const [refreshingSessions, setRefreshingSessions] = useState(false)
  const [awaitingAssistantReply, setAwaitingAssistantReply] = useState(false)
  const [settingsNotice, setSettingsNotice] = useState<{ type: NoticeType; text: string } | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<"idle" | "connecting" | "connected" | "reconnecting" | "offline">(
    config.host && config.port > 0 ? "connecting" : "idle"
  )
  const [connectionMessage, setConnectionMessage] = useState<string>("")
  const [eventStreamState, setEventStreamState] = useState<"idle" | "connecting" | "live" | "reconnecting" | "fallback">("idle")
  const [liveEventCount, setLiveEventCount] = useState(0)
  const [liveEventError, setLiveEventError] = useState<string | null>(null)
  const [lastTestedConfigKey, setLastTestedConfigKey] = useState<string | null>(null)
  const [sessionToDelete, setSessionToDelete] = useState<SessionView | null>(null)
  const [renamingSessionID, setRenamingSessionID] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const [activeDetailSheet, setActiveDetailSheet] = useState<null | "ai" | "details">(null)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLDivElement | null>(null)
  const completionAudioRef = useRef<HTMLAudioElement | null>(null)
  const completionShouldPlayRef = useRef(false)
  const wasAwaitingAssistantReplyRef = useRef(false)
  const wasRunningRef = useRef(false)
  const awaitingAssistantBaselineRef = useRef("")
  const loadSelectedRequestRef = useRef(0)
  const loadModelsRequestRef = useRef(0)
  const backgroundFailureCountRef = useRef(0)
  const initialSessionLoadRef = useRef(true)
  const latestMessageTimesRef = useRef(new Map<string, { sessionUpdated: number; activityTime: number }>())
  const selectedSessionRef = useRef<SessionView | null>(null)
  const eventStreamStateRef = useRef<"idle" | "connecting" | "live" | "reconnecting" | "fallback">("idle")
  /** Last time an SSE event arrived for a given session, used to spot sessions the stream isn't covering. */
  const lastEventBySessionRef = useRef(new Map<string, number>())

  const loadedMessagesRef = useRef<MessageEnvelope[]>([])
  const shouldAutoScrollRef = useRef(false)
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedID) ?? null,
    [sessions, selectedID]
  )
  const projectPath = projectDashboard?.project
    ? pickString(projectDashboard.project.path) || pickString(projectDashboard.project.directory) || pickString(projectDashboard.project.root)
    : null
  const projectName = projectDashboard?.project
    ? pickString(projectDashboard.project.name) || (projectPath ? projectPath.split("/").filter(Boolean).pop() ?? projectPath : null)
    : null
  const vcsBranch = projectDashboard?.vcs
    ? pickString(projectDashboard.vcs.branch) || pickString(projectDashboard.vcs.status) || summarizeJson(projectDashboard.vcs)
    : null
  const selectedModel = useMemo(() => modelFromKey(selectedModelKey), [selectedModelKey])
  const activeModelOption = useMemo(() => {
    if (selectedModel) {
      const explicit = modelOptions.find((option) => sameModel(option, selectedModel))
      if (explicit) return explicit
    }
    if (selectedSession?.model) {
      const current = modelOptions.find((option) => sameModel(option, selectedSession.model))
      if (current) return current
    }
    return modelOptions.find((option) => option.isDefault) ?? modelOptions[0] ?? null
  }, [modelOptions, selectedModel, selectedSession?.model])
  const activeModel = activeModelOption
    ? { providerID: activeModelOption.providerID, modelID: activeModelOption.modelID, variant: activeModelOption.variant }
    : undefined
  const primaryAgentOptions = useMemo(() => agentOptions.filter((agent) => agent.mode === "primary" || agent.mode === "all"), [agentOptions])
  const activeAgent = useMemo(() => {
    return primaryAgentOptions.find((agent) => agent.id === selectedAgentID)
      ?? primaryAgentOptions.find((agent) => agent.id === "build")
      ?? primaryAgentOptions[0]
      ?? null
  }, [primaryAgentOptions, selectedAgentID])
  const activeAgentID = activeAgent?.id ?? "build"
  const filteredModelOptions = useMemo(() => {
    const text = modelQuery.trim().toLowerCase()
    if (!text) return modelOptions
    return modelOptions.filter((option) => modelSearchText(option).includes(text))
  }, [modelOptions, modelQuery])

  const filteredSessions = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return sessions
    return sessions.filter((session) => {
      return session.title.toLowerCase().includes(text) || session.directory.toLowerCase().includes(text)
    })
  }, [sessions, query])
  const displayedCommands = useMemo(() => {
    if (commandFilter === "skill") return commands.filter((command) => command.source === "skill")
    return commands
  }, [commands, commandFilter])
  const selectedNewSessionDirectory = normalizeDirectory(newSessionDirectory)

  const renderedMessages = useMemo(() => {
    return [...messages, ...optimisticUserMessages]
      .map(toRenderedMessage)
      .filter((message) => message.text || message.parts.some((part) => part.type !== "step-start" && part.type !== "step-finish"))
  }, [messages, optimisticUserMessages])

  const timelineGroups = useMemo(() => groupRenderedMessages(renderedMessages), [renderedMessages])

  const messageScrollSignature = useMemo(() => {
    return renderedMessages.map((message) => `${message.info.id}:${message.text.length}`).join("|")
  }, [renderedMessages])

  const assistantResponseSignature = useMemo(() => {
    return renderedMessages
      .filter((message) => message.info.role !== "user")
      .map((message) => `${message.info.id}:${message.text.length}`)
      .join("|")
  }, [renderedMessages])
  const backendClient = BACKEND_CLIENTS[config.backend]

  const hasConfiguredServer = isValidServerConfig(config)
  const draftConfigKey = configKey(draftConfig)
  const canTestDraft = canTestConfig(draftConfig)
  const testAlreadyPassedForDraft = lastTestedConfigKey === draftConfigKey
  const connectionStatusText = connectionMessage || (connectionState === "connecting"
    ? t('connection.connecting')
    : connectionState === "reconnecting"
      ? t('connection.reconnecting')
      : connectionState === "connected"
        ? t('connection.connected')
        : connectionState === "offline"
          ? t('connection.offline')
          : "")
  const eventStreamText = eventStreamState === "live"
    ? t('events.live', { count: liveEventCount })
    : eventStreamState === "connecting"
      ? t('events.connecting')
      : eventStreamState === "reconnecting"
        ? t('events.reconnecting')
        : eventStreamState === "fallback"
          ? t('events.fallback', { error: liveEventError ?? t('events.unknownError') })
          : ""
  const isSessionRunning = Boolean(selectedSession && ["busy", "retry"].includes(selectedSession.status))
  const isWaitingForOpenCodeReply = awaitingAssistantReply || busySending || isSessionRunning
  const isWorking = isWaitingForOpenCodeReply
  const showStopAction = isWorking && !composer.trim()
  const showTypingBubble = Boolean(selectedSession) && isWaitingForOpenCodeReply
  const activeSessions = sessions.filter((session) => ["busy", "retry"].includes(session.status)).length
  const changedSessions = sessions.filter(
    (session) => session.files > 0 || session.additions > 0 || session.deletions > 0
  ).length
  const totalDiffAdditions = diffFiles.reduce((sum, file) => sum + file.additions, 0)
  const totalDiffDeletions = diffFiles.reduce((sum, file) => sum + file.deletions, 0)
  const showModelChip = modelOptions.length > 1 || Boolean(activeModelOption) || primaryAgentOptions.length > 0

  async function openSession(sessionID: string, directory: string) {
    setSelectedID(sessionID)
    setSelectedModelKey(readStoredModel(config.backend, sessionID))
    loadModelsRequestRef.current += 1
    setModelOptions([])
    setMessages([])
    loadedMessagesRef.current = []
    setOptimisticUserMessages([])
    setTodos([])
    setDiffFiles([])
    setPendingQuestions([])
    setProjectDashboard(null)
    setDashboardError(null)
    setAwaitingAssistantReply(false)
    setRuntimeError(null)
    setView("detail")
    setLoadingSessionID(sessionID)
    try {
      await loadSelected(sessionID, directory, true)
      await Promise.all([loadAgents(), loadModels(sessionID, directory)])
    } catch (err) {
      setRuntimeError((err as Error).message)
    }
    setLoadingSessionID((activeID) => (activeID === sessionID ? null : activeID))
  }

  function applyConfig(nextConfig: ServerConfig) {
    const serverChanged = configKey(nextConfig) !== configKey(config)
    if (serverChanged) {
      loadSelectedRequestRef.current += 1
      loadModelsRequestRef.current += 1
      setSessions([])
      setSelectedID(null)
      setMessages([])
      loadedMessagesRef.current = []
      setOptimisticUserMessages([])
      setTodos([])
      setDiffFiles([])
      setProjectDashboard(null)
      setDashboardError(null)
      setAwaitingAssistantReply(false)
      setConnectedVersion("")
      setCommands([])
      setAgentOptions([])
      setModelOptions([])
      setSelectedModelKey(readStoredModel(nextConfig.backend))
    }
    setConfig(nextConfig)
    localStorage.setItem(BACKEND_STORAGE_KEYS[nextConfig.backend], JSON.stringify(nextConfig))
    localStorage.setItem(ACTIVE_BACKEND_STORAGE_KEY, nextConfig.backend)
    setSettingsNotice({ type: "success", text: t('settings.saved') })
    setConnectionState("connecting")
    setConnectionMessage(t('connection.connecting'))
    setRuntimeError(null)
    backgroundFailureCountRef.current = 0
    initialSessionLoadRef.current = true
  }
  async function testConnection(configToTest: ServerConfig) {
    setTestingConnection(true)
    setSettingsNotice({ type: "info", text: t('settings.testingConnection') })
    try {
      const health = await Promise.race([
        api.health(configToTest),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Connection timed out")), 12000))
      ])
      if (health.backend && health.backend !== configToTest.backend) {
        throw new Error(`Expected ${backendDisplayName(configToTest.backend)} but reached ${backendDisplayName(health.backend)}`)
      }
      setConnectedVersion(health.version)
      setLastTestedConfigKey(configKey(configToTest))
      setSettingsNotice({ type: "success", text: t('settings.testedNotSaved', { version: health.version }) })
    } catch (err) {
      setSettingsNotice({ type: "error", text: t('settings.connectionFailed', { message: (err as Error).message }) })
    } finally {
      setTestingConnection(false)
    }
  }

  async function refreshSessions(silent = false, preserveSession?: SessionView) {
    if (!isValidServerConfig(config)) return
    if (!silent) {
      setRuntimeError(null)
      setConnectionState(sessions.length === 0 ? "connecting" : "reconnecting")
      setConnectionMessage(sessions.length === 0 ? t('connection.loadingSessions') : t('connection.refreshing'))
    } else if (initialSessionLoadRef.current && sessions.length === 0) {
      setConnectionState("connecting")
      setConnectionMessage(t('connection.loadingSessions'))
    }
    try {
      const items = await api.listGlobalSessions(config).catch(() => api.listSessions(config))
      const directories = [...new Set(items.map((session) => session.directory).filter(Boolean))]
      const [sessionLists, statusMaps] = await Promise.all([
        Promise.all(directories.map((directory) => api.listSessions(config, directory).catch(() => [] as Session[]))),
        Promise.all(directories.map((directory) => api.listStatuses(config, directory).catch(() => ({} as Record<string, SessionStatus>))))
      ])
      const scopedSessions = new Map(sessionLists.flat().map((session) => [session.id, session]))
      const statuses = Object.assign({}, ...statusMaps)
      const hydratedItems = items.map((session) => ({ ...session, ...scopedSessions.get(session.id), project: session.project }))
      const activityTimes = await loadSessionActivityTimes(hydratedItems)
      const mapped = hydratedItems
        .map((session) => toSessionView(session, statuses[session.id], activityTimes.get(session.id)))
        .sort((a, b) => b.updated - a.updated)
      setSessions((current) => {
        const selected = selectedID ? current.find((session) => session.id === selectedID) : null
        const toPreserve = preserveSession ?? selected
        if (!toPreserve || mapped.some((session) => session.id === toPreserve.id)) return mapped
        return [toPreserve, ...mapped].sort((a, b) => b.updated - a.updated)
      })
      backgroundFailureCountRef.current = 0
      initialSessionLoadRef.current = false
      setConnectionState("connected")
      setConnectionMessage(t('connection.connected'))
      setRuntimeError(null)
    } catch (err) {
      const message = (err as Error).message
      if (!silent) {
        setConnectionState("offline")
        setConnectionMessage(t('connection.offline'))
        setRuntimeError(message)
        return
      }

      backgroundFailureCountRef.current += 1
      if (backgroundFailureCountRef.current === 1) {
        setConnectionState("reconnecting")
        setConnectionMessage(t('connection.reconnecting'))
        return
      }

      setConnectionState("offline")
      setConnectionMessage(t('connection.offline'))
      if (backgroundFailureCountRef.current >= 3) {
        setRuntimeError(message)
      }
    }
  }

  async function refreshSessionsWithIndicator() {
    if (refreshingSessions) return
    setRefreshingSessions(true)
    try {
      await refreshSessions()
    } finally {
      setRefreshingSessions(false)
    }
  }

  async function loadCommands() {
    if (!isValidServerConfig(config)) return
    try {
      const list = await api.listCommands(config)
      setCommands(list)
    } catch {
      setCommands([])
    }
  }

  async function loadAgents() {
    if (!isValidServerConfig(config) || !capabilities.agents) {
      setAgentOptions([])
      return
    }
    try {
      const list = await api.listAgents(config, selectedSession?.directory ?? selectedNewSessionDirectory)
      setAgentOptions(list)
      setAgentLoadError(null)
      const saved = localStorage.getItem(AGENT_STORAGE_KEY) || selectedAgentID
      const primary = list.filter((agent) => agent.mode === "primary" || agent.mode === "all")
      const next = primary.find((agent) => agent.id === saved) ?? primary.find((agent) => agent.id === "build") ?? primary[0]
      if (next) {
        setSelectedAgentID(next.id)
        localStorage.setItem(AGENT_STORAGE_KEY, next.id)
      }
    } catch (err) {
      setAgentLoadError((err as Error).message)
    }
  }

  async function loadModels(sessionID = selectedSession?.id, directory = selectedSession?.directory ?? selectedNewSessionDirectory) {
    if (!isValidServerConfig(config) || !capabilities.models) return
    const requestID = ++loadModelsRequestRef.current
    try {
      const list = await api.listModels(config, directory, backendClient.modelSelectionRequiresSession ? sessionID : undefined)
      if (requestID !== loadModelsRequestRef.current) return
      setModelOptions(list)
      setModelLoadError(null)
      const sessionModel = sessions.find((session) => session.id === sessionID)?.model
      const sessionOption = sessionModel ? list.find((option) => sameModel(option, sessionModel)) : null
      if (sessionOption) {
        const nextKey = modelKey(sessionOption)
        setSelectedModelKey(nextKey)
        writeStoredModel(config.backend, sessionID, nextKey)
        return
      }
      const savedKey = readStoredModel(config.backend, sessionID)
      const saved = modelFromKey(savedKey)
      const savedOption = saved ? list.find((option) => sameModel(option, saved)) : null
      if (savedOption) {
        setSelectedModelKey(savedKey)
        return
      }
      const fallback = list.find((option) => option.isDefault) ?? list[0]
      if (fallback) {
        const nextKey = modelKey(fallback)
        setSelectedModelKey(nextKey)
        writeStoredModel(config.backend, sessionID, nextKey)
      }
    } catch (err) {
      if (requestID === loadModelsRequestRef.current) setModelLoadError((err as Error).message)
    }
  }

  async function loadSessionActivityTimes(items: Session[]): Promise<Map<string, number>> {
    if (config.backend !== "opencode") {
      return new Map(items.map((session) => [session.id, session.time.updated]))
    }
    const results = await Promise.all(items.map(async (session) => {
      const cached = latestMessageTimesRef.current.get(session.id)
      if (cached?.sessionUpdated === session.time.updated) return [session.id, cached.activityTime] as const

      const latest = await api.loadLatestMessage(config, session.id, session.directory).catch(() => null)
      if (latest === null) return [session.id, session.time.updated] as const
      const activityTime = latest.length > 0 ? Math.max(...latest.map(messageActivityTime)) : session.time.updated
      latestMessageTimesRef.current.set(session.id, { sessionUpdated: session.time.updated, activityTime })
      return [session.id, activityTime] as const
    }))
    return new Map(results)
  }

  function changeModel(nextKey: string) {
    setSelectedModelKey(nextKey)
    writeStoredModel(config.backend, selectedSession?.id, nextKey)
  }

  function changeAgent(nextAgentID: string) {
    setSelectedAgentID(nextAgentID)
    localStorage.setItem(AGENT_STORAGE_KEY, nextAgentID)
  }

  async function loadSelected(sessionID: string, directory: string, refreshHistory = false) {
    const requestID = ++loadSelectedRequestRef.current
    const [msg, todo, diff, questions] = await Promise.all([
      api.loadMessages(config, sessionID, directory, backendClient.messageRefreshSupported && refreshHistory),
      capabilities.todos ? api.loadTodo(config, sessionID, directory) : Promise.resolve([]),
      capabilities.diff ? api.loadDiff(config, sessionID, directory).catch(() => []) : Promise.resolve([]),
      capabilities.questions ? api.loadQuestions(config, directory).catch(() => []) : Promise.resolve([])
    ])
    if (requestID !== loadSelectedRequestRef.current) return
    const current = loadedMessagesRef.current
    if (
      !messagesHaveSameContent(current, msg) &&
      assistantPayloadLength(current) <= assistantPayloadLength(msg)
    ) {
      shouldAutoScrollRef.current = messagesExtendContent(current, msg) && isNearMessagesBottom()
      loadedMessagesRef.current = msg
      setMessages((prev) => mergeFetchedMessages(prev, msg))
    }
    setOptimisticUserMessages((current) => current.filter((message) => !hasMatchingUserMessage(msg, message)))
    setTodos(todo)
    setDiffFiles(diff)
    setPendingQuestions(questions.filter((question) => question.sessionID === sessionID))
    await loadProjectDashboard(directory)
  }

  async function loadProjectDashboard(directory: string) {
    setDashboardError(null)
    try {
      const [project, vcs, fileStatus] = await Promise.all([
        api.loadProjectCurrent(config, directory).catch(() => null),
        api.loadVcs(config, directory).catch(() => null),
        api.loadFileStatus(config, directory).catch(() => [])
      ])
      setProjectDashboard({ project, vcs, files: toFileStatusList(fileStatus) })
    } catch (err) {
      setDashboardError((err as Error).message)
    }
  }

  function syncChatBottomClearance() {
    const container = messagesRef.current
    const composer = composerRef.current
    if (!container || !composer) return

    const composerRect = composer.getBoundingClientRect()
    const composerStyles = window.getComputedStyle(composer)
    const composerBottom = Number.parseFloat(composerStyles.bottom) || 0
    const clearance = Math.ceil(composerRect.height + composerBottom + 16)
    container.style.setProperty("--chat-bottom-clearance", `${clearance}px`)
  }

  function isNearMessagesBottom(): boolean {
    const container = messagesRef.current
    if (!container) return true
    const containerDistance = container.scrollHeight - container.scrollTop - container.clientHeight
    if (containerDistance > BOTTOM_STICK_THRESHOLD) return false
    // The page itself can also scroll (the composer is pinned via fixed positioning), so a user
    // scrolling the outer window away from the bottom must also break the auto-scroll pin.
    const doc = document.documentElement
    const windowDistance = doc.scrollHeight - window.scrollY - window.innerHeight
    return windowDistance <= BOTTOM_STICK_THRESHOLD
  }

  const handleMessagesScroll = useCallback(() => {
    stickToBottomRef.current = isNearMessagesBottom()
  }, [])

  const handleQuestionResolved = useCallback((id: string) => {
    setPendingQuestions((current) => current.filter((item) => item.id !== id))
  }, [])

  function scrollMessagesToBottom(behavior: ScrollBehavior = "smooth") {
    requestAnimationFrame(() => {
      syncChatBottomClearance()
      requestAnimationFrame(() => {
        const container = messagesRef.current
        const end = messagesEndRef.current
        if (container) {
          container.scrollTo({ top: container.scrollHeight, behavior })
        }
        end?.scrollIntoView({ block: "end", behavior })

        const composerRect = composerRef.current?.getBoundingClientRect()
        const endRect = end?.getBoundingClientRect()
        if (composerRect && endRect && endRect.bottom > composerRect.top - 12) {
          const coveredByComposer = endRect.bottom - composerRect.top + 12
          window.scrollBy({ top: coveredByComposer, behavior })
        }
      })
    })
  }

  async function browseNewSessionDirectory(path: string) {
    setPickerLoading(true)
    setPickerError(null)
    try {
      const items = await api.listFiles(config, path, path)
      setPickerPath(path)
      setPickerItems(items.filter((item) => item.type === "directory").sort((a, b) => a.name.localeCompare(b.name)))
    } catch (err) {
      setPickerError((err as Error).message)
      setPickerItems([])
    } finally {
      setPickerLoading(false)
    }
  }

  async function openNewSessionPicker() {
    if (creatingSession) return
    setRuntimeError(null)
    setShowNewSessionPicker(true)
    setPickerError(null)
    try {
      const pathInfo = await api.loadPath(config, selectedNewSessionDirectory)
      await browseNewSessionDirectory(selectedNewSessionDirectory ?? pathInfo.directory)
    } catch (err) {
      setPickerError((err as Error).message)
    }
  }

  function parentDirectory(path: string): string | null {
    if (!path || path === "/") return null
    const normalized = path.replace(/[/\\]+$/, "")
    const separator = normalized.includes("\\") ? "\\" : "/"
    const index = normalized.lastIndexOf(separator)
    if (index <= 0) return separator === "/" ? "/" : null
    return normalized.slice(0, index)
  }

  async function createSession(directory = selectedNewSessionDirectory) {
    if (creatingSession) return
    setCreatingSession(true)
    setRuntimeError(null)
    setPickerError(null)
    try {
      if (directory) {
        const pathInfo = await api.loadPath(config, directory)
        if (!isProjectDirectory(pathInfo)) {
          throw new Error(t('sessions.projectDirectoryInvalid', { directory }))
        }
      }
      const created = await api.createSession(config, "Mobile session", activeModel, directory)
      const createdView = toSessionView(created)
      if (directory) {
        setNewSessionDirectory(directory)
      }
      setShowNewSessionPicker(false)
      setSessions((current) => {
        if (current.some((session) => session.id === created.id)) return current
        return [createdView, ...current].sort((a, b) => b.updated - a.updated)
      })
      setSelectedID(created.id)
      setMessages([])
      setOptimisticUserMessages([])
      setTodos([])
      setDiffFiles([])
      setProjectDashboard(null)
      setDashboardError(null)
      setAwaitingAssistantReply(false)
      loadedMessagesRef.current = []
      setView("detail")
      setLoadingSessionID(created.id)
      try {
        await loadSelected(created.id, created.directory)
        await Promise.all([loadAgents(), loadModels(created.id, created.directory)])
        await refreshSessions(false, createdView)
      } catch (err) {
        setRuntimeError((err as Error).message)
      } finally {
        setLoadingSessionID((activeID) => (activeID === created.id ? null : activeID))
      }
    } catch (err) {
      setPickerError((err as Error).message)
      setRuntimeError((err as Error).message)
    } finally {
      setCreatingSession(false)
    }
  }

  async function send() {
    if (!selectedSession) return
    const text = composer.trim()
    if (!text) return

    if (text.startsWith("/")) {
      const normalized = text.slice(1)
      const command = normalized.split(" ")[0]?.trim() ?? ""
      const args = normalized.slice(command.length).trim()
      const localCommand = command.toLowerCase()

      if (localCommand === "help" || localCommand === "commands" || localCommand === "skills") {
        setComposer("")
        setRuntimeError(null)
        setCommandFilter(localCommand === "skills" ? "skill" : "all")
        setHelpPage("commands")
        setView("help")
        return
      }

      if (!command) return

      if (localCommand === "status") {
        const status = [
          `Connection: ${connectionStatusText || connectionState}`,
          `Server: ${hasConfiguredServer ? `${config.host}:${config.port}` : "not configured"}`,
          `Session: ${selectedSession.title} (${selectedSession.status})`,
          `Directory: ${selectedSession.directory}`,
          `Agent: ${activeAgent?.name ?? activeAgentID}`,
          `Model: ${activeModelOption ? `${activeModelOption.providerName} / ${activeModelOption.modelName}` : "default"}`
        ].join("\n")
        setComposer("")
        setRuntimeError(null)
        setOptimisticUserMessages((current) => [
          ...current,
          createOptimisticUserMessage(selectedSession.id, text),
          createLocalAssistantMessage(selectedSession.id, status)
        ])
        scrollMessagesToBottom("smooth")
        return
      }

      let availableCommands = commands
      if (availableCommands.length === 0) {
        try {
          availableCommands = await api.listCommands(config)
          setCommands(availableCommands)
        } catch (err) {
          setRuntimeError(`Cannot load server commands: ${(err as Error).message}`)
          return
        }
      }

      if (!availableCommands.some((item) => item.name === command)) {
        const available = availableCommands.map((item) => `/${item.name}`).join(", ")
        setRuntimeError(`Command not found: "/${command}". Available commands: ${available}`)
        return
      }

      setComposer("")
      const optimisticMessage = createOptimisticUserMessage(selectedSession.id, text)
      setOptimisticUserMessages((current) => [...current, optimisticMessage])
      awaitingAssistantBaselineRef.current = assistantResponseSignature
      completionShouldPlayRef.current = true
      setAwaitingAssistantReply(true)
      scrollMessagesToBottom("smooth")

      setBusySending(true)
      setRuntimeError(null)
      try {
        await api.sendCommand(config, selectedSession.id, command, args, selectedSession.directory, activeModel, activeAgentID)
        await loadSelected(selectedSession.id, selectedSession.directory)
        setOptimisticUserMessages((current) => current.filter((message) => message.info.id !== optimisticMessage.info.id))
        await refreshSessions()
      } catch (err) {
        completionShouldPlayRef.current = false
        setAwaitingAssistantReply(false)
        setOptimisticUserMessages((current) => current.filter((message) => message.info.id !== optimisticMessage.info.id))
        setComposer((current) => current || text)
        setRuntimeError((err as Error).message)
      } finally {
        setBusySending(false)
      }
      return
    }

    setComposer("")
    const optimisticMessage = createOptimisticUserMessage(selectedSession.id, text)
    setOptimisticUserMessages((current) => [...current, optimisticMessage])
    awaitingAssistantBaselineRef.current = assistantResponseSignature
    completionShouldPlayRef.current = true
    setAwaitingAssistantReply(true)
    scrollMessagesToBottom("smooth")

    setBusySending(true)
    setRuntimeError(null)
    try {
      await api.sendPrompt(config, selectedSession.id, text, selectedSession.directory, activeModel, activeAgentID)
      await loadSelected(selectedSession.id, selectedSession.directory)
      await refreshSessions()
    } catch (err) {
      completionShouldPlayRef.current = false
      setAwaitingAssistantReply(false)
      setOptimisticUserMessages((current) => current.filter((message) => message.info.id !== optimisticMessage.info.id))
      setComposer((current) => current || text)
      setRuntimeError((err as Error).message)
    } finally {
      setBusySending(false)
    }
  }

  async function deleteSession(sessionID: string) {
    try {
      await api.deleteSession(config, sessionID, sessionToDelete?.directory)
      if (selectedID === sessionID) {
        setSelectedID(null)
        setMessages([])
        loadedMessagesRef.current = []
        setOptimisticUserMessages([])
        setTodos([])
        setDiffFiles([])
        setProjectDashboard(null)
        setDashboardError(null)
        setView("sessions")
      }
      setSessionToDelete(null)
      await refreshSessions(true)
    } catch (err) {
      setRuntimeError((err as Error).message)
    }
  }

  async function renameSession(sessionID: string, newTitle: string, directory: string) {
    if (!newTitle.trim()) return
    try {
      await api.renameSession(config, sessionID, newTitle.trim(), directory)
      setRenamingSessionID(null)
      setRenameValue("")
      await refreshSessions(true)
    } catch (err) {
      setRuntimeError((err as Error).message)
    }
  }

  function startRename(session: SessionView) {
    setRenameValue(session.title)
    setRenamingSessionID(session.id)
    // Focus the input after render
    setTimeout(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }, 50)
  }

  function cancelRename() {
    setRenamingSessionID(null)
    setRenameValue("")
  }

  async function abortSession() {
    if (!selectedSession) return
    try {
      await api.abort(config, selectedSession.id, selectedSession.directory)
      completionShouldPlayRef.current = false
      setAwaitingAssistantReply(false)
      await refreshSessions()
      await loadSelected(selectedSession.id, selectedSession.directory)
    } catch (err) {
      setRuntimeError((err as Error).message)
    }
  }

  useEffect(() => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  }, [language])

  // Android back: dismiss whatever is on top, then fall back to the session list,
  // and only leave the app from there. Reads state through a ref because the
  // handler is registered once and must not capture a stale view.
  const backStateRef = useRef({ view, activeDetailSheet, sessionToDelete, renamingSessionID })
  backStateRef.current = { view, activeDetailSheet, sessionToDelete, renamingSessionID }

  useEffect(() => {
    let handle: PluginListenerHandle | undefined
    let removed = false
    void CapacitorApp.addListener("backButton", () => {
      const state = backStateRef.current
      if (state.sessionToDelete) {
        setSessionToDelete(null)
        return
      }
      if (state.renamingSessionID) {
        setRenamingSessionID(null)
        return
      }
      if (state.activeDetailSheet) {
        setActiveDetailSheet(null)
        return
      }
      if (state.view !== "sessions") {
        setView("sessions")
        return
      }
      CapacitorApp.exitApp()
    }).then((registered) => {
      // The effect can be torn down before registration resolves.
      if (removed) void registered.remove()
      else handle = registered
    })
    return () => {
      removed = true
      void handle?.remove()
    }
  }, [])

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")

    function applyThemePreference() {
      const resolvedTheme = theme === "system" && mediaQuery.matches ? "dark" : theme === "dark" ? "dark" : "light"
      document.documentElement.dataset.theme = resolvedTheme
      document.documentElement.style.colorScheme = resolvedTheme
    }

    localStorage.setItem(THEME_STORAGE_KEY, theme)
    applyThemePreference()
    mediaQuery.addEventListener("change", applyThemePreference)
    return () => mediaQuery.removeEventListener("change", applyThemePreference)
  }, [theme])

  useEffect(() => {
    localStorage.setItem(NEW_SESSION_DIRECTORY_STORAGE_KEY, newSessionDirectory)
  }, [newSessionDirectory])

  useEffect(() => {
    selectedSessionRef.current = selectedSession
  }, [selectedSession])

  useEffect(() => {
    eventStreamStateRef.current = eventStreamState
  }, [eventStreamState])

  useEffect(() => {
    if (configKey(draftConfig) === configKey(config)) return
    // A half-typed host such as `http://` cannot be turned into a URL. Persisting it
    // would also poison the next launch, so incomplete drafts are simply not applied.
    if (draftConfig.host.trim() && !isValidServerConfig(draftConfig)) return
    const timer = setTimeout(() => applyConfig(draftConfig), 500)
    return () => clearTimeout(timer)
  }, [draftConfig, config])

  useEffect(() => {
    if (!selectedSession) {
      setModelOptions([])
      setModelLoadError(null)
      return
    }
    loadModels(selectedSession.id, selectedSession.directory).catch(() => undefined)
  }, [config.backend, config.host, config.port, config.username, config.password, selectedSession?.id])

  useEffect(() => {
    if (!isValidServerConfig(config)) {
      setConnectionState("idle")
      setConnectionMessage("")
      return
    }
    setConnectionState("connecting")
    setConnectionMessage(t('connection.connecting'))
    backgroundFailureCountRef.current = 0
    initialSessionLoadRef.current = true
    refreshSessions(true).catch(() => undefined)
    loadCommands().catch(() => undefined)
    if (capabilities.agents) loadAgents().catch(() => undefined)
    if (capabilities.models) loadModels().catch(() => undefined)
    const timer = setInterval(() => {
      // Live SSE events already keep sessions and the open session's messages/todos/diffs in sync
      // (via applyStreamedPartUpdate/scheduleRefresh), so polling on top of a working stream is a
      // redundant full refetch. But "connected" only proves the stream is open, not that it carries
      // this session: opencode emits events on an in-process bus, so a session driven by a *different*
      // opencode process (a local TUI running its own server) never produces events here even though
      // the stream is perfectly healthy. Keep polling as a per-session fallback — skip it only while
      // the open session is actually receiving events.
      if (eventStreamStateRef.current === "live") {
        const openSession = selectedSessionRef.current
        if (openSession) {
          const lastEventAt = lastEventBySessionRef.current.get(openSession.id) ?? 0
          if (Date.now() - lastEventAt < SESSION_STREAM_QUIET_MS) return
        }
      }
      refreshSessions(true).catch(() => undefined)
      if (selectedSession) {
        loadSelected(selectedSession.id, selectedSession.directory).catch(() => undefined)
      }
    }, 3500)
    return () => clearInterval(timer)
  }, [capabilities.agents, capabilities.models, config.backend, config.host, config.port, config.username, config.password, selectedSession?.id, selectedNewSessionDirectory])

  useEffect(() => {
    const fallback = DEFAULT_HARNESS_CAPABILITIES[config.backend]
    setCapabilities(fallback)
    if (config.backend === "opencode" || !isValidServerConfig(config)) return
    api.capabilities(config).then(setCapabilities).catch(() => setCapabilities(fallback))
  }, [config.backend, config.host, config.port, config.username, config.password])

  useEffect(() => {
    if (!isValidServerConfig(config)) {
      setEventStreamState("idle")
      return
    }
    setEventStreamState("connecting")
    let stream: { url: string; headers: Record<string, string> }
    try {
      stream = api.eventStream(config)
    } catch (error) {
      setLiveEventError((error as Error).message)
      setEventStreamState("fallback")
      return
    }
    const { url, headers } = stream
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = () => {
      if (refreshTimer !== undefined) return
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined
        refreshSessions(true).catch(() => undefined)
        const selected = selectedSessionRef.current
        if (selected) loadSelected(selected.id, selected.directory).catch(() => undefined)
      }, 250)
    }
    const onEvent = (event: { data: unknown; name: string }) => {
      const type = eventType(event.data) ?? event.name
      const payload = eventPayload(event.data)
      const body = (payload?.properties ?? payload?.data ?? payload) as
        | {
            sessionID?: string
            sessionId?: string
            message?: string
            part?: MessagePart
            messageID?: string
            partID?: string
            field?: string
            delta?: string
            info?: { id?: string; sessionID?: string }
          }
        | undefined
      if (type === "session.error" && body?.sessionId && body.sessionId === selectedSessionRef.current?.id) {
        completionShouldPlayRef.current = false
        setAwaitingAssistantReply(false)
        setBusySending(false)
        setRuntimeError(body.message ?? "The agent stopped with an error")
      }
      if (type === "message.part.updated" && body?.sessionID && body.part) {
        setMessages((current) => applyStreamedPartUpdate(current, body.sessionID!, body.part!))
      } else if (
        type === "message.part.delta" &&
        body?.sessionID &&
        body.messageID &&
        body.partID &&
        body.field &&
        typeof body.delta === "string"
      ) {
        setMessages((current) =>
          applyStreamedPartDelta(current, body.sessionID!, body.messageID!, body.partID!, body.field!, body.delta!)
        )
      }
      if (type.startsWith("session.") || type.startsWith("message.") || type.startsWith("todo.") || type.startsWith("question.")) {
        // `session.*` events carry the id on the session itself; `message.*`/`todo.*` use sessionID.
        const sessionID = body?.sessionID ?? body?.sessionId ?? body?.info?.sessionID ?? body?.info?.id
        if (sessionID) lastEventBySessionRef.current.set(sessionID, Date.now())
        setLiveEventCount((count) => count + 1)
        scheduleRefresh()
      }
    }
    const onStatus = (status: EventStreamStatus) => {
      if (status.type === "connected") {
        setLiveEventError(null)
        setEventStreamState("live")
      }
      if (status.type === "reconnecting") setEventStreamState("reconnecting")
      if (status.type === "connection-error") {
        setLiveEventError(status.error)
        setEventStreamState("fallback")
      }
    }
    const subscription = isNativeEventTransport()
      ? createNativeOpenCodeEventSubscription({
          url,
          username: config.username,
          password: config.password,
          onEvent,
          onStatus
        })
      : createFetchOpenCodeEventSubscription({ url, headers, onEvent, onStatus })
    return () => {
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
      subscription.close()
    }
  }, [config.backend, config.host, config.port, config.username, config.password])

  useEffect(() => {
    if (!hasConfiguredServer) {
      setView("settings")
    }
  }, [hasConfiguredServer])

  useEffect(() => {
    const onWindowScroll = () => handleMessagesScroll()
    window.addEventListener("scroll", onWindowScroll, { passive: true })
    return () => window.removeEventListener("scroll", onWindowScroll)
  }, [])

  useEffect(() => {
    if (view !== "detail") return
    if (!stickToBottomRef.current) return
    scrollMessagesToBottom("auto")
  }, [view, messageScrollSignature, isWorking, showTypingBubble, pendingQuestions])

  useEffect(() => {
    if (view !== "detail" || !selectedID) return
    const container = messagesRef.current
    if (!container) return
    // Opening a session should always land at the bottom, regardless of where a previous session left off.
    stickToBottomRef.current = true
    scrollMessagesToBottom("auto")
    // Tool/diff parts fetch their content asynchronously and grow after the
    // initial layout, so keep pinning to the bottom while that settles — but only while the
    // user hasn't scrolled away from it.
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) scrollMessagesToBottom("auto")
    })
    observer.observe(container)
    const timeout = setTimeout(() => observer.disconnect(), 2000)
    return () => {
      observer.disconnect()
      clearTimeout(timeout)
    }
  }, [view, selectedID])

  useEffect(() => {
    loadedMessagesRef.current = messages
    if (!shouldAutoScrollRef.current) return
    shouldAutoScrollRef.current = false
    scrollMessagesToBottom("smooth")
  }, [messages])

  useEffect(() => {
    if (!awaitingAssistantReply) return
    if (assistantResponseSignature && assistantResponseSignature !== awaitingAssistantBaselineRef.current) {
      setAwaitingAssistantReply(false)
    }
  }, [assistantResponseSignature, awaitingAssistantReply])

  useEffect(() => {
    completionAudioRef.current = new Audio("/audio/staplebops-01.aac")
    completionAudioRef.current.preload = "auto"
  }, [])

  useEffect(() => {
    if (wasAwaitingAssistantReplyRef.current && !awaitingAssistantReply && completionShouldPlayRef.current) {
      completionShouldPlayRef.current = false
      const audio = completionAudioRef.current
      if (audio) {
        audio.currentTime = 0
        audio.play().catch(() => undefined)
      }
    }
    wasAwaitingAssistantReplyRef.current = awaitingAssistantReply
  }, [awaitingAssistantReply])

  useEffect(() => {
    if (!selectedSession) {
      wasRunningRef.current = false
      return
    }
    wasRunningRef.current = ["busy", "retry"].includes(selectedSession.status)
  }, [selectedSession?.id, selectedSession?.status])

  const navItems = [
    { view: "sessions" as const, label: t('nav.sessions'), icon: <FolderIcon size={19} />, disabled: !hasConfiguredServer },
    { view: "detail" as const, label: t('nav.detail'), icon: <ChatIcon size={19} />, disabled: !selectedSession },
    { view: "settings" as const, label: t('nav.settings'), icon: <SettingsIcon size={19} />, disabled: false },
    { view: "help" as const, label: t('nav.help'), icon: <HelpIcon size={19} />, disabled: false }
  ]

  return (
    <div className="app-shell">
      <header className="top-nav fade-in">
        <div className="brand-section">
          <div className="brand-title">
            <img src="/app-icon.png" alt="" className="app-icon" />
            <div>
              <h1>{t('app.title')}</h1>
              <p className="subtle">
                {hasConfiguredServer ? `${config.host}:${config.port}` : t('settings.title')}
              </p>
            </div>
          </div>
        </div>

        <nav className="desktop-nav tab-row" role="navigation" aria-label="Main navigation">
          {navItems.map((item) => (
            <button
              key={item.view}
              className={view === item.view ? "active" : ""}
              onClick={() => setView(item.view)}
              disabled={item.disabled}
              aria-label={item.label}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </header>

      {view === "settings" && (
        <section className="panel settings fade-in">
          <div className="section-heading">
            <div>
              <h2>{t('settings.title')}</h2>
              <p className="subtle">{hasConfiguredServer ? `${config.host}:${config.port}` : t('settings.hostPlaceholder')}</p>
              <p className="subtle">{t('settings.draftHint')}</p>
            </div>
          </div>

          <div className="form-grid">
          <label htmlFor="language">
            {t('settings.language')}
            <select
              id="language"
              value={language}
              onChange={(event) => setLanguage(normalizeLanguage(event.target.value))}
            >
              {languageOptions.map((option) => (
                <option key={option.code} value={option.code}>{option.label}</option>
              ))}
            </select>
          </label>

          <label htmlFor="theme">
            {t('settings.theme')}
            <select
              id="theme"
              value={theme}
              onChange={(event) => setTheme(event.target.value as ThemePreference)}
            >
              <option value="system">{t('settings.themeSystem')}</option>
              <option value="light">{t('settings.themeLight')}</option>
              <option value="dark">{t('settings.themeDark')}</option>
            </select>
          </label>
          
          <label htmlFor="backend">
            {t('settings.backend')}
            <select
              id="backend"
              value={draftConfig.backend}
              onChange={(event) => {
                const backend = event.target.value as ServerConfig["backend"]
                setDraftConfig(readConfig(backend))
              }}
            >
              <option value="opencode">OpenCode</option>
              <option value="omp">Oh My Pi (bridge)</option>
              <option value="pi">PI (ACP bridge)</option>
            </select>
          </label>

          <label htmlFor="host">
            {t('settings.host')}
            <input
              id="host"
              value={draftConfig.host}
              onChange={(event) => setDraftConfig({ ...draftConfig, host: event.target.value })}
              placeholder={t('settings.hostPlaceholder')}
            />
          </label>
          
          <label htmlFor="port">
            {t('settings.port')}
            <input
              id="port"
              type="number"
              value={draftConfig.port}
              onChange={(event) => setDraftConfig({ ...draftConfig, port: Number(event.target.value || 0) })}
              placeholder="4096"
            />
          </label>
          
          <label htmlFor="username">
            {t('settings.username')}
            <input
              id="username"
              value={draftConfig.username}
              onChange={(event) => setDraftConfig({ ...draftConfig, username: event.target.value })}
              placeholder="opencode"
            />
          </label>
          
          <label htmlFor="password">
            {t('settings.password')}
            <input
              id="password"
              type="password"
              value={draftConfig.password}
              onChange={(event) => setDraftConfig({ ...draftConfig, password: event.target.value })}
              placeholder={t('settings.passwordPlaceholder')}
            />
          </label>
          </div>
          
          <div className="actions">
            <button 
              onClick={() => testConnection(draftConfig)} 
              className="btn-secondary"
              disabled={testingConnection || !canTestDraft || testAlreadyPassedForDraft}
              title={!canTestDraft ? t('settings.testNeedsFields') : testAlreadyPassedForDraft ? t('settings.testAlreadyPassed') : undefined}
            >
              {testingConnection ? (
                <>
                  <LoadingIcon size={18} />
                  {t('settings.testing')}
                </>
              ) : (
                <>
                  <TestIcon size={18} />
                  {testAlreadyPassedForDraft ? t('settings.testOk') : t('settings.test')}
                </>
              )}
            </button>
          </div>
          
          {settingsNotice && (
            <div className={`notice ${settingsNotice.type} fade-in`}>
              {settingsNotice.type === 'success' && '✓ '}
              {settingsNotice.type === 'error' && '✗ '}
              {settingsNotice.type === 'info' && 'ℹ '}
              {settingsNotice.text}
            </div>
          )}
          
          <div className="connection-help">
            <span>{canTestDraft ? t('settings.readyToTest') : t('settings.testNeedsFields')}</span>
          </div>

          {connectedVersion && testAlreadyPassedForDraft && (
            <div className="notice success fade-in">
              <TestIcon size={16} />
              {t('settings.connectedTo', { version: connectedVersion })}
            </div>
          )}
        </section>
      )}

      {view === "sessions" && (
        <section className="panel sessions fade-in">
          <div className="section-heading">
            <div>
              <h2>{t('sessions.title')}</h2>
              <p className="subtle">
                {t('sessions.summary', { total: sessions.length, active: activeSessions, changed: changedSessions })}
              </p>
              {(connectionStatusText || eventStreamText) && (
                <div className="connection-status-row">
                  {connectionStatusText && (
                    <p className={`connection-status ${connectionState}`}>
                      {['connecting', 'reconnecting'].includes(connectionState) && <LoadingIcon size={14} />}
                      {connectionStatusText}
                    </p>
                  )}
                  {eventStreamText && (
                    <p className={`connection-status event-stream ${eventStreamState}`}>
                      {['connecting', 'reconnecting'].includes(eventStreamState) && <LoadingIcon size={14} />}
                      {eventStreamText}
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="inline-actions sessions-header-actions">
              <button onClick={refreshSessionsWithIndicator} className="btn-secondary" disabled={refreshingSessions}>
                {refreshingSessions ? <LoadingIcon size={18} /> : <RefreshIcon size={18} />}
                {t('sessions.refresh')}
              </button>
              <button onClick={openNewSessionPicker} className="btn-primary" disabled={creatingSession}>
                {creatingSession ? <LoadingIcon size={18} /> : <PlusIcon size={18} />}
                {creatingSession ? t('sessions.creating') : t('sessions.new')}
              </button>
            </div>
          </div>
          
          <div className="toolbar">
            <input
              placeholder={t('sessions.searchPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="search"
            />
          </div>
          
          <div className="session-list">
            {filteredSessions.length === 0 && ['connecting', 'reconnecting'].includes(connectionState) ? (
              <div className="empty-state connection-pending">
                <LoadingIcon size={40} className="icon-empty-state" />
                <p>{t('sessions.loadingTitle')}</p>
                <p className="subtle">{t('sessions.loadingHint')}</p>
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="empty-state">
                <FolderIcon size={48} className="icon-empty-state" />
                <p>{t('sessions.emptyTitle')}</p>
                <p className="subtle">{connectionState === "offline" ? t('sessions.offlineHint') : t('sessions.emptyHint')}</p>
              </div>
            ) : (
              filteredSessions.map((session) => (
                <article 
                  key={session.id} 
                  className={`session-card ${selectedID === session.id ? "active" : ""} fade-in`}
                  onClick={() => openSession(session.id, session.directory).catch(() => undefined)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      openSession(session.id, session.directory).catch(() => undefined)
                    }
                  }}
                >
                  <div className="session-card-main">
                    <div>
                      {renamingSessionID === session.id ? (
                        <div
                          className="rename-inline"
                          onClick={(event) => event.stopPropagation()}
                          onMouseDown={(event) => event.stopPropagation()}
                        >
                          <input
                            ref={renameInputRef}
                            value={renameValue}
                            onChange={(event) => setRenameValue(event.target.value)}
                            onKeyDown={(event) => {
                              event.stopPropagation()
                              if (event.key === "Enter") {
                                event.preventDefault()
                                renameSession(session.id, renameValue, session.directory).catch(() => undefined)
                              } else if (event.key === "Escape") {
                                cancelRename()
                              }
                            }}
                            onBlur={() => {
                              // Only cancel if not clicked on save button
                              if (renameValue === session.title || !renameValue.trim()) {
                                cancelRename()
                              }
                            }}
                            placeholder={t('session.renamePlaceholder')}
                            className="rename-input"
                            autoComplete="off"
                          />
                          <button
                            className="btn-primary compact"
                            onClick={(event) => {
                              event.stopPropagation()
                              renameSession(session.id, renameValue, session.directory).catch(() => undefined)
                            }}
                            onMouseDown={(event) => event.preventDefault()}
                            title={t('session.renameConfirm')}
                          >
                            <SaveIcon size={14} />
                          </button>
                          <button
                            className="btn-secondary compact"
                            onClick={(event) => {
                              event.stopPropagation()
                              cancelRename()
                            }}
                            title={t('session.cancel')}
                          >
                            <CloseIcon size={14} />
                          </button>
                        </div>
                      ) : (
                        <h3>{session.title}</h3>
                      )}
                      <p>{session.directory}</p>
                    </div>
                  </div>
                  <div className="session-stats">
                    {session.files > 0 || session.additions > 0 || session.deletions > 0 ? (
                      <span className="change-summary">
                        <strong>{session.files}</strong> files
                        <strong className="positive">+{session.additions}</strong>
                        <strong className="negative">-{session.deletions}</strong>
                      </span>
                    ) : (
                      <span className="subtle">{t('sessions.noFileChanges')}</span>
                    )}
                    <span className="subtle">{t('sessions.updated', { time: formatTime(session.updated) })}</span>
                    <span className={`pill ${session.status}`}>{session.status}</span>
                  </div>
                  <div className="inline-actions">
                    {capabilities.sessionRename && capabilities.sessionDelete && (
                      <>
                        <button
                          className="btn-secondary"
                          onClick={(event) => {
                            event.stopPropagation()
                            startRename(session)
                          }}
                          title={t('session.renameTitle')}
                          aria-label={t('session.renameTitle')}
                        >
                          <PencilIcon size={16} />
                          {t('session.renameConfirm')}
                        </button>
                        <button
                          className="btn-danger"
                          onClick={(event) => {
                            event.stopPropagation()
                            setSessionToDelete(session)
                          }}
                          title={t('sessions.delete')}
                        >
                          <TrashIcon size={16} />
                          {t('sessions.delete')}
                        </button>
                      </>
                    )}
                  </div>
                </article>
              ))
            )}
          </div>
          
          {runtimeError && <div className="error fade-in">✗ {runtimeError}</div>}
        </section>
      )}

      {showNewSessionPicker && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowNewSessionPicker(false)}>
          <section
            className="modal-card folder-picker fade-in"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-session-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="new-session-title">{t('sessions.newSessionTitle')}</h2>
            <p className="subtle">{t('sessions.projectDirectoryDefault')}</p>
            <div className="folder-picker-current">
              <span>{t('sessions.projectDirectoryLabel')}</span>
              <strong>{pickerPath || t('detail.loadingProject')}</strong>
            </div>
            <div className="inline-actions">
              <button type="button" className="btn-secondary" onClick={() => createSession("").catch(() => undefined)} disabled={creatingSession}>
                {t('sessions.useServerDefault')}
              </button>
              <button type="button" className="btn-primary" onClick={() => createSession(pickerPath).catch(() => undefined)} disabled={creatingSession || !pickerPath}>
                {creatingSession ? <LoadingIcon size={16} /> : <PlusIcon size={16} />}
                {t('sessions.useThisFolder')}
              </button>
            </div>
            {pickerError && <div className="error fade-in">✗ {pickerError}</div>}
            <div className="folder-list">
              {pickerLoading ? (
                <div className="empty-state compact"><LoadingIcon size={28} /><p>{t('sessions.folderPickerLoading')}</p></div>
              ) : (
                <>
                  {parentDirectory(pickerPath) && (
                    <button type="button" className="folder-row" onClick={() => browseNewSessionDirectory(parentDirectory(pickerPath) ?? pickerPath).catch(() => undefined)}>
                      <FolderIcon size={16} />
                      <span>{t('sessions.parentFolder')}</span>
                    </button>
                  )}
                  {pickerItems.length === 0 ? (
                    <p className="subtle">{t('sessions.folderPickerEmpty')}</p>
                  ) : pickerItems.map((item) => (
                    <button key={item.absolute} type="button" className="folder-row" onClick={() => browseNewSessionDirectory(item.absolute).catch(() => undefined)}>
                      <FolderIcon size={16} />
                      <span>{item.name}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setShowNewSessionPicker(false)}>
                {t('session.cancel')}
              </button>
            </div>
          </section>
        </div>
      )}

      {view === "detail" && (
        <main className="panel detail fade-in">
          <div className="detail-topbar">
            <button className="btn-secondary" onClick={() => {
              setView("sessions");
              requestAnimationFrame(() => document.querySelector<HTMLElement>(".session-card.active")?.scrollIntoView({ block: "center" }));
            }}>{t('detail.backToSessions')}</button>
            {selectedSession && (
              <span className={`pill ${selectedSession.status}`}>{selectedSession.status}</span>
            )}
          </div>
          <div className="header-row detail-header">
              <div>
              <h2>
                {selectedSession ? (
                  <div className="detail-title-row">
                    <ChatIcon size={24} className="icon-inline-heading" />
                    {renamingSessionID === selectedSession.id ? (
                      <div className="rename-inline">
                        <input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(event) => setRenameValue(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault()
                              renameSession(selectedSession.id, renameValue, selectedSession.directory).catch(() => undefined)
                            } else if (event.key === "Escape") {
                              cancelRename()
                            }
                          }}
                          onBlur={() => {
                            if (renameValue === selectedSession.title || !renameValue.trim()) {
                              cancelRename()
                            }
                          }}
                          placeholder={t('session.renamePlaceholder')}
                          className="rename-input"
                          autoComplete="off"
                        />
                        <button
                          className="btn-primary compact"
                          onClick={() => renameSession(selectedSession.id, renameValue, selectedSession.directory).catch(() => undefined)}
                          onMouseDown={(event) => event.preventDefault()}
                          title={t('session.renameConfirm')}
                        >
                          <SaveIcon size={14} />
                        </button>
                        <button
                          className="btn-secondary compact"
                          onClick={() => cancelRename()}
                          title={t('session.cancel')}
                        >
                          <CloseIcon size={14} />
                        </button>
                      </div>
                    ) : (
                      <>
                        {selectedSession.title}
                        {capabilities.sessionRename && (
                          <button
                            className="btn-icon btn-secondary compact"
                            onClick={() => startRename(selectedSession)}
                            title={t('session.renameTitle')}
                            aria-label={t('session.renameTitle')}
                            style={{ marginLeft: 'var(--space-1)' }}
                          >
                            <PencilIcon size={14} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  t('detail.selectSession')
                )}
              </h2>
              {selectedSession && (
                <p className="subtle">
                  {selectedSession.directory} • {t('sessions.updated', { time: formatTime(selectedSession.updated) })}
                </p>
                )}
              </div>
            </div>

          {selectedSession && (
            <section className="session-context-strip" aria-label={t('detail.contextStripLabel')}>
              {showModelChip && (
                <button type="button" className="context-chip" onClick={() => setActiveDetailSheet("ai")}>
                  <span>{t('detail.aiChip')}</span>
                  <strong>{capabilities.agents ? `${agentLabel(activeAgent ?? { id: activeAgentID, name: activeAgentID, mode: "primary" })} · ${activeModelOption?.modelName ?? t('detail.modelLoading')}` : activeModelOption?.modelName ?? t('detail.modelLoading')}</strong>
                </button>
              )}

              <button type="button" className="context-chip ghost" onClick={() => setActiveDetailSheet("details")}>
                <span>{t('detail.detailsChip')}</span>
                <strong>{projectName || t('detail.projectLabel')}</strong>
              </button>
            </section>
          )}

          {todos.length > 0 && (
            <div className="todo-box">
              <div className="todo-header-row">
                <h3>
                  <span style={{ marginRight: 'var(--space-2)' }}>📋</span>
                  {t('todo.title')}
                </h3>
                <button
                  type="button"
                  className="todo-toggle-btn"
                  onClick={() => setTodosExpanded((value) => !value)}
                  aria-expanded={todosExpanded}
                  aria-controls="todo-items-content"
                >
                  {todosExpanded ? t('todo.hide') : t('todo.show')}
                </button>
              </div>
              {todosExpanded && (
                <div id="todo-items-content">
                  {todos.slice(0, 6).map((item) => (
                    <div key={item.id} className="todo-item">
                      <span className={`todo-status ${item.status}`}>
                        {item.status === 'completed' ? '✓' : '○'}
                      </span>
                      <span>{item.content}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <MessagesPane
            loadingSessionID={loadingSessionID}
            selectedID={selectedID}
            renderedMessages={renderedMessages}
            timelineGroups={timelineGroups}
            showTypingBubble={showTypingBubble}
            pendingQuestions={pendingQuestions}
            config={config}
            directory={selectedSession?.directory}
            t={t}
            messagesRef={messagesRef}
            messagesEndRef={messagesEndRef}
            onMessagesScroll={handleMessagesScroll}
            onQuestionResolved={handleQuestionResolved}
          />


          <div className="composer" ref={composerRef}>
            <textarea
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              placeholder={t('detail.composerPlaceholder')}
              onFocus={() => {
                syncChatBottomClearance()
                setTimeout(() => scrollMessagesToBottom("smooth"), 400)
                const onResize = () => {
                  scrollMessagesToBottom("smooth")
                  window.removeEventListener("resize", onResize)
                }
                window.addEventListener("resize", onResize, { once: true })
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  send().catch(() => undefined)
                }
              }}
              disabled={!selectedSession}
            />
            {/* While the agent works the same button stops it, but starts sending again as
                soon as there is something to send, so a follow-up can be queued. */}
            <button
              onClick={showStopAction ? abortSession : send}
              disabled={!selectedSession}
              className={showStopAction ? "btn-danger" : "btn-primary"}
            >
              {showStopAction ? (
                <StopCircleIcon size={18} />
              ) : (
                <SendIcon size={18} />
              )}
            </button>
          </div>

          {runtimeError && <div className="error fade-in">✗ {runtimeError}</div>}
        </main>
      )}

      {activeDetailSheet && selectedSession && (
        <div className="sheet-backdrop" role="presentation" onClick={() => setActiveDetailSheet(null)}>
          <section
            className="bottom-sheet fade-in"
            role="dialog"
            aria-modal="true"
            aria-labelledby="detail-sheet-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sheet-handle" aria-hidden="true" />
            <div className="sheet-header">
              <div>
                <h3 id="detail-sheet-title">
                  {activeDetailSheet === "ai" && t('detail.aiTitle')}
                  {activeDetailSheet === "details" && t('detail.sessionDetailsTitle')}
                </h3>
                <p className="subtle">
                  {activeDetailSheet === "ai" && t('detail.modelHint')}
                  {activeDetailSheet === "details" && t('detail.sessionDetailsHint')}
                </p>
              </div>
              <button type="button" className="btn-secondary compact" onClick={() => setActiveDetailSheet(null)}>
                {t('detail.closeSheet')}
              </button>
            </div>

            {activeDetailSheet === "ai" && (
              <div className="sheet-content">
                <button type="button" className="btn-secondary" onClick={() => Promise.all([loadAgents(), loadModels()]).catch(() => undefined)}>
                  <RefreshIcon size={16} />
                  {t('detail.refreshAi')}
                </button>
                {capabilities.agents && (primaryAgentOptions.length > 0 ? (
                  <div className="agent-controls">
                    <label htmlFor="agent-select">
                      {t('detail.agentSelectLabel')}
                      <select
                        id="agent-select"
                        value={activeAgentID}
                        onChange={(event) => changeAgent(event.target.value)}
                        disabled={isWorking}
                      >
                        {primaryAgentOptions.map((agent) => (
                          <option key={agent.id} value={agent.id}>{agentLabel(agent)}</option>
                        ))}
                      </select>
                    </label>
                    <p className="subtle">
                      {activeAgent?.description || t('detail.agentMode', { mode: activeAgent?.mode ?? 'primary' })}
                    </p>
                  </div>
                ) : (
                  <p className="subtle">{agentLoadError ? t('detail.agentLoadError', { message: agentLoadError }) : t('detail.agentLoading')}</p>
                ))}
                {modelOptions.length > 0 ? (
                  <div className="model-controls">
                    <label htmlFor="model-search">
                      {t('detail.modelSelectLabel')}
                      <input
                        id="model-search"
                        value={modelQuery}
                        onChange={(event) => setModelQuery(event.target.value)}
                        placeholder={t('detail.modelSearchPlaceholder')}
                        disabled={isWorking}
                        autoComplete="off"
                      />
                    </label>
                    <div className="model-option-list" role="listbox" aria-label={t('detail.modelSelectLabel')}>
                      {filteredModelOptions.length > 0 ? (
                        filteredModelOptions.map((option) => {
                          const optionKey = modelKey(option)
                          const active = activeModelOption ? sameModel(option, activeModelOption) : optionKey === selectedModelKey
                          return (
                            <button
                              type="button"
                              key={optionKey}
                              className={active ? "model-option active" : "model-option"}
                              onClick={() => changeModel(optionKey)}
                              disabled={isWorking}
                              role="option"
                              aria-selected={active}
                            >
                              <span>
                                <strong>{option.modelName}</strong>
                                <small>{option.providerName}{option.variant ? ` · ${option.variant}` : ""}</small>
                              </span>
                              {option.isDefault && <em>{t('detail.modelDefault')}</em>}
                            </button>
                          )
                        })
                      ) : (
                        <p className="subtle model-empty">{t('detail.modelSearchEmpty')}</p>
                      )}
                    </div>
                    {activeModelOption && (
                      <div className="model-meta">
                        <span>{t('detail.modelProvider', { provider: activeModelOption.providerName })}</span>
                        <span>{t('detail.modelContext', { context: formatLimit(activeModelOption.contextLimit), output: formatLimit(activeModelOption.outputLimit) })}</span>
                        <span>{activeModelOption.tools ? t('detail.modelToolsYes') : t('detail.modelToolsNo')}</span>
                        {activeModelOption.variant && <span>{t('detail.modelVariant', { variant: activeModelOption.variant })}</span>}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="subtle">{modelLoadError ? t('detail.modelLoadError', { message: modelLoadError }) : t('detail.modelLoading')}</p>
                )}
              </div>
            )}

            {activeDetailSheet === "details" && (
              <div className="sheet-content project-dashboard single-column">
                <div className="dashboard-card">
                  <span className="dashboard-label">{t('detail.projectLabel')}</span>
                  <strong>{projectName || selectedSession.directory}</strong>
                  <small>{projectPath || selectedSession.directory}</small>
                </div>
                <div className="dashboard-card">
                  <span className="dashboard-label">{t('detail.vcsLabel')}</span>
                  <strong>{vcsBranch || t('detail.unavailable')}</strong>
                  {projectDashboard?.vcs && (
                    <small>{t('detail.aheadBehind', { ahead: projectDashboard.vcs.ahead ?? 0, behind: projectDashboard.vcs.behind ?? 0 })}</small>
                  )}
                </div>
                <div className="dashboard-card">
                  <span className="dashboard-label">{t('detail.fileStatusLabel')}</span>
                  <strong>{diffFiles.length > 0 ? t('detail.filesCount', { count: diffFiles.length }) : (projectDashboard?.files.length ?? 0)}</strong>
                  {diffFiles.length > 0 ? (
                    <small><span className="positive">+{totalDiffAdditions}</span> <span className="negative">-{totalDiffDeletions}</span></small>
                  ) : (
                    <small>{dashboardError ? t('detail.dashboardError', { message: dashboardError }) : t('detail.fileStatusSource')}</small>
                  )}
                </div>
                <div className="dashboard-card">
                  <span className="dashboard-label">{t('detail.agentTitle')}</span>
                  <strong>{agentLabel(activeAgent ?? { id: activeAgentID, name: activeAgentID, mode: "primary" })}</strong>
                  <small>{t('detail.agentMode', { mode: activeAgent?.mode ?? 'primary' })}</small>
                </div>
                <div className="dashboard-card">
                  <span className="dashboard-label">{t('detail.modelTitle')}</span>
                  <strong>{activeModelOption?.modelName ?? t('detail.modelLoading')}</strong>
                  <small>{activeModelOption?.providerName ?? "-"}</small>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {sessionToDelete && (
        <div className="modal-backdrop" role="presentation" onClick={() => setSessionToDelete(null)}>
          <section
            className="modal-card fade-in"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-session-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="delete-session-title">{t('session.deleteTitle')}</h2>
            <p>
              {t('session.deleteBodyPrefix')} <strong>{sessionToDelete.title}</strong>.
            </p>
            <p className="subtle">{sessionToDelete.directory}</p>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setSessionToDelete(null)}>
                {t('session.cancel')}
              </button>
              <button className="btn-danger" onClick={() => deleteSession(sessionToDelete.id)}>
                <TrashIcon size={16} />
                {t('session.deleteConfirm')}
              </button>
            </div>
          </section>
        </div>
      )}

      {view === "help" && (
        <section className="panel help fade-in">
          <h2>
            <HelpIcon size={24} className="icon-inline-heading" />
            {t('help.title')}
          </h2>
          <div className="help-tabs" role="tablist">
            <button 
              className={helpPage === "overview" ? "active" : ""} 
              onClick={() => setHelpPage("overview")}
              role="tab"
              aria-selected={helpPage === "overview"}
            >
              {t('help.overview')}
            </button>
            <button 
              className={helpPage === "server" ? "active" : ""} 
              onClick={() => setHelpPage("server")}
              role="tab"
              aria-selected={helpPage === "server"}
            >
              {t('help.server')}
            </button>
            <button 
              className={helpPage === "network" ? "active" : ""} 
              onClick={() => setHelpPage("network")}
              role="tab"
              aria-selected={helpPage === "network"}
            >
              {t('help.network')}
            </button>
            <button 
              className={helpPage === "troubleshooting" ? "active" : ""} 
              onClick={() => setHelpPage("troubleshooting")}
              role="tab"
              aria-selected={helpPage === "troubleshooting"}
            >
              {t('help.troubleshooting')}
            </button>
            <button 
              className={helpPage === "commands" ? "active" : ""} 
              onClick={() => { setCommandFilter("all"); setHelpPage("commands") }}
              role="tab"
              aria-selected={helpPage === "commands"}
            >
              {t('help.commands')}
            </button>
          </div>

          {helpPage === "overview" && (
            <div className="help-content fade-in">
              <h3>Getting Started</h3>
              <ul>
                <li><strong>Configure Server:</strong> Use Settings to enter host, port, username and password</li>
                <li><strong>Test Connection:</strong> Press Test to validate server connectivity</li>
                <li><strong>Configuration:</strong> Changes are saved automatically and applied after you pause typing.</li>
                <li><strong>Browse Sessions:</strong> View and manage sessions from the Sessions tab</li>
                <li><strong>Interact:</strong> Open a session and chat in the Detail view</li>
                <li><strong>Quick Input:</strong> Press Enter to send, Shift+Enter for new lines</li>
                <li><strong>Slash Commands:</strong> Text starting with <code>/</code> is sent as a command</li>
              </ul>
              
              <h3>Key Features</h3>
              <ul>
                <li>🔄 Real-time session monitoring</li>
                <li>💬 Interactive chat interface</li>
                <li>📋 Todo tracking display</li>
                <li>⚡ Instant session control</li>
                <li>🔔 Completion notifications</li>
              </ul>
            </div>
          )}

          {helpPage === "server" && (
            <div className="help-content fade-in">
              <h3>{isBridgeBackend(config.backend) ? `${backendDisplayName(config.backend)} bridge` : "OpenCode server"}</h3>
              <p>
                This page keeps setup brief. Full, versioned backend guides live in the Harness Remote repository so new
                backends do not make the app help unwieldy.
              </p>
              <div className="code-blocks">
                {config.backend === "omp" ? (
                  <>
                    <h4>OMP bridge (macOS / Linux)</h4>
                    <pre>npx --yes ./bridge --backend omp --host 0.0.0.0 --port 4097 --username omp --password your-password --root "$PWD"</pre>
                  </>
                ) : config.backend === "pi" ? (
                  <>
                    <h4>PI bridge (macOS / Linux)</h4>
                    <pre>npx --yes ./bridge --backend pi --host 0.0.0.0 --port 4097 --username pi --password your-password --root "$PWD"</pre>
                  </>
                ) : (
                  <>
                    <h4>OpenCode server (macOS / Linux)</h4>
                    <pre>OPENCODE_SERVER_USERNAME=opencode OPENCODE_SERVER_PASSWORD=your-password npx -y opencode-ai serve --hostname 0.0.0.0 --port 4096</pre>
                  </>
                )}
              </div>
              <p>
                <a
                  href={`https://github.com/giuliastro/harness-remote#${config.backend === "opencode" ? "opencode-server-setup" : config.backend === "pi" ? "pi-bridge-setup" : "oh-my-pi-bridge-setup"}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open the complete {isBridgeBackend(config.backend) ? `${backendDisplayName(config.backend)} bridge` : "OpenCode server"} guide in the repository
                </a>
              </p>
            </div>
          )}

          {helpPage === "network" && (
            <div className="help-content fade-in">
              <h3>Network Configuration</h3>
              
              <div className="network-modes">
                <h4>🌐 LAN Mode (Recommended)</h4>
                <p>Use your PC's local IP address for devices on the same network:</p>
                <pre>Example: 192.168.1.61</pre>
                
                <h4>🌍 WAN Mode (Advanced)</h4>
                <ul>
                  <li>Configure NAT/port forwarding on your router</li>
                  <li>Set up a VPN for secure remote access</li>
                  <li>Use a reverse proxy with TLS/HTTPS</li>
                </ul>
              </div>
              
              <div className="security-checklist">
                <h4>🔒 Security Requirements</h4>
                <ul>
                  <li>✅ Open TCP port 4096 in OS firewall</li>
                  <li>✅ Configure router/NAT port forwarding</li>
                  <li>✅ Use strong authentication passwords</li>
                  <li>✅ Prefer TLS/HTTPS for external access</li>
                  <li>✅ Restrict source IPs when possible</li>
                  <li>⚠️ Never expose without authentication</li>
                </ul>
              </div>
            </div>
          )}

          {helpPage === "troubleshooting" && (
            <div className="help-content fade-in">
              <h3>Troubleshooting Guide</h3>
              
              <div className="troubleshooting-steps">
                <h4>🔍 Connection Diagnostics</h4>
                <ol>
                  <li><strong>Verify Server:</strong> Check if OpenCode is listening on port 4096</li>
                  <li><strong>Test Locally:</strong> Check health endpoint from the same machine</li>
                  <li><strong>Test Network:</strong> Check health endpoint from your phone browser</li>
                  <li><strong>Check Firewall:</strong> Ensure port 4096 is open in OS firewall</li>
                </ol>
              </div>
              
              <div className="health-checks">
                <h4>🩺 Health Check Commands</h4>
                <div className="code-examples">
                  <h5>Local Machine:</h5>
                  <pre>curl -u opencode:your-password \
http://127.0.0.1:4096/global/health</pre>
                  
                  <h5>From Phone/Network:</h5>
                  <pre>curl -u opencode:your-password \
http://YOUR_PC_IP:4096/global/health</pre>
                </div>
              </div>
              
              <div className="common-issues">
                <h4>⚠️ Common Issues</h4>
                <ul>
                  <li><strong>CORS Errors:</strong> Add <code>--cors</code> flags to server</li>
                  <li><strong>Connection Timeout:</strong> Check firewall settings</li>
                  <li><strong>Auth Failures:</strong> Verify username/password</li>
                  <li><strong>Session Issues:</strong> Re-open session and check server models</li>
                </ul>
              </div>
            </div>
          )}

          {helpPage === "commands" && (
            <div className="help-content fade-in">
              <h3>Slash Commands</h3>
              <p>Local mobile commands are handled by the app. Server commands are loaded from OpenCode and sent to <code>/session/:id/command</code>.</p>
              <div className="example-commands">
                <pre>/help</pre>
                <pre>/commands</pre>
                <pre>/skills</pre>
                <pre>/status</pre>
              </div>
              <div className="help-tabs compact" role="tablist">
                <button
                  className={commandFilter === "all" ? "active" : ""}
                  onClick={() => setCommandFilter("all")}
                  role="tab"
                  aria-selected={commandFilter === "all"}
                >
                  Server Commands
                </button>
                <button
                  className={commandFilter === "skill" ? "active" : ""}
                  onClick={() => setCommandFilter("skill")}
                  role="tab"
                  aria-selected={commandFilter === "skill"}
                >
                  Skills
                </button>
              </div>
               
              {displayedCommands.length === 0 ? (
                <div className="no-commands">
                  <HelpIcon size={48} className="icon-empty-state" />
                  <p className="subtle">No {commandFilter === "skill" ? "skills" : "server commands"} available</p>
                  <p className="subtle">Connect to a server to see available commands and skills</p>
                </div>
              ) : (
                <div className="commands-grid">
                  {displayedCommands.map((cmd) => (
                    <div key={cmd.name} className="command-card">
                      <code className="command-name">/{cmd.name}</code>
                      {cmd.description && (
                        <p className="command-description">{cmd.description}</p>
                      )}
                      {cmd.source && <p className="subtle">{cmd.source}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {runtimeError && <p className="error">{runtimeError}</p>}
        </section>
      )}

      <nav className="bottom-nav" role="navigation" aria-label="Mobile navigation">
        {navItems.map((item) => (
          <button
            key={item.view}
            className={view === item.view ? "active" : ""}
            onClick={() => {
              setView(item.view);
              if (item.view === "sessions") {
                requestAnimationFrame(() => document.querySelector<HTMLElement>(".session-card.active")?.scrollIntoView({ block: "center" }));
              }
            }}
            disabled={item.disabled}
            aria-label={item.label}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}

export default App
