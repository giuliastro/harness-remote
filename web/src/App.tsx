import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { App as CapacitorApp } from "@capacitor/app"
import { Capacitor, type PluginListenerHandle } from "@capacitor/core"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { api, isValidServerConfig } from "./api"
import {
  createDesktopOpenCodeEventSubscription,
  desktopProfileID,
  isAndroidPlatform,
  isDesktopPlatform,
  notifyDesktopCompletion,
  desktopUsesNativeMenu,
  setDesktopApplicationMenu,
  subscribeDesktopMenuCommands,
  syncDesktopProfiles
} from "./desktopBridge"
import {
  createFetchOpenCodeEventSubscription,
  createNativeOpenCodeEventSubscription,
  eventPayload,
  eventType,
  isNativeEventTransport,
  type EventStreamStatus
} from "./opencode-events"
import { createTranslator, languageOptions, normalizeLanguage, type LanguageCode } from "./i18n"
import { stripMarkdownDirectives } from "./markdownDirectives"
import { DEFAULT_HARNESS_CAPABILITIES } from "./backendCapabilities"
import { BACKEND_CLIENTS } from "./backendClient"
import { copyToClipboard } from "./clipboard"
import { backendDisplayName, isBridgeBackend } from "./backendSetup"
import { ATTACHMENT_MAX_COUNT, fileToAttachment, type AttachmentPart } from "./attachments"
import { CommandPalette, MenuBar, ServerSwitcher, type MenuDefinition, type MenuEntry, type PaletteCommand } from "./components/shell"
import { ConnectServerWizard, NewSessionDialog } from "./components/panels"
import { createServerProfile, loadActiveServerProfile, loadServerProfiles, persistServerProfiles, type SavedServerProfile } from "./serverProfiles"
import type { DesktopMenuCommand, DesktopMenuTemplate } from "../electron/ipc-contract"
import type { AgentOption, CommandInfo, DiffFile, FileEntry, FileStatusEntry, HarnessAction, HarnessCapabilities, MessageEnvelope, MessagePart, ModelOption, ModelSelection, PathInfo, PermissionRequest, ProjectDashboard, QuestionInfo, QuestionRequest, ServerConfig, Session, SessionStatus, SessionView, TodoItem } from "./types"
import {
  SettingsIcon,
  PaperclipIcon,
  ArrowLeftIcon,
  FolderIcon,
  ChatIcon,
  CommandIcon,
  JumpToTopIcon,
  JumpToBottomIcon,
  HelpIcon,
  PanelRightIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  TrashIcon,
  StopCircleIcon,
  SendIcon,
  SaveIcon,
  TestIcon,
  LoadingIcon,
  RefreshIcon,
  OfflineIcon,
  PencilIcon,
  CloseIcon,
  MoreVerticalIcon
} from "./Icons"

const REMARK_PLUGINS = [remarkGfm]

const LANGUAGE_STORAGE_KEY = "opencode.remote.language"
const MODEL_STORAGE_KEY = "opencode.remote.model"
const AGENT_STORAGE_KEY = "opencode.remote.agent"
const THEME_STORAGE_KEY = "opencode.remote.theme"
// Each wider sidebar baseline gets its own preference version so installations that persisted the
// previous, cramped default receive the new baseline once, while every subsequent manual resize
// sticks. Bump the key only when the baseline itself changes, never for a drag-once tweak.
const SIDEBAR_WIDTH_STORAGE_KEY = "opencode.remote.desktopSidebarWidth.v4"
const INSPECTOR_WIDTH_STORAGE_KEY = "opencode.remote.desktopInspectorWidth"
const INSPECTOR_OPEN_STORAGE_KEY = "opencode.remote.desktopInspectorOpen"
const NEW_SESSION_DIRECTORY_STORAGE_KEY = "opencode.remote.newSessionDirectory"

type Translator = ReturnType<typeof createTranslator>

/** One pixel past the stylesheet's `@media (max-width: 780px)` block, so the JS layout switches on
 *  exactly the width the CSS does. Named because the Help page quotes the number back to the user. */
const DESKTOP_MIN_WIDTH = 781
const DESKTOP_MEDIA_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH}px)`

const SIDEBAR_WIDTH_MIN = 220
const SIDEBAR_WIDTH_MAX = 960
const SIDEBAR_WIDTH_DEFAULT = 320
/** Full-screen desktop windows get the sidebar doubled from the previous wide baseline: a session
 *  list is the main workspace there, not a thin rail, and the extra width keeps row actions usable. */
const SIDEBAR_WIDTH_WIDE_DEFAULT = 768
const WIDE_DESKTOP_MIN_WIDTH = 1600
const INSPECTOR_WIDTH_MIN = 260
const INSPECTOR_WIDTH_MAX = 480
const INSPECTOR_WIDTH_DEFAULT = 320
/** The narrowest the main pane may be squeezed to before a side panel has to stop growing. */
const MAIN_WIDTH_MIN = 420
/** Below this the inspector is folded away automatically: three panes in less room than this turns
 *  the conversation into a gutter, and the same content is one click away in the context chips. */
const INSPECTOR_MIN_WINDOW_WIDTH = 1180

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** The widest a side panel may be dragged: its own maximum, or less on a window too narrow to give
 *  the main pane its floor as well. `otherPanel` is whatever the opposite edge is already using. */
function maxPanelWidth(max: number, min: number, otherPanel: number): number {
  return Math.max(min, Math.min(max, window.innerWidth - MAIN_WIDTH_MIN - otherPanel))
}

function maxSidebarWidth(otherPanel = 0): number {
  return maxPanelWidth(SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, otherPanel)
}

function maxInspectorWidth(otherPanel = 0): number {
  return maxPanelWidth(INSPECTOR_WIDTH_MAX, INSPECTOR_WIDTH_MIN, otherPanel)
}

function defaultSidebarWidth(): number {
  return window.innerWidth >= WIDE_DESKTOP_MIN_WIDTH ? SIDEBAR_WIDTH_WIDE_DEFAULT : SIDEBAR_WIDTH_DEFAULT
}

/** "Ctrl" everywhere except macOS, which reads ⌘ — the palette hint and every menu accelerator has
 *  to say the one the user's keyboard actually has. */
const IS_APPLE = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Touch-primary devices have no Shift key on the soft keyboard, so the composer's
 *  "Enter sends, Shift+Enter for a new line" model must flip there: Enter inserts a new line,
 *  Ctrl/Cmd+Enter sends, and the send button covers soft-keyboard-only devices. Desktop and
 *  any device with a fine pointer (including hybrid laptops whose primary pointer is a mouse)
 *  keep the physical-keyboard behaviour untouched. */
const SOFT_KEYBOARD_DEVICE =
  isAndroidPlatform(Capacitor.getPlatform()) ||
  (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches)

function shortcut(key: string): string {
  return IS_APPLE ? `⌘${key}` : `Ctrl+${key}`
}

/**
 * One place binding a command to a key. Three consumers read from it and previously each spelled the
 * binding out for itself: the label shown in menus and the palette, the accelerator the platform
 * menu registers, and the in-app keydown handler. Keeping them derived is what stops a menu from
 * advertising a shortcut the handler does not implement — and it is what fixes "Ctrl+N+Shift",
 * which was written by hand in the wrong order.
 */
const KEY_BINDINGS: Record<string, { key: string; shift?: boolean; desktopOnly?: boolean }> = {
  "view.palette": { key: "k" },
  "session.new": { key: "n" },
  "server.add": { key: "n", shift: true },
  // Reload and find-in-page belong to the browser, and a page that takes them is a page that
  // misbehaves: the user loses the two keys they reach for when something looks stuck. The packaged
  // app has no such owner for them, so there they are ours.
  "focus.search": { key: "f", desktopOnly: true },
  "session.refresh": { key: "r", desktopOnly: true },
  "server.settings": { key: "," },
  "view.inspector": { key: "b" }
}

/** Whether a binding applies here. Fixed for the life of the process: it is a property of the
 *  build, not of the window, so nothing has to react to it changing. */
function bindingApplies(binding: { desktopOnly?: boolean }): boolean {
  return !binding.desktopOnly || isDesktopPlatform()
}

function bindingKeyLabel(binding: { key: string }): string {
  return binding.key.length === 1 && /[a-z]/.test(binding.key) ? binding.key.toUpperCase() : binding.key
}

function displayShortcut(command: string): string | undefined {
  const binding = KEY_BINDINGS[command]
  // A shortcut the build does not bind must not be advertised either: a menu promising Ctrl+F while
  // the browser keeps find-in-page is worse than a menu item with no shortcut at all.
  if (!binding || !bindingApplies(binding)) return undefined
  const shift = binding.shift ? (IS_APPLE ? "⇧" : "Shift+") : ""
  return IS_APPLE ? `⌘${shift}${bindingKeyLabel(binding)}` : `Ctrl+${shift}${bindingKeyLabel(binding)}`
}

/** Electron's own accelerator grammar, which is neither the label nor the DOM key name. */
function electronAccelerator(command: string): string | undefined {
  const binding = KEY_BINDINGS[command]
  if (!binding) return undefined
  return `CmdOrCtrl+${binding.shift ? "Shift+" : ""}${bindingKeyLabel(binding)}`
}

/** The command a keystroke means, or null. Shared by the in-app handler so it can never disagree
 *  with what the menus say. */
function commandForKeyEvent(event: KeyboardEvent): string | null {
  const key = event.key.toLowerCase()
  for (const [command, binding] of Object.entries(KEY_BINDINGS)) {
    if (!bindingApplies(binding)) continue
    if (binding.key === key && Boolean(binding.shift) === event.shiftKey) return command
  }
  return null
}

function readStoredWidth(key: string, fallback: number, min: number, max: number): number {
  const raw = Number(localStorage.getItem(key))
  return Number.isFinite(raw) && raw > 0 ? clamp(raw, min, max) : fallback
}

/** Drags a horizontal panel border: reports the pointer's horizontal movement since the previous
 *  event (not since drag start), so callers can just add/subtract the delta from their own state
 *  without tracking a separate drag-start snapshot. */
function useHorizontalDrag(onDeltaX: (deltaX: number) => void): (event: React.PointerEvent) => void {
  return useCallback((event: React.PointerEvent) => {
    event.preventDefault()
    let lastX = event.clientX
    const onMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - lastX
      lastX = moveEvent.clientX
      if (deltaX !== 0) onDeltaX(deltaX)
    }
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }, [onDeltaX])
}

function isSessionWorking(status: string): boolean {
  return status === "busy" || status === "retry" || status === "waiting"
}

/**
 * A session card showed the whole absolute path, which on a phone wrapped to three lines and
 * took a third of the card. The last segments are what identifies a project; the full path stays
 * in the title attribute and in the session detail.
 */
function shortDirectory(directory: string): string {
  const segments = directory.split(/[\\/]+/).filter(Boolean)
  if (segments.length <= 2) return directory
  return `…/${segments.slice(-2).join("/")}`
}

/** The last path segment, which is what a developer calls the project — the sidebar groups rows by
 *  it rather than by the full absolute path nobody reads. */
function projectLabel(directory: string): string {
  const segments = directory.split(/[\\/]+/).filter(Boolean)
  return segments[segments.length - 1] || directory
}

function formatTime(epoch: number): string {
  if (!epoch) return "-"
  return new Date(epoch).toLocaleString()
}

const RELATIVE_TIME_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["week", 60 * 60 * 24 * 7],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60]
]

/** Compact, locale-translated "13 min ago" / "13 minuti fa" style string — falls back to
 *  "just now" (via the 0-second `second` bucket) rather than "-1 minutes ago" for very recent times. */
function formatRelativeTime(epoch: number, locale: LanguageCode): string {
  if (!epoch) return "-"
  const deltaSeconds = Math.round((epoch - Date.now()) / 1000)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" })
  for (const [unit, secondsInUnit] of RELATIVE_TIME_UNITS) {
    if (Math.abs(deltaSeconds) >= secondsInUnit) {
      return formatter.format(Math.round(deltaSeconds / secondsInUnit), unit)
    }
  }
  return formatter.format(deltaSeconds, "second")
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

function messagesHaveSameContent(left: MessageEnvelope[], right: MessageEnvelope[]): boolean {
  return left.length === right.length && left.every((message, index) => {
    const candidate = right[index]
    return candidate?.info.role === message.info.role && extractText(candidate) === extractText(message)
  })
}

/**
 * Polling refetches the whole set of side lists every few seconds, and handing React a fresh array
 * each time is a state change even when the contents are identical. That re-rendered the transcript
 * — re-parsing every message's markdown — six times per poll for data nobody had changed, which is
 * what made a busy chat lock the app up for seconds on a phone. These lists are short, so comparing
 * them is far cheaper than the render it avoids.
 */
function keepIfUnchanged<T>(previous: T[], next: T[]): T[] {
  if (previous === next) return previous
  if (previous.length !== next.length) return next
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next
}

function messagesExtendContent(current: MessageEnvelope[], next: MessageEnvelope[]): boolean {
  if (next.length < current.length) return false
  return current.every((message, index) => {
    const candidate = next[index]
    return candidate?.info.role === message.info.role && extractText(candidate).startsWith(extractText(message))
  })
}

function normalizeMessageMarkdown(text: string): string {
  const stripped = stripMarkdownDirectives(text)
  return stripped.includes("\n") ? stripped : stripped.replace(/\s-\s(?=\S)/g, "\n- ")
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

function QuestionListView({ questions, answers }: { questions: QuestionInfo[]; answers?: string[][] }) {
  return (
    <div className="question-options">
      {questions.map((question, index) => {
        const chosen = answers?.[index] ?? []
        const customAnswer = chosen.find((value) => !question.options.some((option) => option.label === value))
        return (
          <div key={index} className="question-block">
            <div className="question-header">{question.header}</div>
            <p className="question-text">{question.question}</p>
            {question.options.length > 0 && (
              <div className="question-options">
                {question.options.map((option) => (
                  <div
                    key={option.label}
                    className={`question-option static ${chosen.includes(option.label) ? "selected" : ""}`}
                  >
                    <span className="question-option-label">{option.label}</span>
                    {option.description && <span className="question-option-description">{option.description}</span>}
                  </div>
                ))}
              </div>
            )}
            {customAnswer && (
              <div className="question-option static selected">
                <span className="question-option-label">{customAnswer}</span>
              </div>
            )}
          </div>
        )
      })}
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

/** How far from an end a list must be scrolled before its jump button appears, at most. */
const JUMP_AFFORDANCE_MAX_THRESHOLD = 320
/** Below this much total travel, jumping saves nobody a scroll and the buttons are pure clutter. */
const JUMP_AFFORDANCE_MIN_RANGE = 240

type JumpAffordances = { top: boolean; bottom: boolean }
type ScrollMetrics = { fromTop: number; fromBottom: number }

const NO_JUMP_AFFORDANCES: JumpAffordances = { top: false, bottom: false }

/** Which jump buttons are worth showing at this scroll position.
 *
 *  The threshold has to scale with the total scroll range rather than being a flat 320px. Measured
 *  absolutely, a list that only scrolls ~600px has no position where both ends are more than 320px
 *  away, and its jump-to-top only appears in the last 320px of travel — which reads as "the buttons
 *  only show up at the very bottom". Anything scrolling less than 320px got no buttons at all. */
function jumpAffordancesFor({ fromTop, fromBottom }: ScrollMetrics): JumpAffordances {
  const range = fromTop + fromBottom
  if (range < JUMP_AFFORDANCE_MIN_RANGE) return NO_JUMP_AFFORDANCES
  const threshold = Math.min(JUMP_AFFORDANCE_MAX_THRESHOLD, range * 0.25)
  return { top: fromTop > threshold, bottom: fromBottom > threshold }
}

function windowScrollMetrics(): ScrollMetrics {
  const doc = document.documentElement
  return { fromTop: window.scrollY, fromBottom: doc.scrollHeight - window.scrollY - window.innerHeight }
}

function elementScrollMetrics(element: HTMLElement | null): ScrollMetrics {
  if (!element) return { fromTop: 0, fromBottom: 0 }
  return {
    fromTop: element.scrollTop,
    fromBottom: element.scrollHeight - element.scrollTop - element.clientHeight
  }
}

/** True when the element is a real scroller rather than one that grows to fit its content. Geometry
 *  alone is not enough: scrollHeight also exceeds clientHeight on an overflow: visible element whose
 *  content spills, which is exactly what the mobile message list is, and treating that as a scroller
 *  reads a scrollTop that is permanently 0. */
function scrollsItself(element: HTMLElement | null): element is HTMLElement {
  if (!element || element.scrollHeight <= element.clientHeight + 1) return false
  const overflowY = window.getComputedStyle(element).overflowY
  return overflowY === "auto" || overflowY === "scroll"
}

/** Watches how far a list sits from each end and reports which jump buttons are worth showing.
 *  `getMetrics` is injected because the scroller varies: the chat scrolls its own pane in the
 *  desktop layout, while every mobile list lets the page scroll instead. Returns a `refresh` to
 *  call from an element's own onScroll and whenever content changes the distances without a
 *  scroll event. */
function useJumpAffordances(active: boolean, getMetrics: () => ScrollMetrics): [JumpAffordances, () => void] {
  const [affordances, setAffordances] = useState<JumpAffordances>(NO_JUMP_AFFORDANCES)
  const getMetricsRef = useRef(getMetrics)
  getMetricsRef.current = getMetrics

  const refresh = useCallback(() => {
    const next = jumpAffordancesFor(getMetricsRef.current())
    setAffordances((current) => (current.top === next.top && current.bottom === next.bottom ? current : next))
  }, [])

  useEffect(() => {
    if (!active) {
      setAffordances(NO_JUMP_AFFORDANCES)
      return
    }
    window.addEventListener("scroll", refresh, { passive: true })
    window.addEventListener("resize", refresh)
    // Layout settles a frame after the view mounts, so the first read has to wait for it.
    const frame = requestAnimationFrame(refresh)
    return () => {
      window.removeEventListener("scroll", refresh)
      window.removeEventListener("resize", refresh)
      cancelAnimationFrame(frame)
    }
  }, [active, refresh])

  return [affordances, refresh]
}

/** Floating jump-to-top/bottom buttons for a long list. */
function JumpControls({
  affordances,
  onJumpToTop,
  onJumpToBottom,
  variant = "chat",
  t
}: {
  affordances: JumpAffordances
  onJumpToTop: () => void
  onJumpToBottom: () => void
  /** "chat" clears the composer, "page" the bottom nav, "sidebar" the desktop sidebar footer. */
  variant?: "chat" | "page" | "sidebar"
  t: Translator
}) {
  if (!affordances.top && !affordances.bottom) return null
  return (
    <div className={`jump-controls jump-controls--${variant}`}>
      {affordances.top && (
        <button
          type="button"
          className="jump-button fade-in"
          onClick={onJumpToTop}
          title={t('app.jumpToTop')}
          aria-label={t('app.jumpToTop')}
        >
          <JumpToTopIcon size={18} />
        </button>
      )}
      {affordances.bottom && (
        <button
          type="button"
          className="jump-button fade-in"
          onClick={onJumpToBottom}
          title={t('app.jumpToBottom')}
          aria-label={t('app.jumpToBottom')}
        >
          <JumpToBottomIcon size={18} />
        </button>
      )}
    </div>
  )
}

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

/** Wraps children with `wrapper(children)` only when `condition` holds, otherwise renders children
 *  as-is. Lets a panel's body be written once and reused unmodified in both its mobile inline form
 *  and its desktop modal form. */
function ConditionalWrapper({
  condition,
  wrapper,
  children
}: {
  condition: boolean
  wrapper: (children: ReactNode) => ReactNode
  children: ReactNode
}) {
  return <>{condition ? wrapper(children) : children}</>
}

/** Desktop-only modal shell for panels (settings, help) that already render their own heading —
 *  unlike Modal, it has no title bar of its own, just a close affordance, so the panel's existing
 *  content isn't duplicated under a second title. */
function DesktopModalOverlay({
  onClose,
  ariaLabel,
  children
}: {
  onClose: () => void
  ariaLabel: string
  children: ReactNode
}) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal-card desktop-panel-modal fade-in"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="btn-secondary desktop-modal-close" onClick={onClose} aria-label={ariaLabel}>
          <CloseIcon size={16} />
        </button>
        {children}
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
    if (!multiple) {
      setCustomValues((current) => {
        const next = [...current]
        next[questionIndex] = ""
        return next
      })
    }
  }

  function setCustomValue(questionIndex: number, value: string, multiple: boolean) {
    setCustomValues((current) => {
      const next = [...current]
      next[questionIndex] = value
      return next
    })
    if (!multiple && value) {
      setSelections((current) => {
        const next = [...current]
        next[questionIndex] = []
        return next
      })
    }
  }

  const canSubmit = request.questions.every((question, index) => {
    return selections[index].length > 0 || (question.custom !== false && customValues[index].trim().length > 0)
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
          {question.custom !== false && (
            <input
              type="text"
              className="question-custom-input"
              placeholder={t('question.otherPlaceholder')}
              value={customValues[index]}
              onChange={(event) => setCustomValue(index, event.target.value, Boolean(question.multiple))}
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

function PermissionCard({
  config,
  directory,
  request,
  onResolved,
  t
}: {
  config: ServerConfig
  directory: string
  request: PermissionRequest
  onResolved: (id: string) => void
  t: Translator
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function reply(response: "once" | "always" | "reject") {
    setSubmitting(true)
    setError(null)
    try {
      await api.replyPermission(config, request.id, response, directory)
      onResolved(request.id)
    } catch (err) {
      setError((err as Error).message)
      setSubmitting(false)
    }
  }

  return (
    <article className="message assistant question-card fade-in" aria-label={t('permission.ariaLabel')}>
      <div className="question-block">
        <div className="question-header">{t('permission.requested', { permission: request.permission })}</div>
        <div className="question-options">
          {request.patterns.map((pattern) => <code key={pattern}>{pattern}</code>)}
        </div>
      </div>
      {error && <p className="question-error">{error}</p>}
      <div className="question-actions">
        <button type="button" className="btn-danger" onClick={() => void reply("reject")} disabled={submitting}>
          {t('permission.deny')}
        </button>
        <button type="button" className="btn-secondary" onClick={() => void reply("once")} disabled={submitting}>
          {t('permission.allowOnce')}
        </button>
        {request.always.length > 0 && (
          <button type="button" className="btn-primary" onClick={() => void reply("always")} disabled={submitting}>
            {t('permission.allowAlways')}
          </button>
        )}
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
  const isPreparing = (status === "pending" || status === "running") && Object.keys(input).length === 0
  const displayLabel = isPreparing ? t('action.preparingTool', { tool: part.tool || t('action.actionsFallback') }) : label
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
        <span className="message-tool-label">{displayLabel}</span>
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
        <Modal title={truncateForTitle(displayLabel)} timestamp={timestamp} onClose={() => setOpen(false)} t={t}>
          {todos ? (
            <TodoListView items={todos} />
          ) : questions ? (
            <QuestionListView questions={questions} answers={part.state?.metadata?.answers} />
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

  if (part.type === "file") {
    if (!part.url) return null
    return (
      <div className="message-content">
        <img className="message-attachment" src={part.url} alt={part.filename || t('detail.attachedImage')} />
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
    model: session.model ? { providerID: session.model.providerID, modelID: session.model.id, variant: session.model.variant } : undefined,
    revertMessageID: session.revert?.messageID,
    external: session.external
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

/** Streamed text should only ever grow — if an incoming snapshot is shorter than what's already shown, a
 *  reset/truncated event landed; keep the longer text instead of visibly erasing it. Applied per part rather
 *  than by rejecting the whole snapshot, so a lean refetch can still deliver the messages that came with it. */
function reconcileStreamedPart(previous: MessagePart | undefined, incoming: MessagePart): MessagePart {
  if (!previous || previous.type !== incoming.type) return incoming
  if (incoming.type !== "reasoning" && incoming.type !== "text") return incoming
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
    const parts = message.parts.map((part) => reconcileStreamedPart(previousPartsByID.get(part.id), part))
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
      ? message.parts.map((existing) => (existing.id === part.id ? reconcileStreamedPart(existing, part) : existing))
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

type MessageMenuAction = {
  id: string
  label: string
  onSelect: () => void
}

/** A ⋯ control in the conversation header exposing session-level actions from the connected
 *  harness/extension (currently Undo/Redo). The message context menu only reaches those actions
 *  when a bubble exists to host it — an Undo that empties the transcript leaves Redo enabled but
 *  unreachable, so the header menu is the interaction surface that never depends on transcript
 *  contents. Availability still comes from the harness via the caller. */
function SessionActionsMenu({
  actions,
  t
}: {
  actions: MessageMenuAction[]
  t: Translator
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    const dismissOnResize = () => setOpen(false)
    window.addEventListener("pointerdown", dismiss)
    window.addEventListener("keydown", dismissOnEscape)
    window.addEventListener("resize", dismissOnResize)
    return () => {
      window.removeEventListener("pointerdown", dismiss)
      window.removeEventListener("keydown", dismissOnEscape)
      window.removeEventListener("resize", dismissOnResize)
    }
  }, [open])

  return (
    <div className="session-actions" ref={menuRef}>
      <button
        type="button"
        className="btn-icon session-actions-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('detail.sessionActions')}
        title={t('detail.sessionActions')}
      >
        <MoreVerticalIcon size={20} />
      </button>
      {open && (
        <div className="session-actions-menu" role="menu">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                action.onSelect()
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Wraps a bubble in the copy menu. Takes the text to copy rather than a message, because what a
 *  bubble shows is not always one message's text: a run merges several, and some carry none at all. */
function MessageContextMenu({
  text,
  className,
  t,
  actions = [],
  children
}: {
  text: string
  className: string
  t: Translator
  actions?: MessageMenuAction[]
  children: ReactNode
}) {
  const [position, setPosition] = useState<{ x: number, y: number, touch: boolean } | null>(null)
  const longPressTimer = useRef<number | undefined>(undefined)
  const touchStart = useRef<{ x: number, y: number } | null>(null)
  const cancelLongPress = () => {
    if (longPressTimer.current !== undefined) window.clearTimeout(longPressTimer.current)
    longPressTimer.current = undefined
    touchStart.current = null
  }
  const open = (x: number, y: number, touch = false) => {
    cancelLongPress()
    const itemCount = actions.length + (text ? 2 : 0)
    setPosition({
      x: Math.max(8, Math.min(x, window.innerWidth - 220)),
      y: Math.max(8, Math.min(y, window.innerHeight - (40 * itemCount + 8))),
      touch
    })
  }
  const copy = (markdown: boolean) => {
    void copyToClipboard(markdown ? normalizeMessageMarkdown(text) : stripMarkdownDirectives(text))
    setPosition(null)
  }
  // Everything that means "not this" has to put the menu away: a press anywhere else, Escape, the
  // transcript scrolling out from under a fixed menu, a resize moving the coordinates it was pinned
  // to. Each bubble owns its own menu state, so without this a second right-click adds a second menu
  // instead of moving the first, and neither ever leaves until an item is chosen.
  useEffect(() => {
    if (!position) return
    const dismiss = () => setPosition(null)
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss()
    }
    window.addEventListener("pointerdown", dismiss)
    window.addEventListener("keydown", dismissOnEscape)
    window.addEventListener("resize", dismiss)
    // The transcript scrolls inside its own pane, and a scroll there never reaches window by itself.
    window.addEventListener("scroll", dismiss, true)
    return () => {
      window.removeEventListener("pointerdown", dismiss)
      window.removeEventListener("keydown", dismissOnEscape)
      window.removeEventListener("resize", dismiss)
      window.removeEventListener("scroll", dismiss, true)
    }
  }, [position])
  // A bubble made only of tool calls and thinking has no message text to hand over. Offering the menu
  // anyway gave two items that could do nothing, and taking over the context menu to show them also
  // took away the browser's own — with its Copy, the one thing that would have worked on a selection
  // the user made by hand. With nothing to copy, the bubble stays out of the way.
  if (!text && actions.length === 0) return <article className={className}>{children}</article>
  return (
    <article
      className={className}
      onContextMenu={(event) => {
        event.preventDefault()
        open(event.clientX, event.clientY, window.matchMedia("(pointer: coarse)").matches)
      }}
      onPointerDown={(event) => {
        if (event.pointerType !== "touch") return
        const { clientX, clientY } = event
        touchStart.current = { x: clientX, y: clientY }
        longPressTimer.current = window.setTimeout(() => open(clientX, clientY, true), 500)
      }}
      onPointerMove={(event) => {
        if (event.pointerType !== "touch" || !touchStart.current) return
        const movedX = event.clientX - touchStart.current.x
        const movedY = event.clientY - touchStart.current.y
        if (Math.hypot(movedX, movedY) > 10) cancelLongPress()
      }}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
    >
      {children}
      {position && (
        // Pressing an item must not read as pressing "anywhere else": the dismissal above would
        // unmount the menu on pointerdown and the click would never reach the button.
        <div
          className={`message-context-menu${position.touch ? " message-context-menu--touch" : ""}`}
          role="menu"
          style={position.touch ? undefined : { left: position.x, top: position.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {text && <button type="button" role="menuitem" onClick={() => copy(false)}>{t('detail.copyText')}</button>}
          {text && <button type="button" role="menuitem" onClick={() => copy(true)}>{t('detail.copyMarkdown')}</button>}
          {text && actions.length > 0 && <div className="message-context-menu__separator" role="separator" />}
          {actions.map((action) => (
            <button key={action.id} type="button" role="menuitem" onClick={() => {
              setPosition(null)
              action.onSelect()
            }}>{action.label}</button>
          ))}
        </div>
      )}
    </article>
  )
}

/** Renders one run's continuous timeline (see groupRenderedMessages) as a single message bubble, resolving
 *  each item's timestamp to the specific message that produced it. */
function ConversationRunView({
  items,
  messagesByID,
  sessionID,
  config,
  directory,
  actions,
  onRevertMessage,
  t
}: {
  items: TimelineItem[]
  messagesByID: Map<string, MessageEnvelope & { text: string }>
  sessionID: string
  config: ServerConfig
  directory: string | undefined
  actions: MessageMenuAction[]
  onRevertMessage: (messageID: string) => void
  t: Translator
}) {
  const fallback = [...messagesByID.values()].pop()
  const timestampFor = (part: MessagePart) => {
    const owner = (part.messageID && messagesByID.get(part.messageID)) || fallback
    return owner ? formatTime(owner.info.time.created) : undefined
  }
  // The bubble shows the whole run, so copying it means copying every message in it. Handing over the
  // last one copied a fraction of what is on screen, and nothing at all whenever the run happened to
  // end on a tool call — which is most of the time.
  const runText = [...messagesByID.values()].map((message) => message.text).filter(Boolean).join("\n\n")
  return (
    <MessageContextMenu
      text={runText}
      className="message assistant fade-in"
      t={t}
      actions={fallback ? [...actions, ...(config.backend === "opencode" ? [{ id: "revert", label: t('detail.revertToMessage'), onSelect: () => onRevertMessage(fallback.info.id) }] : [])] : actions}
    >
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
    </MessageContextMenu>
  )
}

/** One message's parts. Memoized on the message object identity so that streaming a token into one message
 *  (which necessarily re-renders MessagesPane) doesn't re-run timeline/diff formatting for every other message
 *  in the conversation — toRenderedMessage keeps unrelated messages referentially stable across updates. */
const MessageArticle = memo(function MessageArticle({
  message,
  config,
  directory,
  actions,
  onRevertMessage,
  t
}: {
  message: MessageEnvelope & { text: string }
  config: ServerConfig
  directory: string | undefined
  actions: MessageMenuAction[]
  onRevertMessage: (messageID: string) => void
  t: Translator
}) {
  return (
    <MessageContextMenu
      text={message.text}
      className={`message ${message.info.role} fade-in`}
      t={t}
      actions={[...actions, ...(config.backend === "opencode" ? [{ id: "revert", label: t('detail.revertToMessage'), onSelect: () => onRevertMessage(message.info.id) }] : [])]}
    >
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
    </MessageContextMenu>
  )
})

/** Renders the message list, pending questions, and typing bubble. Memoized so that unrelated state changes in
 *  the parent (most importantly typing into the composer) don't re-run the per-message formatting/diffing work
 *  on every keystroke. */
const MessagesPane = memo(function MessagesPane({
  loadingSessionID,
  loadedSessionID,
  loadFailure,
  onRetrySession,
  selectedID,
  renderedMessages,
  timelineGroups,
  showTypingBubble,
  pendingQuestions,
  pendingPermissions,
  config,
  directory,
  actions,
  onRevertMessage,
  t,
  messagesRef,
  messagesEndRef,
  onMessagesScroll,
  onQuestionResolved,
  onPermissionResolved,
  jumpAffordances,
  onJumpToTop,
  onJumpToBottom
}: {
  loadingSessionID: string | null
  loadedSessionID: string | null
  loadFailure: { sessionID: string; message: string } | null
  onRetrySession: () => void
  selectedID: string | null
  renderedMessages: (MessageEnvelope & { text: string })[]
  timelineGroups: RenderGroup[]
  showTypingBubble: boolean
  pendingQuestions: QuestionRequest[]
  pendingPermissions: PermissionRequest[]
  config: ServerConfig
  directory: string | undefined
  actions: MessageMenuAction[]
  onRevertMessage: (messageID: string) => void
  t: Translator
  messagesRef: RefObject<HTMLDivElement>
  messagesEndRef: RefObject<HTMLDivElement>
  onMessagesScroll: () => void
  onQuestionResolved: (id: string) => void
  onPermissionResolved: (id: string) => void
  jumpAffordances: { top: boolean; bottom: boolean }
  onJumpToTop: () => void
  onJumpToBottom: () => void
}) {
  return (
    <div className="messages-wrap">
      <div className="messages" ref={messagesRef} onScroll={onMessagesScroll}>
        {/* Nothing selected is its own state, not a load in progress. Both of the tests below compare
            against selectedID, so a null one used to satisfy them and left the desktop layout — which
            renders this pane with no session, unlike mobile — spinning "loading" forever. */}
        {selectedID === null ? (
          <div className="empty-state compact">
            <ChatIcon size={40} className="icon-empty-state" />
            <p>{t('detail.selectSession')}</p>
          </div>
        ) : loadFailure?.sessionID === selectedID && loadingSessionID !== selectedID ? (
          /* A history load that failed leaves loadedSessionID unset, which the spinner test below
             cannot tell apart from one still in flight — so without this the pane spun forever on
             a session the harness refused to open, and the reason only ever reached the toast. */
          <div className="empty-state compact">
            <p>{t('detail.loadFailed')}</p>
            <p className="subtle">{loadFailure.message}</p>
            <button type="button" className="secondary" onClick={onRetrySession}>{t('sessions.retry')}</button>
          </div>
        ) : loadingSessionID === selectedID || loadedSessionID !== selectedID ? (
          <div className="empty-state compact">
            <LoadingIcon size={32} />
            <p>{t('detail.loading')}</p>
          </div>
        ) : renderedMessages.length === 0 && !showTypingBubble && pendingQuestions.length === 0 && pendingPermissions.length === 0 ? (
          <div className="empty-state compact">
            <ChatIcon size={40} className="icon-empty-state" />
            <p>{t('detail.emptyTitle')}</p>
            <p className="subtle">{t('detail.emptyHint')}</p>
          </div>
        ) : (
          <>
            {timelineGroups.map((group) =>
              group.kind === "message" ? (
                <MessageArticle key={group.message.info.id} message={group.message} config={config} directory={directory} actions={actions} onRevertMessage={onRevertMessage} t={t} />
              ) : (
                <ConversationRunView
                  key={group.key}
                  items={group.items}
                  messagesByID={group.messagesByID}
                  sessionID={group.sessionID}
                  config={config}
                  directory={directory}
                  actions={actions}
                  onRevertMessage={onRevertMessage}
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
            {directory !== undefined &&
              pendingPermissions.map((request) => (
                <PermissionCard
                  key={request.id}
                  config={config}
                  directory={directory}
                  request={request}
                  onResolved={onPermissionResolved}
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
      <JumpControls affordances={jumpAffordances} onJumpToTop={onJumpToTop} onJumpToBottom={onJumpToBottom} t={t} />
    </div>
  )
})

function App() {
  type NoticeType = "info" | "success" | "error"
  type ThemePreference = "system" | "light" | "dark"
  const initialProfiles = useMemo(loadServerProfiles, [])
  const initialProfile = useMemo(() => loadActiveServerProfile(initialProfiles), [initialProfiles])
  const [profiles, setProfiles] = useState<SavedServerProfile[]>(initialProfiles)
  const [activeProfileID, setActiveProfileID] = useState(initialProfile.id)
  const [config, setConfig] = useState<ServerConfig>(initialProfile.config)
  const [draftProfileName, setDraftProfileName] = useState(initialProfile.name)
  const [profileToDelete, setProfileToDelete] = useState<SavedServerProfile | null>(null)
  const [desktopProfileRevision, setDesktopProfileRevision] = useState(0)
  const [desktopProfileSyncError, setDesktopProfileSyncError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    syncDesktopProfiles(profiles).then((result) => {
      if (!active) return
      setDesktopProfileRevision(result.revision)
      setDesktopProfileSyncError(null)
    }).catch((error: unknown) => {
      if (active) setDesktopProfileSyncError(error instanceof Error ? error.message : "Desktop profile synchronization failed")
    })
    return () => {
      active = false
    }
  }, [profiles])
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
  const [extensionActions, setExtensionActions] = useState<HarnessAction[]>([])
  const [commandFilter, setCommandFilter] = useState<"all" | "skill">("all")
  const [agentOptions, setAgentOptions] = useState<AgentOption[]>([])
  const [agentLoadError, setAgentLoadError] = useState<string | null>(null)
  const [selectedAgentID, setSelectedAgentID] = useState<string>(() => localStorage.getItem(AGENT_STORAGE_KEY) || "build")
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [modelLoadError, setModelLoadError] = useState<string | null>(null)
  /** Read inside loadSelected, which must not re-declare itself every time this changes. */
  const modelLoadErrorRef = useRef<string | null>(null)
  modelLoadErrorRef.current = modelLoadError
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(() => readStoredModel(config.backend))
  const [modelQuery, setModelQuery] = useState("")
  const [helpPage, setHelpPage] = useState<"overview" | "server" | "network" | "troubleshooting" | "commands">(
    "overview"
  )
  const [view, setView] = useState<"settings" | "sessions" | "detail" | "help">(() => {
    return config.host && config.port > 0 ? "sessions" : "settings"
  })
  // Desktop gets a persistent left sidebar instead of the mobile top bar/bottom nav; this mirrors
  // the existing 780px CSS breakpoint so JS layout and stylesheet layout never disagree.
  const [isDesktop, setIsDesktop] = useState(() => window.matchMedia(DESKTOP_MEDIA_QUERY).matches)
  /* Whether the platform draws the menu itself. Fixed for the life of the process — it is a
     property of the build, not of the window — so it is read once. */
  const [usesNativeMenu] = useState(desktopUsesNativeMenu)
  useEffect(() => {
    const query = window.matchMedia(DESKTOP_MEDIA_QUERY)
    const onChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])
  // On desktop the sidebar always shows sessions, so the main pane falls back to the chat view
  // instead of duplicating the session list there.
  const mainView = isDesktop && view === "sessions" ? "detail" : view

  // The two side panels carry explicit pixel widths; the conversation between them fills whatever
  // is left, so the panel edges are the borders worth dragging — the other two are the window's own.
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStoredWidth(SIDEBAR_WIDTH_STORAGE_KEY, defaultSidebarWidth(), SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX)
  )
  const [inspectorWidth, setInspectorWidth] = useState(() =>
    readStoredWidth(INSPECTOR_WIDTH_STORAGE_KEY, INSPECTOR_WIDTH_DEFAULT, INSPECTOR_WIDTH_MIN, INSPECTOR_WIDTH_MAX)
  )
  /** The right-hand panel is opt-in and remembered: it is a working surface for whoever is watching
   *  models and file changes, and dead chrome for whoever is only reading the conversation. */
  const [inspectorOpen, setInspectorOpen] = useState(() => localStorage.getItem(INSPECTOR_OPEN_STORAGE_KEY) === "true")
  const [inspectorTab, setInspectorTab] = useState<"ai" | "project">("ai")
  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth))
  }, [sidebarWidth])
  useEffect(() => {
    localStorage.setItem(INSPECTOR_WIDTH_STORAGE_KEY, String(inspectorWidth))
  }, [inspectorWidth])
  useEffect(() => {
    localStorage.setItem(INSPECTOR_OPEN_STORAGE_KEY, String(inspectorOpen))
  }, [inspectorOpen])
  // The window width, becoming state only so a resize re-renders the panels. The render-time clamp
  // of the side panels reads it (via maxSidebarWidth/maxInspectorWidth) and hasRoomForInspector is
  // derived from it — nothing on a resize ever touches the stored preferences below.
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const hasRoomForInspector = viewportWidth >= INSPECTOR_MIN_WINDOW_WIDTH
  // Read through refs by the drag handlers below, which are created during this render but only
  // ever run after it — the widths they clamp against are whatever the last render settled on.
  const inspectorSpaceRef = useRef(0)
  const sidebarWidthRef = useRef(sidebarWidth)
  const dragPanelDivider = useHorizontalDrag((deltaX) => {
    // Growing the sidebar takes the space out of the main pane, which is why the cap has to know
    // the window width — and what the opposite panel is already holding — rather than just the
    // sidebar's own maximum.
    setSidebarWidth((width) => clamp(width + deltaX, SIDEBAR_WIDTH_MIN, maxSidebarWidth(inspectorSpaceRef.current)))
  })
  const dragInspectorDivider = useHorizontalDrag((deltaX) => {
    setInspectorWidth((width) => clamp(width - deltaX, INSPECTOR_WIDTH_MIN, maxInspectorWidth(sidebarWidthRef.current)))
  })
  // Keeps the window width current so a resize re-renders the panels and re-applies the render-time
  // clamp (viewportSidebarWidth/inspectorWidth). The clamp writes to the rendered widths only:
  // the stored preferences are reserved for the drag handle and are never narrowed by the viewport.
  useEffect(() => {
    if (!isDesktop) return
    const reflowPanels = () => setViewportWidth(window.innerWidth)
    reflowPanels()
    window.addEventListener("resize", reflowPanels)
    return () => window.removeEventListener("resize", reflowPanels)
  }, [isDesktop])

  const [sessions, setSessions] = useState<SessionView[]>([])
  const [selectedID, setSelectedID] = useState<string | null>(null)
  const showInspector = isDesktop && inspectorOpen && hasRoomForInspector && mainView === "detail" && Boolean(selectedID)
  // The persisted widths are the user's preference, changed only by dragging the divider. What is
  // actually laid out is that preference clamped to what this window can spare at this moment —
  // kept separate so a resize (or a stored width from a larger screen) never rewrites the stored
  // preference down to a viewport-sized value that then stays small forever.
  const viewportSidebarWidth = isDesktop ? clamp(sidebarWidth, SIDEBAR_WIDTH_MIN, maxSidebarWidth()) : sidebarWidth
  const viewportInspectorWidth = showInspector ? clamp(inspectorWidth, INSPECTOR_WIDTH_MIN, maxInspectorWidth()) : inspectorWidth
  inspectorSpaceRef.current = showInspector ? viewportInspectorWidth : 0
  sidebarWidthRef.current = viewportSidebarWidth
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
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([])

  const [projectDashboard, setProjectDashboard] = useState<ProjectDashboard | null>(null)

  const [dashboardError, setDashboardError] = useState<string | null>(null)
  const [todosExpanded, setTodosExpanded] = useState(false)
  const [query, setQuery] = useState("")
  const [composer, setComposer] = useState("")
  const [attachments, setAttachments] = useState<AttachmentPart[]>([])
  const attachmentInputRef = useRef<HTMLInputElement | null>(null)
  const [busySending, setBusySending] = useState(false)
  const [loadingSessionID, setLoadingSessionID] = useState<string | null>(null)
  /** The empty transcript state is only meaningful after this session's first history snapshot succeeds. */
  const [loadedSessionID, setLoadedSessionID] = useState<string | null>(null)
  /** Which session failed to open, and why, so the transcript pane can say so instead of spinning. */
  const [loadFailure, setLoadFailure] = useState<{ sessionID: string; message: string } | null>(null)
  const [testingConnection, setTestingConnection] = useState(false)
  const [creatingSession, setCreatingSession] = useState(false)
  const [refreshingSessions, setRefreshingSessions] = useState(false)
  const [awaitingAssistantReply, setAwaitingAssistantReply] = useState(false)
  const [settingsNotice, setSettingsNotice] = useState<{ type: NoticeType; text: string } | null>(null)
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
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
  const [renameSource, setRenameSource] = useState<"list" | "header" | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const [activeDetailSheet, setActiveDetailSheet] = useState<null | "ai" | "details">(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [showConnectWizard, setShowConnectWizard] = useState(false)
  const [settingsTab, setSettingsTab] = useState<"server" | "appearance">("server")
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLDivElement | null>(null)
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  // Both gate on mainView, not view: on desktop, picking a session leaves view === "sessions" while
  // the chat is what's actually rendered, so gating on view left the buttons permanently inactive.
  const [jumpAffordances, refreshChatJumps] = useJumpAffordances(mainView === "detail", () =>
    messagesScrollMetrics()
  )
  // mainView is never "sessions" on desktop — there the list is the sidebar below — so this is
  // implicitly the mobile page-scrolled list.
  const [sessionJumpAffordances, refreshSessionJumps] = useJumpAffordances(
    mainView === "sessions",
    windowScrollMetrics
  )
  // The desktop sidebar list scrolls itself, so it needs its own instance reading that element.
  const sidebarSessionsRef = useRef<HTMLDivElement | null>(null)
  const [sidebarJumpAffordances, refreshSidebarJumps] = useJumpAffordances(isDesktop, () =>
    elementScrollMetrics(sidebarSessionsRef.current)
  )
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
  /** The session `openSession` is currently working on, so its retry can tell it is still wanted. */
  const openingSessionRef = useRef<string | null>(null)
  /** Set once the project/vcs/file endpoints prove absent, so polling stops asking for them. */
  const dashboardUnsupportedRef = useRef(false)
  /** When the model list was last re-fetched after a failure, so the retry stays occasional. */
  const modelRetryRef = useRef<{ sessionID: string; at: number } | null>(null)
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

  // On desktop there's always a sidebar listing sessions, so an empty main pane just says
  // "select a session" for no reason — auto-open the first one instead. Only attempted once per
  // server connection so it doesn't fight a session the user deliberately closed back out of.
  const autoSelectAttemptedRef = useRef(false)
  useEffect(() => {
    if (!isDesktop || autoSelectAttemptedRef.current || selectedID || sessions.length === 0) return
    autoSelectAttemptedRef.current = true
    openSession(sessions[0].id, sessions[0].directory).catch(() => undefined)
  }, [isDesktop, selectedID, sessions])

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
  const messageMenuActions = useMemo(() => {
    const supported = new Set(commands.map((command) => command.name.toLowerCase()))
    const actions: MessageMenuAction[] = []
    const revertMessageID = selectedSession?.revertMessageID
    const undoAction = extensionActions.find((action) => action.id === "undo")
    const redoAction = extensionActions.find((action) => action.id === "redo")
    const hasUndo = config.backend === "opencode"
      ? messages.some((message) => message.info.role === "user" && (!revertMessageID || message.info.id < revertMessageID))
      : undoAction ? undoAction.enabled && messages.some((message) => message.info.role === "user") : true
    const hasRedo = config.backend === "opencode" ? !!revertMessageID : redoAction ? redoAction.enabled : true
    const supportsUndo = config.backend === "opencode" || !!undoAction || supported.has("undo")
    const supportsRedo = config.backend === "opencode" || !!redoAction || supported.has("redo")
    if (supportsUndo && hasUndo) actions.push({ id: "undo", label: t('detail.undo'), onSelect: () => void runNativeHistoryCommand("undo") })
    if (supportsRedo && hasRedo) actions.push({ id: "redo", label: t('detail.redo'), onSelect: () => void runNativeHistoryCommand("redo") })
    return actions
  }, [commands, config.backend, extensionActions, messages, selectedSession?.revertMessageID, t])
  /** Session-level actions for the header ⋯ menu. Unlike the message context menu, availability
   *  follows the harness/extension's own enabled state rather than the transcript contents: an
   *  Undo that empties the conversation leaves Redo enabled but with no bubble left to host a menu,
   *  so this menu stays reachable and mirrors exactly what the bridge reports. */
  const sessionHeaderActions = useMemo(() => {
    const supported = new Set(commands.map((command) => command.name.toLowerCase()))
    const actions: MessageMenuAction[] = []
    const revertMessageID = selectedSession?.revertMessageID
    const undoAction = extensionActions.find((action) => action.id === "undo")
    const redoAction = extensionActions.find((action) => action.id === "redo")
    const hasUndo = config.backend === "opencode"
      ? messages.some((message) => message.info.role === "user" && (!revertMessageID || message.info.id < revertMessageID))
      : undoAction ? undoAction.enabled : supported.has("undo")
    const hasRedo = config.backend === "opencode" ? !!revertMessageID : redoAction ? redoAction.enabled : supported.has("redo")
    if (hasUndo) actions.push({ id: "undo", label: t('detail.undo'), onSelect: () => void runNativeHistoryCommand("undo") })
    if (hasRedo) actions.push({ id: "redo", label: t('detail.redo'), onSelect: () => void runNativeHistoryCommand("redo") })
    return actions
  }, [commands, config.backend, extensionActions, messages, selectedSession?.revertMessageID, t])
  const selectedNewSessionDirectory = normalizeDirectory(newSessionDirectory)

  const renderedMessages = useMemo(() => {
    const revertMessageID = config.backend === "opencode" ? selectedSession?.revertMessageID : undefined
    return [...messages, ...optimisticUserMessages]
      .filter((message) => !revertMessageID || message.info.id < revertMessageID)
      .map(toRenderedMessage)
      .filter((message) => message.text || message.parts.some((part) => part.type !== "step-start" && part.type !== "step-finish"))
  }, [config.backend, messages, optimisticUserMessages, selectedSession?.revertMessageID])

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
  const isOffline = connectionState === "offline"
  /* The connection status already speaks when the server is unreachable. A second, more hopeful
     voice about the event stream only made the app look like it disagreed with itself. */
  const eventStreamText = isOffline
    ? ""
    : eventStreamState === "live"
    ? t('events.live', { count: liveEventCount })
    : eventStreamState === "connecting"
      ? t('events.connecting')
      : eventStreamState === "reconnecting"
        ? t('events.reconnecting')
        : eventStreamState === "fallback"
          ? t('events.fallback', { error: liveEventError ?? t('events.unknownError') })
          : ""
  const isSessionRunning = Boolean(selectedSession && isSessionWorking(selectedSession.status))
  const isWaitingForOpenCodeReply = awaitingAssistantReply || busySending || isSessionRunning
  const isWorking = isWaitingForOpenCodeReply
  const showStopAction = isWorking && !composer.trim() && attachments.length === 0
  const showTypingBubble = Boolean(selectedSession) && isWaitingForOpenCodeReply
  const activeSessions = sessions.filter((session) => isSessionWorking(session.status)).length
  const changedSessions = sessions.filter(
    (session) => session.files > 0 || session.additions > 0 || session.deletions > 0
  ).length
  const totalDiffAdditions = diffFiles.reduce((sum, file) => sum + file.additions, 0)
  const totalDiffDeletions = diffFiles.reduce((sum, file) => sum + file.deletions, 0)
  /* The chip also stands its ground when the model list could not be fetched. Hiding it there left
     no trace of a control every other session has — Codex reports its models only inside the
     session load it refuses for a conversation its desktop app holds open, so those sessions lost
     the chip with no explanation. `modelStatusLabel` already has the wording for it. */
  const showModelChip = modelOptions.length > 1
    || Boolean(activeModelOption)
    || primaryAgentOptions.length > 0
    || (capabilities.models && Boolean(modelLoadError))
  /**
   * Three distinct states, and conflating any two of them reads as a hang: a fetch in flight, a
   * fetch that failed, and a harness that has no model list to fetch. `loadModels` returns early
   * when the backend does not expose one, so without the first branch the label would sit on
   * "loading" forever — which is what the Claude Code backend did.
   */
  const modelStatusLabel = activeModelOption?.modelName
    ?? (!capabilities.models
      ? t('detail.modelNotSupported')
      : modelLoadError ? t('detail.modelUnavailable') : t('detail.modelLoading'))

  async function openSession(sessionID: string, directory: string) {
    setSelectedID(sessionID)
    setSelectedModelKey(readStoredModel(config.backend, sessionID))
    loadModelsRequestRef.current += 1
    setModelOptions([])
    setExtensionActions([])
    setMessages([])
    loadedMessagesRef.current = []
    setLoadedSessionID(null)
    setLoadFailure(null)
    setOptimisticUserMessages([])
    setTodos([])
    setDiffFiles([])
    setPendingQuestions([])
    setProjectDashboard(null)
    setDashboardError(null)
    setAwaitingAssistantReply(false)
    setRuntimeError(null)
    setActionNotice(null)
    setView("detail")
    setLoadingSessionID(sessionID)
    openingSessionRef.current = sessionID
    try {
      try {
        await loadSelected(sessionID, directory, true)
      } catch (first) {
        // Opening a session fires several requests at once and one of them losing a flaky mobile
        // connection is common enough that it was the usual way this screen failed. Announcing it
        // immediately made the app look broken for the second it took to come good on its own, so
        // one quiet retry comes first and only a second failure is worth telling anyone about.
        if (openingSessionRef.current !== sessionID) throw first
        await new Promise((resolve) => setTimeout(resolve, 600))
        if (openingSessionRef.current !== sessionID) throw first
        await loadSelected(sessionID, directory, true)
      }
      await Promise.all([loadAgents(), loadModels(sessionID, directory)])
    } catch (err) {
      const message = (err as Error).message
      setRuntimeError(message)
      setLoadFailure({ sessionID, message })
    }
    setLoadingSessionID((activeID) => (activeID === sessionID ? null : activeID))
  }

  function applyConfig(nextConfig: ServerConfig, profileID = activeProfileID, sourceProfiles = profiles) {
    const serverChanged = configKey(nextConfig) !== configKey(config)
    if (serverChanged) {
      loadSelectedRequestRef.current += 1
      loadModelsRequestRef.current += 1
      autoSelectAttemptedRef.current = false
      dashboardUnsupportedRef.current = false
      setSessions([])
      setSelectedID(null)
      setMessages([])
      setLoadedSessionID(null)
      loadedMessagesRef.current = []
      setOptimisticUserMessages([])
      setTodos([])
      setDiffFiles([])
      setProjectDashboard(null)
      setDashboardError(null)
      setAwaitingAssistantReply(false)
      setConnectedVersion("")
      setCommands([])
      setExtensionActions([])
      setActionNotice(null)
      setAgentOptions([])
      setModelOptions([])
      setSelectedModelKey(readStoredModel(nextConfig.backend))
    }
    const nextProfiles = sourceProfiles.map((profile) => profile.id === profileID ? { ...profile, config: nextConfig } : profile)
    setProfiles(nextProfiles)
    setActiveProfileID(profileID)
    persistServerProfiles(nextProfiles, profileID)
    setDraftConfig(nextConfig)
    setConfig(nextConfig)
    setSettingsNotice({ type: "success", text: t('settings.saved') })
    setConnectionState("connecting")
    setConnectionMessage(t('connection.connecting'))
    setRuntimeError(null)
    backgroundFailureCountRef.current = 0
    initialSessionLoadRef.current = true
  }

  function activateProfile(profileID: string) {
    const profile = profiles.find((candidate) => candidate.id === profileID)
    if (!profile || profile.id === activeProfileID) return
    setDraftProfileName(profile.name)
    setDraftConfig(profile.config)
    applyConfig(profile.config, profile.id)
  }

  function deleteActiveProfile() {
    setProfileToDelete(null)
    if (profiles.length === 1) return
    const nextProfiles = profiles.filter((profile) => profile.id !== activeProfileID)
    const nextProfile = nextProfiles[0]
    setDraftProfileName(nextProfile.name)
    setDraftConfig(nextProfile.config)
    applyConfig(nextProfile.config, nextProfile.id, nextProfiles)
  }
  async function testConnection(configToTest: ServerConfig): Promise<{ ok: boolean; message: string }> {
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
      return { ok: true, message: t('settings.connectedTo', { version: health.version }) }
    } catch (err) {
      const message = t('settings.connectionFailed', { message: (err as Error).message })
      setSettingsNotice({ type: "error", text: message })
      return { ok: false, message }
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
      // OpenCode scopes both of these to a project directory, so each one has to be asked
      // separately. The bridge does not: called without a directory it answers for every session it
      // knows. Fanning out there turned one refresh into two requests per distinct directory — over
      // a hundred requests every eight seconds on a real session list, which is what made the app
      // stall for seconds at a time on a phone.
      const directories = isBridgeBackend(config.backend)
        ? []
        : [...new Set(items.map((session) => session.directory).filter(Boolean))]
      const [sessionLists, statusMaps] = isBridgeBackend(config.backend)
        ? await Promise.all([
            api.listSessions(config).then((list) => [list]).catch(() => [[]] as Session[][]),
            api.listStatuses(config).then((map) => [map]).catch(() => [{}] as Record<string, SessionStatus>[])
          ])
        : await Promise.all([
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
        // `current` is the list this refresh started from, so a session opened moments ago may not
        // be in it yet; the ref holds what is actually on screen. Falling back to `current` alone
        // let a refresh that raced an open drop the selected session, and the sessions list then
        // came back with nothing selected.
        const selected = selectedID
          ? current.find((session) => session.id === selectedID)
            ?? (selectedSessionRef.current?.id === selectedID ? selectedSessionRef.current : null)
          : null
        const toPreserve = preserveSession ?? selected
        const next = !toPreserve || mapped.some((session) => session.id === toPreserve.id)
          ? mapped
          : [toPreserve, ...mapped].sort((a, b) => b.updated - a.updated)
        return keepIfUnchanged(current, next)
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
      // A device returning from standby commonly loses one or two polling rounds while Wi-Fi and
      // the server wake up. Keep the last known state and retry quietly before calling it offline.
      if (backgroundFailureCountRef.current < 3) {
        const isInitialLoad = initialSessionLoadRef.current && sessions.length === 0
        setConnectionState(isInitialLoad ? "connecting" : "reconnecting")
        setConnectionMessage(isInitialLoad ? t('connection.loadingSessions') : t('connection.reconnecting'))
        return
      }

      setConnectionState("offline")
      setConnectionMessage(t('connection.offline'))
      setRuntimeError(message)
      initialSessionLoadRef.current = false
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

  async function loadSelected(sessionID: string, directory: string, refreshHistory = false, replaceMessages = false) {
    const requestID = ++loadSelectedRequestRef.current
    const [msg, todo, diff, questions, permissions, actions] = await Promise.all([
      api.loadMessages(config, sessionID, directory, backendClient.messageRefreshSupported && refreshHistory),
      capabilities.todos ? api.loadTodo(config, sessionID, directory) : Promise.resolve([]),
      capabilities.diff ? api.loadDiff(config, sessionID, directory).catch(() => []) : Promise.resolve([]),
      capabilities.questions ? api.loadQuestions(config, directory).catch(() => []) : Promise.resolve([]),
      capabilities.permissions ? api.loadPermissions(config, directory).catch(() => []) : Promise.resolve([]),
      capabilities.actions ? api.listActions(config, sessionID, directory).catch(() => []) : Promise.resolve([])
    ])
    if (requestID !== loadSelectedRequestRef.current) return
    setLoadedSessionID(sessionID)
    // Background polling keeps running after a failed open, so a session that only failed once must
    // not stay stuck on the failure state once its history does arrive.
    setLoadFailure((failure) => (failure?.sessionID === sessionID ? null : failure))
    const current = loadedMessagesRef.current
    // A snapshot carrying less assistant text than is already on screen used to be rejected wholesale, to
    // avoid erasing streamed content. But the optimistic user bubble below is cleared against this same
    // snapshot either way, so rejecting it made a just-sent message vanish — and since the rejected
    // snapshot never reached state, the comparison stayed true and swallowed every later message too,
    // until the session was reopened. Shrinking text is now held back per part in mergeFetchedMessages
    // instead, which keeps the streamed text without ever dropping the messages that came with it.
    if (!messagesHaveSameContent(current, msg)) {
      shouldAutoScrollRef.current = messagesExtendContent(current, msg) && isNearMessagesBottom()
      loadedMessagesRef.current = msg
      setMessages((prev) => replaceMessages ? msg : mergeFetchedMessages(prev, msg))
    }
    setOptimisticUserMessages((current) => {
      const remaining = current.filter((message) => !hasMatchingUserMessage(msg, message))
      return remaining.length === current.length ? current : remaining
    })
    setTodos((current) => keepIfUnchanged(current, todo))
    setDiffFiles((current) => keepIfUnchanged(current, diff))
    setPendingQuestions((current) => keepIfUnchanged(current, questions.filter((question) => question.sessionID === sessionID)))
    setPendingPermissions((current) => keepIfUnchanged(current, permissions.filter((permission) => permission.sessionID === sessionID)))
    setExtensionActions((current) => keepIfUnchanged(current, actions))
    // A model list that failed to load once is never retried on its own — the fetch is tied to the
    // session changing — so a transient failure left the picker disabled and marked in warning for
    // as long as the session stayed open. The transcript arriving is the signal that the server is
    // answering again. Spaced out because some failures are permanent rather than transient: Codex
    // will not list models for a conversation another client holds open, and retrying that on every
    // poll would be a request every few seconds for an answer that is not going to change.
    if (capabilities.models && modelLoadErrorRef.current) {
      const lastAttempt = modelRetryRef.current
      if (lastAttempt?.sessionID !== sessionID || Date.now() - lastAttempt.at > 30_000) {
        modelRetryRef.current = { sessionID, at: Date.now() }
        void loadModels(sessionID, directory)
      }
    }
    // A bridge-backed harness only advertises its commands once a session is loaded, so the
    // mount-time fetch of an idle bridge legitimately returns []. Retry here rather than in each
    // of loadSelected's callers, otherwise Help -> Commands stays empty for the whole visit.
    if (capabilities.commands && commands.length === 0) await loadCommands()
    await loadProjectDashboard(directory)
  }

  async function runNativeHistoryCommand(command: "undo" | "redo") {
    if (!selectedSession || busySending) return
    if (command === "undo" && !window.confirm(t('detail.undoConfirm'))) return

    setBusySending(true)
    setRuntimeError(null)
    setActionNotice(null)
    try {
      let revertedSession: Session | undefined
      if (config.backend === "opencode") {
        const revertMessageID = selectedSession.revertMessageID
        const userMessages = messages.filter((message) => message.info.role === "user")
        if (command === "undo") {
          const target = [...userMessages].reverse().find((message) => !revertMessageID || message.info.id < revertMessageID)
          if (!target) return
          revertedSession = await api.revertMessage(config, selectedSession.id, target.info.id, selectedSession.directory)
        } else {
          const next = userMessages.find((message) => !!revertMessageID && message.info.id > revertMessageID)
          revertedSession = next
            ? await api.revertMessage(config, selectedSession.id, next.info.id, selectedSession.directory)
            : await api.unrevertSession(config, selectedSession.id, selectedSession.directory)
        }
      } else if (capabilities.actions && extensionActions.some((action) => action.id === command)) {
        const result = await api.invokeAction(config, selectedSession.id, command, selectedSession.directory)
        setExtensionActions(result.actions)
        if (result.applied === false) {
          setActionNotice(t(command === "undo" ? 'detail.nothingToUndo' : 'detail.nothingToRedo'))
        }
        await loadSelected(selectedSession.id, selectedSession.directory, true, result.applied !== false)
      } else {
        await api.sendCommand(config, selectedSession.id, command, "", selectedSession.directory, activeModel, activeAgentID)
        await loadSelected(selectedSession.id, selectedSession.directory, true)
      }
      if (config.backend === "opencode") await loadSelected(selectedSession.id, selectedSession.directory, true)
      await refreshSessions(true)
      if (revertedSession) {
        setSessions((current) => current.map((item) => item.id === revertedSession.id ? { ...item, revertMessageID: revertedSession.revert?.messageID } : item))
      }
    } catch (err) {
      setRuntimeError((err as Error).message)
    } finally {
      setBusySending(false)
    }
  }

  async function revertToMessage(messageID: string) {
    if (!selectedSession || busySending || config.backend !== "opencode") return
    if (!window.confirm(t('detail.revertConfirm'))) return

    setBusySending(true)
    setRuntimeError(null)
    try {
      const session = await api.revertMessage(config, selectedSession.id, messageID, selectedSession.directory)
      await loadSelected(selectedSession.id, selectedSession.directory, true)
      await refreshSessions(true)
      setSessions((current) => current.map((item) => item.id === session.id ? { ...item, revertMessageID: session.revert?.messageID } : item))
    } catch (err) {
      setRuntimeError((err as Error).message)
    } finally {
      setBusySending(false)
    }
  }

  async function loadProjectDashboard(directory: string) {
    // The bridge implements none of these three, so on a bridge-backed harness this was nine
    // guaranteed 404s a second during polling. One round of them settles the question for the
    // rest of the connection.
    if (dashboardUnsupportedRef.current) return
    setDashboardError(null)
    try {
      const [project, vcs, fileStatus] = await Promise.all([
        api.loadProjectCurrent(config, directory).catch(() => null),
        api.loadVcs(config, directory).catch(() => null),
        api.loadFileStatus(config, directory).catch(() => [])
      ])
      const files = toFileStatusList(fileStatus)
      if (project === null && vcs === null && files.length === 0) {
        dashboardUnsupportedRef.current = true
        setProjectDashboard(null)
        return
      }
      setProjectDashboard((current) => {
        const next = { project, vcs, files }
        return current && JSON.stringify(current) === JSON.stringify(next) ? current : next
      })
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
    // Scoped to the wrap rather than the list itself so the jump buttons, which are siblings of the
    // list, can sit on top of the same clearance the list reserves for the composer.
    const scope = container.parentElement ?? container
    scope.style.setProperty("--chat-bottom-clearance", `${clearance}px`)
  }

  /** The chat is its own scroller in the desktop layout but lets the page scroll on mobile, so
   *  anything reading scroll position has to look at whichever of the two actually scrolls. */
  function messagesScrollMetrics(): ScrollMetrics {
    const container = messagesRef.current
    if (scrollsItself(container)) return elementScrollMetrics(container)

    // The fixed mobile composer is intentionally outside document flow. The transcript reserves
    // enough tail space to place its sentinel just above that composer, so the visually-correct
    // live tail is not the document's maximum scrollY. Measure the remaining transcript travel
    // directly instead; using document.scrollHeight here leaves the pin false by roughly one
    // composer height even while the last message is exactly where it belongs.
    const endRect = messagesEndRef.current?.getBoundingClientRect()
    const composerRect = composerRef.current?.getBoundingClientRect()
    if (!endRect || !composerRect) return windowScrollMetrics()
    const liveTailBottom = composerRect.top - 12
    return {
      fromTop: window.scrollY,
      fromBottom: Math.max(0, endRect.bottom - liveTailBottom)
    }
  }

  function isNearMessagesBottom(): boolean {
    // Read only the scroller that is active for this layout. On mobile `.messages` deliberately has
    // overflow: visible and the window scrolls; treating the overflowing element as a second scroller
    // makes its permanently-zero scrollTop disable the live-tail pin after almost every swipe.
    return messagesScrollMetrics().fromBottom <= BOTTOM_STICK_THRESHOLD
  }

  const handleMessagesScroll = useCallback(() => {
    stickToBottomRef.current = isNearMessagesBottom()
    refreshChatJumps()
  }, [])

  const handleQuestionResolved = useCallback((id: string) => {
    setPendingQuestions((current) => current.filter((item) => item.id !== id))
  }, [])

  const handlePermissionResolved = useCallback((id: string) => {
    setPendingPermissions((current) => current.filter((item) => item.id !== id))
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

  // Memoised so they don't defeat MessageList's memo on every render.
  const handleJumpToTop = useCallback(() => {
    // Jumping to the oldest message is an explicit "leave the live tail" gesture, so drop the pin;
    // otherwise the next incoming message would yank the view straight back down.
    stickToBottomRef.current = false
    const container = messagesRef.current
    if (scrollsItself(container)) {
      container.scrollTo({ top: 0, behavior: "smooth" })
      return
    }
    // The page is the scroller, so go to the actual top — scrolling the list into view instead
    // would strand the header above the fold and leave this button showing with nowhere to go.
    window.scrollTo({ top: 0, behavior: "smooth" })
  }, [])

  const handleJumpToBottom = useCallback(() => {
    stickToBottomRef.current = true
    scrollMessagesToBottom("smooth")
  }, [])

  /**
   * Both of these reach the memoized transcript, and `onRevertMessage` goes on to every message in
   * it. Declared inline they were a new function on every render of this component, which defeated
   * the memo on all of them and re-parsed every message's markdown each time — the other half of
   * why opening a long chat froze the app. The bodies are read through refs so the callbacks can
   * stay identity-stable while still calling the current version.
   */
  const revertToMessageRef = useRef(revertToMessage)
  revertToMessageRef.current = revertToMessage
  const handleRevertMessage = useCallback((messageID: string) => {
    void revertToMessageRef.current(messageID)
  }, [])

  const openSessionRef = useRef(openSession)
  openSessionRef.current = openSession
  const handleRetrySession = useCallback(() => {
    const session = selectedSessionRef.current
    if (session) void openSessionRef.current(session.id, session.directory)
  }, [])

  const handleSessionsJumpToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: "smooth" })
  }, [])

  const handleSessionsJumpToBottom = useCallback(() => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })
  }, [])

  const handleSidebarJumpToTop = useCallback(() => {
    sidebarSessionsRef.current?.scrollTo({ top: 0, behavior: "smooth" })
  }, [])

  const handleSidebarJumpToBottom = useCallback(() => {
    const list = sidebarSessionsRef.current
    list?.scrollTo({ top: list.scrollHeight, behavior: "smooth" })
  }, [])

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
      await browseNewSessionDirectory(selectedNewSessionDirectory || pathInfo.directory)
    } catch (err) {
      setPickerError((err as Error).message)
    }
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
      const created = await api.createSession(config, t('sessions.remoteSessionTitle'), activeModel, directory)
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
      setLoadedSessionID(null)
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
    // An image with no caption is a complete prompt, so emptiness is about both.
    if (!text && attachments.length === 0) return
    setActionNotice(null)

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
    setAttachments([])
    const optimisticMessage = createOptimisticUserMessage(selectedSession.id, text)
    setOptimisticUserMessages((current) => [...current, optimisticMessage])
    awaitingAssistantBaselineRef.current = assistantResponseSignature
    completionShouldPlayRef.current = true
    setAwaitingAssistantReply(true)
    scrollMessagesToBottom("smooth")

    setBusySending(true)
    setRuntimeError(null)
    try {
      await api.sendPrompt(config, selectedSession.id, text, selectedSession.directory, activeModel, activeAgentID, attachments)
      await loadSelected(selectedSession.id, selectedSession.directory)
      await refreshSessions()
    } catch (err) {
      completionShouldPlayRef.current = false
      setAwaitingAssistantReply(false)
      setOptimisticUserMessages((current) => current.filter((message) => message.info.id !== optimisticMessage.info.id))
      setComposer((current) => current || text)
      // Losing a staged image to a failed send would mean picking it out of the gallery again.
      setAttachments((current) => current.length ? current : attachments)
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

  // The session list (mobile panel and desktop sidebar) and the detail header both offer a rename
  // affordance for the same session — on desktop the sidebar always shows the open session, so
  // without this, renaming from either place would flip both into edit mode at once (and fight
  // over the single renameInputRef). Track which one is active so only that side switches to the
  // input.
  function startRename(session: SessionView, source: "list" | "header" = "list") {
    setRenameValue(session.title)
    setRenamingSessionID(session.id)
    setRenameSource(source)
    // Focus the input after render
    setTimeout(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }, 50)
  }

  function cancelRename() {
    setRenamingSessionID(null)
    setRenameSource(null)
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
    if (!isAndroidPlatform(Capacitor.getPlatform())) return
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
    persistServerProfiles(profiles, activeProfileID)
  }, [])

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
    // A staged image belongs to the connection it was staged on, and the next server may not accept
    // images at all: dropping it here keeps the chips from outliving the control that made them.
    setAttachments([])
    setCapabilities(fallback)
    if (config.backend === "opencode" || !isValidServerConfig(config)) return
    api.capabilities(config).then(setCapabilities).catch(() => setCapabilities(fallback))
  }, [config.backend, config.host, config.port, config.username, config.password])

  useEffect(() => {
    if (!isValidServerConfig(config)) {
      setEventStreamState("idle")
      return
    }
    if (isDesktopPlatform() && desktopProfileSyncError) {
      setLiveEventError(desktopProfileSyncError)
      setEventStreamState("fallback")
      return
    }
    setEventStreamState("connecting")
    const desktop = isDesktopPlatform()
    let stream: { url: string; headers: Record<string, string> } | undefined
    if (!desktop) {
      try {
        stream = api.eventStream(config)
      } catch (error) {
        setLiveEventError((error as Error).message)
        setEventStreamState("fallback")
        return
      }
    }
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
      if (type.startsWith("session.") || type.startsWith("message.") || type.startsWith("todo.") || type.startsWith("question.") || type.startsWith("permission.")) {
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
    let subscription: { close(): void }
    if (desktop) {
      const profileID = desktopProfileID(config)
      if (!profileID) {
        setLiveEventError("Unknown desktop server profile")
        setEventStreamState("fallback")
        return
      }
      subscription = createDesktopOpenCodeEventSubscription({ profileId: profileID, scope: "global", onEvent, onStatus })
    } else if (isNativeEventTransport()) {
      subscription = createNativeOpenCodeEventSubscription({
        url: stream!.url,
        username: config.username,
        password: config.password,
        onEvent,
        onStatus
      })
    } else {
      subscription = createFetchOpenCodeEventSubscription({ url: stream!.url, headers: stream!.headers, onEvent, onStatus })
    }
    return () => {
      clearTimeout(refreshTimer)
      subscription.close()
    }
  }, [config.backend, config.host, config.port, config.username, config.password, desktopProfileRevision, desktopProfileSyncError])

  useEffect(() => {
    if (!hasConfiguredServer) {
      setView("settings")
    }
  }, [hasConfiguredServer])

  // useJumpAffordances watches window scroll for the jump buttons already; this listener is here for
  // the auto-scroll pin, which must also break when the user scrolls the page rather than the list.
  useEffect(() => {
    const onWindowScroll = () => {
      stickToBottomRef.current = isNearMessagesBottom()
    }
    window.addEventListener("scroll", onWindowScroll, { passive: true })
    return () => window.removeEventListener("scroll", onWindowScroll)
  }, [])

  useEffect(() => {
    if (view !== "detail") return
    if (!stickToBottomRef.current) return
    scrollMessagesToBottom("auto")
  }, [view, renderedMessages, isWorking, showTypingBubble, pendingQuestions, pendingPermissions])

  // Growing or swapping the transcript changes the distance to each end without any scroll event
  // firing, so the jump buttons have to be re-evaluated off the content too.
  useEffect(() => {
    if (mainView !== "detail") return
    const frame = requestAnimationFrame(refreshChatJumps)
    return () => cancelAnimationFrame(frame)
  }, [mainView, selectedID, messageScrollSignature, refreshChatJumps])

  // Same for the sessions list: filtering or a refresh changes its length under a static scroll offset.
  useEffect(() => {
    if (mainView !== "sessions") return
    const frame = requestAnimationFrame(refreshSessionJumps)
    return () => cancelAnimationFrame(frame)
  }, [mainView, query, filteredSessions.length, refreshSessionJumps])

  // The desktop sidebar list is always on screen, so it only depends on its own length, and on the
  // sidebar width, which reflows the rows.
  useEffect(() => {
    if (!isDesktop) return
    const frame = requestAnimationFrame(refreshSidebarJumps)
    return () => cancelAnimationFrame(frame)
  }, [isDesktop, query, filteredSessions.length, viewportSidebarWidth, refreshSidebarJumps])

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
    return () => {
      observer.disconnect()
    }
  }, [view, selectedID])

  // Mobile detail and sessions share the window scroller. Leaving a long transcript therefore
  // preserves a large page offset which is usually clamped to the end of the shorter sessions page.
  // Restore the selected card after React has committed and the replacement page has laid out. This
  // single path also covers the Android system back button, the header button and bottom navigation.
  useEffect(() => {
    if (isDesktop || mainView !== "sessions" || !selectedID) return
    let innerFrame = 0
    const outerFrame = requestAnimationFrame(() => {
      innerFrame = requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(".session-card.active")?.scrollIntoView({ block: "center" })
      })
    })
    return () => {
      cancelAnimationFrame(outerFrame)
      if (innerFrame) cancelAnimationFrame(innerFrame)
    }
  }, [isDesktop, mainView, selectedID])

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
    completionAudioRef.current = new Audio(`${import.meta.env.BASE_URL}audio/staplebops-01.aac`)
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
      notifyDesktopCompletion({
        title: t("notification.title"),
        body: t("notification.body"),
        overlayDescription: t("notification.overlayDescription")
      })
    }
    wasAwaitingAssistantReplyRef.current = awaitingAssistantReply
  }, [awaitingAssistantReply])
  useEffect(() => {
    if (!selectedSession) {
      wasRunningRef.current = false
      return
    }
    wasRunningRef.current = isSessionWorking(selectedSession.status)
  }, [selectedSession?.id, selectedSession?.status])

  // Shared between the mobile sessions panel and the desktop sidebar so both list sessions
  // identically instead of maintaining two copies of this markup.
  const renderSessionCard = (session: SessionView) => (
    <article
      key={session.id}
      className={`session-card ${session.status} ${selectedID === session.id ? "active" : ""} ${renamingSessionID === session.id && renameSource === "list" ? "renaming" : ""} fade-in`}
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
          {renamingSessionID === session.id && renameSource === "list" ? (
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
                enterKeyHint="done"
                autoCorrect="off"
                spellCheck={false}
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
                <SaveIcon size={16} />
              </button>
              <button
                className="btn-secondary compact"
                onClick={(event) => {
                  event.stopPropagation()
                  cancelRename()
                }}
                title={t('session.cancel')}
              >
                <CloseIcon size={16} />
              </button>
            </div>
          ) : (
            <h3 title={session.title}>{session.title}</h3>
          )}
          <p title={session.directory}>{shortDirectory(session.directory)}</p>
        </div>
      </div>
      <div className="session-stats">
        {/* "No file changes" is said by its absence: one line fewer on a phone. */}
        {(session.files > 0 || session.additions > 0 || session.deletions > 0) && (
          <span className="change-summary">
            <strong>{session.files}</strong> files
            <strong className="positive">+{session.additions}</strong>
            <strong className="negative">-{session.deletions}</strong>
          </span>
        )}
        <span className="subtle session-meta-line">
          <span className="session-directory-compact" title={session.directory}>{shortDirectory(session.directory)}</span>
          <span title={formatTime(session.updated)}>
            {t('sessions.updated', { time: formatRelativeTime(session.updated, language) })}
          </span>
        </span>
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
  )

  const navItems = [
    { view: "sessions" as const, label: t('nav.sessions'), icon: <FolderIcon size={19} />, disabled: !hasConfiguredServer },
    { view: "detail" as const, label: t('nav.detail'), icon: <ChatIcon size={19} />, disabled: !selectedSession },
    { view: "settings" as const, label: t('nav.settings'), icon: <SettingsIcon size={19} />, disabled: false },
    { view: "help" as const, label: t('nav.help'), icon: <HelpIcon size={19} />, disabled: false }
  ]

  const serverProfileSummaries = profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    backendLabel: backendDisplayName(profile.config.backend),
    backendClass: profile.config.backend,
    address: profile.config.host ? `${profile.config.host}:${profile.config.port}` : t('settings.hostPlaceholder')
  }))

  const brandBlock = (
    <>
      <img src={`${import.meta.env.BASE_URL}app-icon.png`} alt="" className="app-icon" />
      <div className="brand-text">
        <h1>{t('app.title')}</h1>
      </div>
    </>
  )

  /* One dispatcher behind the in-app menu bar, the packaged app's native menu and the command
     palette. Three surfaces offering the same verbs is only an improvement while they cannot
     disagree about what those verbs do or when they are available. */
  function runAppCommand(id: string) {
    switch (id) {
      case "session.new":
        void openNewSessionPicker()
        return
      case "session.refresh":
        void refreshSessionsWithIndicator().catch(() => undefined)
        return
      case "session.rename":
        if (selectedSession) startRename(selectedSession, "header")
        return
      case "session.delete":
        if (selectedSession) setSessionToDelete(selectedSession)
        return
      case "session.stop":
        void abortSession()
        return
      case "session.undo":
        void runNativeHistoryCommand("undo")
        return
      case "session.redo":
        void runNativeHistoryCommand("redo")
        return
      case "focus.composer":
        setView("detail")
        // The pane it lives in may only mount on this render, so reach for it on the next frame.
        requestAnimationFrame(() => composerInputRef.current?.focus())
        return
      case "focus.search":
        if (!isDesktop) setView("sessions")
        requestAnimationFrame(() => searchInputRef.current?.focus())
        return
      case "server.add":
        setShowConnectWizard(true)
        return
      case "server.settings":
        setSettingsTab("server")
        setView("settings")
        return
      case "view.palette":
        setPaletteOpen(true)
        return
      case "view.inspector":
        setInspectorOpen((open) => !open)
        return
      case "view.sessions":
        setView("sessions")
        return
      case "view.theme.system":
        setTheme("system")
        return
      case "view.theme.light":
        setTheme("light")
        return
      case "view.theme.dark":
        setTheme("dark")
        return
      case "help.open":
        setView("help")
        return
      default:
        return
    }
  }
  const runAppCommandRef = useRef(runAppCommand)
  runAppCommandRef.current = runAppCommand

  // Keyboard shortcuts belong to the window, not to any one control, so they keep working while
  // focus is in the transcript or the sidebar. The composer's own Enter/Shift+Enter handling is
  // untouched: nothing here fires without a modifier.
  //
  // Skipped entirely where the platform menu owns the same accelerators, or every one of them would
  // fire twice — harmless for "New session", but a toggle run twice lands back where it started.
  useEffect(() => {
    if (usesNativeMenu) return
    const onKeyDown = (event: KeyboardEvent) => {
      const accelerator = IS_APPLE ? event.metaKey : event.ctrlKey
      if (!accelerator || event.altKey) return
      const command = commandForKeyEvent(event)
      if (!command) return
      event.preventDefault()
      runAppCommandRef.current(command)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [usesNativeMenu])

  // The packaged desktop app draws the platform's own menu bar; its items arrive here as commands
  // so the native menu and the in-app one stay a single implementation.
  useEffect(() => {
    return subscribeDesktopMenuCommands((id) => runAppCommandRef.current(id))
  }, [])

  const menuItem = (id: string, label: string, options: { disabled?: boolean; checked?: boolean } = {}): MenuEntry => ({
    kind: "item",
    id,
    label,
    shortcut: displayShortcut(id),
    disabled: options.disabled,
    checked: options.checked,
    onSelect: () => runAppCommand(id)
  })

  const menuDefinitions: MenuDefinition[] = [
    {
      id: "file",
      label: t('menubar.file'),
      entries: [
        menuItem("session.new", t('command.newSession'), { disabled: !hasConfiguredServer || isOffline }),
        menuItem("session.refresh", t('command.refreshSessions'), { disabled: !hasConfiguredServer }),
        { kind: "separator", id: "file-sep" },
        menuItem("server.add", t('command.addServer')),
        menuItem("server.settings", t('command.openSettings'))
      ]
    },
    {
      id: "session",
      label: t('menubar.session'),
      entries: [
        menuItem("focus.composer", t('command.focusComposer'), { disabled: !selectedSession }),
        menuItem("session.stop", t('command.stopAgent'), { disabled: !selectedSession || !isWorking }),
        { kind: "separator", id: "session-sep-1" },
        menuItem("session.undo", t('detail.undo'), { disabled: !sessionHeaderActions.some((action) => action.id === "undo") }),
        menuItem("session.redo", t('detail.redo'), { disabled: !sessionHeaderActions.some((action) => action.id === "redo") }),
        { kind: "separator", id: "session-sep-2" },
        menuItem("session.rename", t('session.renameTitle'), { disabled: !selectedSession || !capabilities.sessionRename }),
        menuItem("session.delete", t('sessions.delete'), { disabled: !selectedSession || !capabilities.sessionDelete })
      ]
    },
    {
      id: "view",
      label: t('menubar.view'),
      entries: [
        menuItem("view.palette", t('command.commandPalette')),
        menuItem("focus.search", t('command.searchSessions')),
        menuItem("view.inspector", t('command.toggleInspector'), { checked: inspectorOpen }),
        { kind: "separator", id: "view-sep" },
        menuItem("view.theme.system", t('settings.themeSystem'), { checked: theme === "system" }),
        menuItem("view.theme.light", t('settings.themeLight'), { checked: theme === "light" }),
        menuItem("view.theme.dark", t('settings.themeDark'), { checked: theme === "dark" })
      ]
    },
    {
      id: "help",
      label: t('menubar.help'),
      entries: [menuItem("help.open", t('command.openHelp'))]
    }
  ]

  /* Where the platform draws the menu, it is handed the same definitions the in-app bar would have
     rendered — labels, enabled state and all — so the two can only ever say the same thing. Sent on
     change rather than on every render: the signature is what the menu actually depends on, and the
     definitions are rebuilt each time the transcript ticks. */
  const nativeMenuTemplate = usesNativeMenu
    ? menuDefinitions.map((menu) => ({
        id: menu.id,
        label: menu.label,
        items: menu.entries.map((entry) => entry.kind === "separator"
          ? { kind: "separator" as const }
          : {
              kind: "item" as const,
              command: entry.id as DesktopMenuCommand,
              label: entry.label,
              accelerator: electronAccelerator(entry.id),
              enabled: !entry.disabled,
              checked: entry.checked
            })
      }))
    : null
  const nativeMenuSignature = nativeMenuTemplate ? JSON.stringify(nativeMenuTemplate) : ""
  useEffect(() => {
    if (!nativeMenuSignature) return
    setDesktopApplicationMenu(JSON.parse(nativeMenuSignature) as DesktopMenuTemplate)
  }, [nativeMenuSignature])

  const paletteCommands: PaletteCommand[] = [
    { id: "session.new", group: t('command.groupSession'), label: t('command.newSession'), hint: displayShortcut("session.new"), icon: <PlusIcon size={16} />, disabled: !hasConfiguredServer || isOffline },
    { id: "session.refresh", group: t('command.groupSession'), label: t('command.refreshSessions'), hint: displayShortcut("session.refresh"), icon: <RefreshIcon size={16} />, disabled: !hasConfiguredServer },
    { id: "session.rename", group: t('command.groupSession'), label: t('session.renameTitle'), icon: <PencilIcon size={16} />, disabled: !selectedSession || !capabilities.sessionRename },
    { id: "session.delete", group: t('command.groupSession'), label: t('sessions.delete'), icon: <TrashIcon size={16} />, disabled: !selectedSession || !capabilities.sessionDelete },
    { id: "session.stop", group: t('command.groupSession'), label: t('command.stopAgent'), icon: <StopCircleIcon size={16} />, disabled: !selectedSession || !isWorking },
    { id: "session.undo", group: t('command.groupSession'), label: t('detail.undo'), disabled: !sessionHeaderActions.some((action) => action.id === "undo") },
    { id: "session.redo", group: t('command.groupSession'), label: t('detail.redo'), disabled: !sessionHeaderActions.some((action) => action.id === "redo") },
    { id: "server.add", group: t('command.groupServer'), label: t('command.addServer'), icon: <ServerIcon size={16} /> },
    { id: "server.settings", group: t('command.groupServer'), label: t('command.openSettings'), hint: displayShortcut("server.settings"), icon: <SettingsIcon size={16} /> },
    { id: "view.palette", group: t('command.groupView'), label: t('command.commandPalette'), hint: displayShortcut("view.palette"), icon: <CommandIcon size={16} /> },
    { id: "view.inspector", group: t('command.groupView'), label: t('command.toggleInspector'), hint: displayShortcut("view.inspector"), icon: <PanelRightIcon size={16} />, disabled: !selectedSession || !hasRoomForInspector },
    { id: "view.theme.light", group: t('command.groupView'), label: t('settings.themeLight') },
    { id: "view.theme.dark", group: t('command.groupView'), label: t('settings.themeDark') },
    { id: "view.theme.system", group: t('command.groupView'), label: t('settings.themeSystem') },
    { id: "help.open", group: t('command.groupView'), label: t('command.openHelp'), icon: <HelpIcon size={16} /> }
  ]
    .map((command) => ({ ...command, run: () => runAppCommand(command.id) }))
    .concat(
      // Sessions are commands too: on a machine running a dozen of them, typing three letters of a
      // project name beats scrolling a sidebar for it.
      sessions.map((session) => ({
        id: `open-session-${session.id}`,
        group: t('command.groupOpenSession'),
        label: session.title,
        hint: shortDirectory(session.directory),
        keywords: session.directory,
        icon: <ChatIcon size={16} />,
        run: () => void openSession(session.id, session.directory).catch(() => undefined)
      }))
    )
    .concat(
      profiles
        .filter((profile) => profile.id !== activeProfileID)
        .map((profile) => ({
          id: `switch-server-${profile.id}`,
          group: t('command.groupServer'),
          label: t('command.switchTo', { name: profile.name }),
          hint: profile.config.host ? `${profile.config.host}:${profile.config.port}` : "",
          icon: <ServerIcon size={16} />,
          run: () => activateProfile(profile.id)
        }))
    )

  const serverSwitcher = (
    <ServerSwitcher
      profiles={serverProfileSummaries}
      activeProfileID={activeProfileID}
      connectionState={connectionState}
      connectionLabel={connectionStatusText || t('connection.connecting')}
      onSelect={activateProfile}
      onAddServer={() => setShowConnectWizard(true)}
      onManageServers={() => {
        setSettingsTab("server")
        setView("settings")
      }}
      addLabel={t('command.addServer')}
      manageLabel={t('command.manageServers')}
      ariaLabel={t('settings.serverProfile')}
    />
  )

  /* The AI controls and the project readout are the same panel wherever they appear: a bottom sheet
     on a phone, the right-hand inspector on a desktop. Written once, so the two can never drift. */
  const aiPanelContent = (
    <>
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
              inputMode="search"
              enterKeyHint="search"
              autoCapitalize="none"
              spellCheck={false}
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
                      {/* The harness's own description carries the version — "Sonnet 5 ·
                          Efficient for routine tasks" — which is what someone picking a
                          model wants. The provider only earns the line when there is
                          nothing better, as with OpenCode. */}
                      <small>
                        {[option.description ?? option.providerName, option.variant].filter(Boolean).join(" · ")}
                      </small>
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
        <p className="subtle">
          {!capabilities.models
            ? t('detail.modelNotSupported')
            : modelLoadError ? t('detail.modelLoadError', { message: modelLoadError }) : t('detail.modelLoading')}
        </p>
      )}
    </>
  )

  const projectPanelContent = selectedSession ? (
    <>
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
        <strong>{modelStatusLabel}</strong>
        <small>{activeModelOption?.providerName ?? "-"}</small>
      </div>
    </>
  ) : null

  /* Rows carry the project they belong to rather than repeating an absolute path per row: with a
     dozen sessions across three checkouts, the folder is the thing being scanned for. */
  const sidebarGroups = filteredSessions.reduce<Array<{ directory: string; sessions: SessionView[] }>>((groups, session) => {
    const last = groups[groups.length - 1]
    if (last && last.directory === session.directory) last.sessions.push(session)
    else groups.push({ directory: session.directory, sessions: [session] })
    return groups
  }, [])

  return (
    <div className={`app-shell${isDesktop ? " app-shell-desktop" : ""}`}>
      {isDesktop ? (
        <MenuBar
          menus={usesNativeMenu ? [] : menuDefinitions}
          brand={brandBlock}
          right={(
            <>
              <button type="button" className="palette-hint" onClick={() => setPaletteOpen(true)}>
                <SearchIcon size={14} />
                <span>{t('command.commandPalette')}</span>
                <kbd className="kbd">{shortcut("K")}</kbd>
              </button>
              {serverSwitcher}
              <button
                type="button"
                className={`btn-icon btn-ghost${inspectorOpen ? " active" : ""}`}
                onClick={() => setInspectorOpen((open) => !open)}
                aria-label={t('command.toggleInspector')}
                title={t('command.toggleInspector')}
                disabled={!selectedSession || !hasRoomForInspector}
              >
                <PanelRightIcon size={16} />
              </button>
            </>
          )}
        />
      ) : mainView === "detail" && selectedSession ? (
        <header className="mobile-appbar mobile-session-appbar fade-in">
          <div className="appbar-lead">
            <button
              type="button"
              className="btn-icon btn-ghost mobile-back-button"
              onClick={() => setView("sessions")}
              aria-label={t('detail.backToSessions')}
              title={t('detail.backToSessions')}
            >
              <ArrowLeftIcon size={20} />
            </button>
            <div className="appbar-titles">
              <h1 title={selectedSession.title}>{selectedSession.title}</h1>
              <p title={selectedSession.directory}>{projectLabel(selectedSession.directory)}</p>
            </div>
          </div>
          {sessionHeaderActions.length > 0 && (
            <div className="appbar-actions">
              <SessionActionsMenu actions={sessionHeaderActions} t={t} />
            </div>
          )}
        </header>
      ) : (
        <header className="mobile-appbar mobile-global-appbar fade-in">
          <div className="mobile-appbar-brand">{brandBlock}</div>
          <div className="mobile-appbar-spacer" />
          {serverSwitcher}
        </header>
      )}

      <div className="app-body">

      {isDesktop && (
        <aside className="desktop-sidebar fade-in" style={{ width: viewportSidebarWidth, flex: `0 0 ${viewportSidebarWidth}px` }}>
          <div className="resize-handle resize-handle--end" onPointerDown={dragPanelDivider} role="separator" aria-orientation="vertical" aria-label="Resize panels" />
          <div className="sidebar-toolbar">
            <div className="search-field">
              <SearchIcon size={14} />
              <input
                ref={searchInputRef}
                placeholder={t('sessions.searchPlaceholder')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="search"
              />
            </div>
            <button
              onClick={refreshSessionsWithIndicator}
              className="btn-secondary"
              disabled={refreshingSessions}
              aria-label={t('sessions.refresh')}
              title={t('sessions.refresh')}
            >
              {refreshingSessions ? <LoadingIcon size={16} /> : <RefreshIcon size={16} />}
            </button>
            <button
              onClick={openNewSessionPicker}
              className="btn-primary"
              disabled={creatingSession || isOffline}
              aria-label={t('sessions.new')}
              title={isOffline ? t('sessions.offlineHint') : t('sessions.new')}
            >
              {creatingSession ? <LoadingIcon size={16} /> : <PlusIcon size={16} />}
            </button>
          </div>

          <div className="sidebar-sessions" ref={sidebarSessionsRef} onScroll={refreshSidebarJumps}>
            {filteredSessions.length === 0 ? (
              <p className="subtle sidebar-empty">
                {isOffline ? t('sessions.offlineHint') : t('sessions.emptyTitle')}
              </p>
            ) : (
              sidebarGroups.map((group) => (
                <section key={group.directory} className="sidebar-group">
                  <div className="sidebar-group-label" title={group.directory}>
                    <FolderIcon size={12} />
                    <span>{projectLabel(group.directory)}</span>
                    <span className="sidebar-group-count">{group.sessions.length}</span>
                  </div>
                  {group.sessions.map(renderSessionCard)}
                </section>
              ))
            )}
          </div>

          <JumpControls
            affordances={sidebarJumpAffordances}
            onJumpToTop={handleSidebarJumpToTop}
            onJumpToBottom={handleSidebarJumpToBottom}
            variant="sidebar"
            t={t}
          />

          <div className="sidebar-footer">
            <button type="button" className="btn-secondary" onClick={() => setView("help")} title={t('nav.help')}>
              <HelpIcon size={18} />
              <span className="sidebar-footer-label">{t('nav.help')}</span>
            </button>
            <button type="button" className="btn-secondary" onClick={() => setView("settings")} title={t('nav.settings')}>
              <SettingsIcon size={18} />
              <span className="sidebar-footer-label">{t('nav.settings')}</span>
            </button>
          </div>
        </aside>
      )}

      <div
        className="main-content"
        style={isDesktop ? { minWidth: MAIN_WIDTH_MIN, position: "relative" } : undefined}
      >
      {mainView === "settings" && (
        <ConditionalWrapper
          condition={isDesktop}
          wrapper={(children) => (
            <DesktopModalOverlay onClose={() => setView("detail")} ariaLabel={t('settings.title')}>
              {children}
            </DesktopModalOverlay>
          )}
        >
        <section className="panel settings fade-in" data-settings-tab={settingsTab}>
          <div className="section-heading">
            <div className="section-heading-text">
              <h2>{t('settings.title')}</h2>
              <p className="subtle">{hasConfiguredServer ? `${config.host}:${config.port}` : t('settings.hostPlaceholder')}</p>
              <p className="subtle">{t('settings.draftHint')}</p>
            </div>
            {/* Aligned to the bottom of the heading text: the pair costs no height of its own there,
                and it stays clear of the corner the modal's close button occupies. */}
            <div className="server-profile-actions">
              <button type="button" className="btn-secondary" onClick={() => setShowConnectWizard(true)}>
                <PlusIcon size={16} />
                {t('settings.addServer')}
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={() => setProfileToDelete(profiles.find((profile) => profile.id === activeProfileID) ?? null)}
                disabled={profiles.length === 1}
                title={profiles.length === 1 ? t('settings.deleteLastServerHint') : undefined}
              >
                <TrashIcon size={16} />
                {t('settings.deleteServer')}
              </button>
            </div>
          </div>

          <div className="settings-nav settings-nav-inline" role="tablist" aria-label={t('settings.title')}>
            <button type="button" role="tab" aria-selected={settingsTab === "server"} className={settingsTab === "server" ? "active" : ""} onClick={() => setSettingsTab("server")}>
              <ServerIcon size={16} />
              {t('settings.serverProfile')}
            </button>
            <button type="button" role="tab" aria-selected={settingsTab === "appearance"} className={settingsTab === "appearance" ? "active" : ""} onClick={() => setSettingsTab("appearance")}>
              <SettingsIcon size={16} />
              {t('settings.theme')}
            </button>
          </div>

          <div className="form-grid">
          <label htmlFor="server-name" className="field-row-span settings-server-field">
            {t('settings.serverName')}
            <input
              id="server-name"
              value={draftProfileName}
              onChange={(event) => {
                const name = event.target.value
                setDraftProfileName(name)
                const nextProfiles = profiles.map((profile) => profile.id === activeProfileID ? { ...profile, name } : profile)
                setProfiles(nextProfiles)
                persistServerProfiles(nextProfiles, activeProfileID)
              }}
              autoComplete="off"
            />
          </label>
          <label htmlFor="language" className="settings-appearance-field">
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

          <label htmlFor="theme" className="settings-appearance-field">
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
          
          <label htmlFor="backend" className="settings-server-field">
            {t('settings.backend')}
            <select
              id="backend"
              value={draftConfig.backend}
              onChange={(event) => {
                const backend = event.target.value as ServerConfig["backend"]
                setDraftConfig(createServerProfile("", backend).config)
              }}
            >
              <option value="opencode">OpenCode</option>
              <option value="omp">Oh My Pi (bridge)</option>
              <option value="pi">PI (ACP bridge)</option>
              <option value="claude">Claude Code (ACP bridge)</option>
              <option value="codex">Codex CLI (ACP bridge)</option>
            </select>
          </label>

          <label htmlFor="host" className="settings-server-field">
            {t('settings.host')}
            <input
              id="host"
              value={draftConfig.host}
              onChange={(event) => setDraftConfig({ ...draftConfig, host: event.target.value })}
              placeholder={t('settings.hostPlaceholder')}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <label htmlFor="port" className="settings-server-field">
            {t('settings.port')}
            <input
              id="port"
              type="text"
              value={draftConfig.port || ""}
              onChange={(event) => {
                const value = event.target.value.trim()
                if (value === "" || /^\d+$/.test(value)) {
                  setDraftConfig({ ...draftConfig, port: value === "" ? 0 : Number(value) })
                }
              }}
              placeholder="4096"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
            />
          </label>
          
          <label htmlFor="username" className="settings-server-field">
            {t('settings.username')}
            <input
              id="username"
              value={draftConfig.username}
              onChange={(event) => setDraftConfig({ ...draftConfig, username: event.target.value })}
              placeholder="opencode"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="username"
            />
          </label>
          
          <label htmlFor="password" className="settings-server-field">
            {t('settings.password')}
            <input
              id="password"
              type="password"
              value={draftConfig.password}
              onChange={(event) => setDraftConfig({ ...draftConfig, password: event.target.value })}
              placeholder={t('settings.passwordPlaceholder')}
              autoComplete="current-password"
            />
          </label>
          </div>
          
          <div className="actions">
            <button 
              type="button"
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
        </ConditionalWrapper>
      )}

      {mainView === "sessions" && (
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
              <button
                onClick={openNewSessionPicker}
                className="btn-primary"
                disabled={creatingSession || isOffline}
                title={isOffline ? t('sessions.offlineHint') : undefined}
              >
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
            {/* An empty list while the server is unreachable is not "still loading". Saying so,
                and offering the two things worth doing, beats a spinner that never resolves. */}
            {filteredSessions.length === 0 && isOffline ? (
              <div className="empty-state">
                <OfflineIcon size={44} className="icon-empty-state" />
                <p>{t('sessions.offlineHint')}</p>
                <div className="empty-state-actions">
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => refreshSessionsWithIndicator().catch(() => undefined)}
                    disabled={refreshingSessions}
                  >
                    {refreshingSessions ? <LoadingIcon size={18} /> : <RefreshIcon size={18} />}
                    {t('sessions.retry')}
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => setView("settings")}>
                    <SettingsIcon size={18} />
                    {t('nav.settings')}
                  </button>
                </div>
              </div>
            ) : filteredSessions.length === 0 && ['connecting', 'reconnecting'].includes(connectionState) ? (
              <div className="empty-state connection-pending">
                <LoadingIcon size={40} className="icon-empty-state" />
                <p>{t('sessions.loadingTitle')}</p>
                <p className="subtle">{t('sessions.loadingHint')}</p>
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="empty-state">
                <FolderIcon size={48} className="icon-empty-state" />
                <p>{t('sessions.emptyTitle')}</p>
                <p className="subtle">{t('sessions.emptyHint')}</p>
              </div>
            ) : (
              filteredSessions.map(renderSessionCard)
            )}
          </div>

          {/* The offline empty state already explains this and offers the two useful actions;
              repeating the raw transport error underneath is the second voice again. */}
          {runtimeError && !(isOffline && filteredSessions.length === 0) && (
            <div className="error fade-in">✗ {runtimeError}</div>
          )}

          <JumpControls
            affordances={sessionJumpAffordances}
            onJumpToTop={handleSessionsJumpToTop}
            onJumpToBottom={handleSessionsJumpToBottom}
            variant="page"
            t={t}
          />
        </section>
      )}

      {showNewSessionPicker && (
        <NewSessionDialog
          t={t}
          path={pickerPath}
          items={pickerItems}
          loading={pickerLoading}
          error={pickerError}
          creating={creatingSession}
          recentDirectories={Array.from(new Set([selectedNewSessionDirectory, ...sessions.map((session) => session.directory)].filter((directory): directory is string => Boolean(directory)))).slice(0, 5)}
          onBrowse={(directory) => void browseNewSessionDirectory(directory).catch(() => undefined)}
          onCreate={(directory) => void createSession(directory).catch(() => undefined)}
          onUseServerDefault={() => void createSession("").catch(() => undefined)}
          onClose={() => setShowNewSessionPicker(false)}
        />
      )}

      {mainView === "detail" && (
        <main className="panel detail fade-in">
          <div className="header-row detail-header desktop-detail-header">
              <div>
              <h2>
                {selectedSession ? (
                  <div className="detail-title-row">
                    {renamingSessionID === selectedSession.id && renameSource === "header" ? (
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
                        {/* Two unlabelled 14px glyphs asked the user to guess which one commits.
                            One labelled primary action, and cancel as the quieter icon. */}
                        <button
                          className="btn-icon btn-primary compact rename-save"
                          onClick={() => renameSession(selectedSession.id, renameValue, selectedSession.directory).catch(() => undefined)}
                          onMouseDown={(event) => event.preventDefault()}
                          disabled={!renameValue.trim() || renameValue === selectedSession.title}
                          title={t('session.renameConfirm')}
                          aria-label={t('session.renameConfirm')}
                        >
                          <SaveIcon size={16} />
                        </button>
                        <button
                          className="btn-icon btn-secondary compact"
                          onClick={() => cancelRename()}
                          onMouseDown={(event) => event.preventDefault()}
                          title={t('session.cancel')}
                          aria-label={t('session.cancel')}
                        >
                          <CloseIcon size={18} />
                        </button>
                      </div>
                    ) : (
                      <>
                        {/* A 14px glyph is a poor target and a poor hint. The title itself is the
                            button; the pencil only says that it can be edited. */}
                        {capabilities.sessionRename ? (
                          <button
                            type="button"
                            className="session-title-button"
                            onClick={() => startRename(selectedSession, "header")}
                            title={t('session.renameTitle')}
                            aria-label={t('session.renameTitle')}
                          >
                            <span className="session-title-text">{selectedSession.title}</span>
                            <PencilIcon size={18} className="session-title-pencil" />
                          </button>
                        ) : (
                          <span className="session-title-text">{selectedSession.title}</span>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  t('detail.selectSession')
                )}
              </h2>
              {selectedSession && (
                <p className="subtle detail-subline" title={selectedSession.directory}>
                  <span className="detail-subline-path">{shortDirectory(selectedSession.directory)}</span>
                  {/* Moved up from between the messages and the composer, where the sticky
                      composer covered half of it. Written out rather than tagged: a one-word
                      label needed a tooltip to be understood, and touch has no tooltip. */}
                  {selectedSession.external && (
                    <span className="detail-subline-note">{t('detail.externalSession')}</span>
                  )}
                </p>
                )}
              </div>
              {isDesktop && selectedSession && sessionHeaderActions.length > 0 && (
                <SessionActionsMenu actions={sessionHeaderActions} t={t} />
              )}
            </div>

          {selectedSession && (
            <section className="session-context-strip" aria-label={t('detail.contextStripLabel')}>
              {showModelChip && (
                <button
                  type="button"
                  className={`context-chip${modelLoadError && !activeModelOption ? " chip-warning" : ""}`}
                  onClick={() => setActiveDetailSheet("ai")}
                >
                  <span>{t('detail.aiChip')}</span>
                  <strong>{capabilities.agents ? `${agentLabel(activeAgent ?? { id: activeAgentID, name: activeAgentID, mode: "primary" })} · ${modelStatusLabel}` : modelStatusLabel}</strong>
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
            loadedSessionID={loadedSessionID}
            loadFailure={loadFailure}
            onRetrySession={handleRetrySession}
            selectedID={selectedID}
            renderedMessages={renderedMessages}
            timelineGroups={timelineGroups}
            showTypingBubble={showTypingBubble}
            pendingQuestions={pendingQuestions}
            pendingPermissions={pendingPermissions}
            config={config}
            directory={selectedSession?.directory}
            actions={messageMenuActions}
            onRevertMessage={handleRevertMessage}
            t={t}
            jumpAffordances={jumpAffordances}
            onJumpToTop={handleJumpToTop}
            onJumpToBottom={handleJumpToBottom}
            messagesRef={messagesRef}
            messagesEndRef={messagesEndRef}
            onMessagesScroll={handleMessagesScroll}
            onQuestionResolved={handleQuestionResolved}
            onPermissionResolved={handlePermissionResolved}
          />



          <div className="composer" ref={composerRef}>
            {attachments.length > 0 && (
              <div className="composer-chips">
                {attachments.map((attachment, index) => (
                  <span className="composer-chip" key={`${attachment.filename}-${index}`}>
                    <strong>{attachment.filename}</strong>
                    <button
                      className="btn-ghost btn-icon"
                      aria-label={t('detail.removeAttachment')}
                      onClick={() => setAttachments((current) => current.filter((_, position) => position !== index))}
                    >
                      <CloseIcon size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={composerInputRef}
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              placeholder={t('detail.composerPlaceholder')}
              enterKeyHint={SOFT_KEYBOARD_DEVICE ? "enter" : "send"}
              autoCapitalize="sentences"
              autoCorrect="on"
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
                if (event.key !== "Enter") return
                if (SOFT_KEYBOARD_DEVICE) {
                  // The soft keyboard has no Shift key, so Enter inserts a new line by default
                  // and Ctrl/Cmd+Enter (hardware keyboards) sends.
                  if (event.ctrlKey || event.metaKey) {
                    event.preventDefault()
                    send().catch(() => undefined)
                  }
                  return
                }
                if (!event.shiftKey) {
                  event.preventDefault()
                  send().catch(() => undefined)
                }
              }}
              disabled={!selectedSession}
            />
            <div className="composer-bar">
              {/* Gated on what the harness advertised: PI, Claude Code and Codex CLI expose no image
                  prompt capability, and offering a picker whose only outcome is a refusal at send
                  time is worse than not offering one. The OS picker is the camera, the gallery and
                  the file browser in one, so the app needs no capture UI of its own. */}
              {capabilities.attachments && (
                <>
                  <input
                    ref={attachmentInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={async (event) => {
                      const chosen = Array.from(event.target.files ?? []).slice(0, ATTACHMENT_MAX_COUNT - attachments.length)
                      event.target.value = ""
                      if (!chosen.length) return
                      try {
                        const prepared = await Promise.all(chosen.map((file) => fileToAttachment(file)))
                        setAttachments((current) => [...current, ...prepared])
                        setRuntimeError(null)
                      } catch (err) {
                        setRuntimeError((err as Error).message)
                      }
                    }}
                  />
                  <button
                    className="btn-ghost btn-icon"
                    title={t('detail.attachImage')}
                    aria-label={t('detail.attachImage')}
                    onClick={() => attachmentInputRef.current?.click()}
                    disabled={!selectedSession || attachments.length >= ATTACHMENT_MAX_COUNT}
                  >
                    <PaperclipIcon size={18} />
                  </button>
                </>
              )}
              <div className="composer-actions">
                {/* While the agent works the same button stops it, but starts sending again as
                    soon as there is something to send, so a follow-up can be queued. */}
                <button
                  onClick={showStopAction ? abortSession : send}
                  disabled={!selectedSession}
                  className={showStopAction ? "btn-danger composer-send" : "btn-primary composer-send"}
                >
                  {showStopAction ? (
                    <StopCircleIcon size={18} />
                  ) : (
                    <SendIcon size={18} />
                  )}
                </button>
              </div>
            </div>
          </div>

          {runtimeError && <div className="error fade-in">✗ {runtimeError}</div>}
          {actionNotice && <div className="notice info fade-in">ℹ {actionNotice}</div>}
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
                        inputMode="search"
                        enterKeyHint="search"
                        autoCapitalize="none"
                        spellCheck={false}
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
                                {/* The harness's own description carries the version — "Sonnet 5 ·
                                    Efficient for routine tasks" — which is what someone picking a
                                    model wants. The provider only earns the line when there is
                                    nothing better, as with OpenCode. */}
                                <small>
                                  {[option.description ?? option.providerName, option.variant].filter(Boolean).join(" · ")}
                                </small>
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
                  <p className="subtle">
                    {!capabilities.models
                      ? t('detail.modelNotSupported')
                      : modelLoadError ? t('detail.modelLoadError', { message: modelLoadError }) : t('detail.modelLoading')}
                  </p>
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
                  <strong>{modelStatusLabel}</strong>
                  <small>{activeModelOption?.providerName ?? "-"}</small>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {/* Deleting a saved server throws away a host, a username and a password that cannot be
          recovered, so it is confirmed exactly like deleting a session. */}
      {profileToDelete && (
        <div className="modal-backdrop" role="presentation" onClick={() => setProfileToDelete(null)}>
          <section
            className="modal-card fade-in"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-server-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="delete-server-title">{t('settings.deleteServerTitle')}</h2>
            <p>
              {t('session.deleteBodyPrefix')} <strong>{profileToDelete.name}</strong>.
            </p>
            {/* A server saved but never filled in has no address to show, and the placeholder that
                stands in for one inside the form reads as an actual host here. */}
            {profileToDelete.config.host && (
              <p className="subtle">{`${profileToDelete.config.host}:${profileToDelete.config.port}`}</p>
            )}
            <div className="modal-actions">
              <button className="btn-secondary" onClick={() => setProfileToDelete(null)}>
                {t('session.cancel')}
              </button>
              <button className="btn-danger" onClick={deleteActiveProfile}>
                <TrashIcon size={16} />
                {t('settings.deleteServer')}
              </button>
            </div>
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

      {mainView === "help" && (
        <ConditionalWrapper
          condition={isDesktop}
          wrapper={(children) => (
            <DesktopModalOverlay onClose={() => setView("detail")} ariaLabel={t('help.title')}>
              {children}
            </DesktopModalOverlay>
          )}
        >
        <section className="panel help fade-in">
          <h2>{t('help.title')}</h2>
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
                {/* Told in terms of what is actually on screen: the same two steps are a tab and a
                    view on a phone, and two panes side by side on a desktop. */}
                <li><strong>Browse Sessions:</strong> {isDesktop
                  ? "Pick a session from the sidebar on the left"
                  : "View and manage sessions from the Sessions tab"}</li>
                <li><strong>Interact:</strong> {isDesktop
                  ? "Read and reply in the conversation beside it"
                  : "Open a session and chat in the Detail view"}</li>
                <li><strong>Quick Input:</strong> {SOFT_KEYBOARD_DEVICE
                  ? `Enter for new lines, ${shortcut("Enter")} to send`
                  : "Press Enter to send, Shift+Enter for new lines"}</li>
                <li><strong>Slash Commands:</strong> Text starting with <code>/</code> is sent as a command</li>
              </ul>

              {/* Window width alone picks the layout, so the one thing worth stating is where the
                  boundary is: otherwise a resized window looks like the app lost its sidebar. */}
              <h3>Desktop Layout</h3>
              <p>
                A window at least {DESKTOP_MIN_WIDTH}px wide shows the sessions sidebar and the
                conversation side by side.{isDesktop
                  ? " Narrow it below that and the single-view mobile layout comes back."
                  : " This window is narrower than that, which is why you are seeing one view at a time."}
              </p>
              <ul>
                <li><strong>Resize:</strong> Drag the sidebar's outer edge, the divider between the panes, or the conversation's outer edge. Both widths are remembered.</li>
                <li><strong>Rename or delete:</strong> Hover a sidebar row to reveal its icons.</li>
                <li><strong>Working sessions:</strong> A moving accent bar down the left of a row replaces the status pill.</li>
                <li><strong>Settings and Help:</strong> Open over the conversation, so it stays where you left it.</li>
              </ul>

              <h3>Key Features</h3>
              <ul>
                <li>🔄 Real-time session monitoring</li>
                <li>💬 Interactive chat interface</li>
                <li>📋 Todo tracking display</li>
                <li>⚡ Instant session control</li>
                <li>🔔 Completion notifications</li>
                <li>↕️ Jump to either end of a long conversation</li>
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
                ) : config.backend === "claude" ? (
                  <>
                    <h4>Claude Code bridge (macOS / Linux)</h4>
                    <pre>npx --yes ./bridge --backend claude --host 0.0.0.0 --port 4097 --username claude --password your-password --root "$PWD"</pre>
                    <p className="note">Requires <code>claude login</code> or <code>ANTHROPIC_API_KEY</code> on the host machine.</p>
                  </>
                ) : config.backend === "codex" ? (
                  <>
                    <h4>Codex CLI bridge (macOS / Linux)</h4>
                    <pre>npx --yes ./bridge --backend codex --host 0.0.0.0 --port 4097 --username codex --password your-password --root "$PWD"</pre>
                    <p className="note">Requires <code>codex login</code> (ChatGPT account) or an OpenAI API key on the host machine.</p>
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
                  href={`https://github.com/giuliastro/harness-remote#${config.backend === "opencode" ? "opencode-server-setup" : config.backend === "pi" ? "pi-bridge-setup" : config.backend === "claude" ? "claude-code-bridge-setup" : config.backend === "codex" ? "codex-bridge-setup" : "oh-my-pi-bridge-setup"}`}
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
        </ConditionalWrapper>
      )}
      </div>

      {showInspector && (
        <aside className="inspector fade-in" style={{ width: viewportInspectorWidth, flex: `0 0 ${viewportInspectorWidth}px` }}>
          <div className="resize-handle resize-handle--start" onPointerDown={dragInspectorDivider} role="separator" aria-orientation="vertical" aria-label="Resize inspector" />
          <div className="inspector-header">
            <h3>{t('detail.sessionDetailsTitle')}</h3>
            <div className="segmented" role="tablist" aria-label={t('detail.sessionDetailsTitle')}>
              <button type="button" role="tab" aria-selected={inspectorTab === "ai"} className={inspectorTab === "ai" ? "active" : ""} onClick={() => setInspectorTab("ai")}>
                {t('detail.aiChip')}
              </button>
              <button type="button" role="tab" aria-selected={inspectorTab === "project"} className={inspectorTab === "project" ? "active" : ""} onClick={() => setInspectorTab("project")}>
                {t('detail.detailsChip')}
              </button>
            </div>
            <button type="button" className="btn-icon btn-ghost compact" onClick={() => setInspectorOpen(false)} aria-label={t('detail.closeSheet')}>
              <CloseIcon size={16} />
            </button>
          </div>
          <div className="inspector-body">
            {inspectorTab === "ai" ? (
              <section className="inspector-section">
                <div className="inspector-section-title">
                  <span>{t('detail.aiTitle')}</span>
                  <button type="button" className="btn-icon btn-ghost compact" onClick={() => void Promise.all([loadAgents(), loadModels()]).catch(() => undefined)} aria-label={t('detail.refreshAi')}>
                    <RefreshIcon size={14} />
                  </button>
                </div>
                {aiPanelContent}
              </section>
            ) : (
              <section className="inspector-section project-dashboard single-column">
                <div className="inspector-section-title">{t('detail.projectDashboardLabel')}</div>
                {projectPanelContent}
              </section>
            )}
          </div>
        </aside>
      )}
      </div>

      {paletteOpen && (
        <CommandPalette
          commands={paletteCommands}
          placeholder={t('command.palettePlaceholder')}
          emptyLabel={t('command.paletteEmpty')}
          navigateHint={t('command.navigate')}
          runHint={t('command.run')}
          closeHint={t('command.close')}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {showConnectWizard && (
        <ConnectServerWizard
          t={t}
          initialName={t('settings.newServerName')}
          onCancel={() => setShowConnectWizard(false)}
          onTest={testConnection}
          onSave={(name, nextConfig) => {
            const profile = { ...createServerProfile(name, nextConfig.backend), name, config: nextConfig }
            const nextProfiles = [...profiles, profile]
            setDraftProfileName(name)
            applyConfig(nextConfig, profile.id, nextProfiles)
            setShowConnectWizard(false)
            setView("sessions")
          }}
        />
      )}

      {!isDesktop && <nav className="bottom-nav" role="navigation" aria-label="Mobile navigation">
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
      </nav>}
    </div>
  )
}

export default App
