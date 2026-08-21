import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { api } from "../api"
import {
  loadLanguage,
  loadThemePreference,
  persistLanguage,
  persistThemePreference,
  themePreferences,
  APP_PREFERENCES_CHANGED_EVENT,
  type ThemePreference
} from "../appPreferences"
import { languageOptions, type LanguageCode } from "../i18n"
import { discoverMachine, selectableMachineAgents } from "../machineClient"
import { assistantTerminalTextForPrompt } from "../message-content"
import {
  taskClient,
  type MachineProject,
  type MachineTask,
  type MachineTaskRun,
  type TaskWorkspaceInspection
} from "../taskClient"
import { createTaskDeskTranslator, type TaskDeskTranslator } from "../taskdesk-i18n"
import {
  TASKDESK_MOBILE_QUERY,
  useBackNavigation,
  useMediaQuery
} from "../taskdesk-shell-navigation"
import {
  agentLabel,
  modelLabel,
  normalizeTaskStatus,
  sortTasksByActivity,
  taskTitle
} from "../taskdeskHomeModel"
import type {
  DiffFile,
  MachineAgentHost,
  MachineSnapshot,
  MessageEnvelope,
  ModelOption,
  PermissionRequest,
  QuestionRequest,
  ServerConfig,
  TodoItem,
  VcsStatus
} from "../types"
import type { WorkspaceMachine } from "../workspaceMachines"
import {
  AgentIcon,
  AlertIcon,
  ChatIcon,
  CloseIcon,
  FolderIcon,
  LoadingIcon,
  MoreVerticalIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  SparkIcon,
  TaskListIcon
} from "../Icons"
import { IntelligentContinueTaskModal } from "./taskdesk-intelligent-continue"
import { TaskDeskMessageContent } from "./taskdesk-message-content"
import { UniversalWorkspace } from "./universal-workspace"

const REFRESH_MS = 10_000
const DETAIL_REFRESH_MS = 5_000
const REMARK_PLUGINS = [remarkGfm]

const HARNESS_ICON_FILES: Record<string, string> = {
  codex: "codex.svg",
  claude: "claude.svg",
  opencode: "opencode.svg",
  omp: "omp.svg",
  pi: "pi.svg"
}

type ProductTask = MachineTask & { finishedAt?: string | null }
type TaskDeskView = "overview" | "tasks" | "sessions" | "projects" | "needs" | "agents" | "machines" | "classic"
type TaskFilter = "all" | "active" | "review" | "finished" | "failed"
type DetailTab = "review" | "conversation" | "diff" | "runs"
type ProductTaskState = "draft" | "active" | "review" | "finished" | "failed" | "cancelled"
type SessionFocusRequest = { sessionID: string; requestID: number }
type SessionPane = "list" | "detail"

type RuntimeMachine = {
  key: string
  machine: WorkspaceMachine
  snapshot: MachineSnapshot | null
  projects: MachineProject[]
  tasks: ProductTask[]
  agents: MachineAgentHost[]
  state: "online" | "offline" | "loading"
  error?: string
}

type TaskRecord = {
  key: string
  runtime: RuntimeMachine
  task: ProductTask
}

type AttentionItem =
  | { key: string; type: "permission"; runtime: RuntimeMachine; agent: MachineAgentHost; request: PermissionRequest; task?: ProductTask }
  | { key: string; type: "question"; runtime: RuntimeMachine; agent: MachineAgentHost; request: QuestionRequest; task?: ProductTask }

type TaskDetail = {
  ownerKey: string | null
  loading: boolean
  messages: MessageEnvelope[]
  diff: DiffFile[]
  todos: TodoItem[]
  vcs: VcsStatus | null
  result: TaskWorkspaceInspection | null
  error: string | null
}

type RunReviewTarget = { record: TaskRecord; run: MachineTaskRun; sequence: number }

type Props = {
  machines: WorkspaceMachine[]
  activeMachineID: string
  onActiveMachineID: (id: string) => void
  onPersistMachines: (machines: WorkspaceMachine[]) => void
  onManageMachines: () => void
  legacyView: ReactNode
}

function supportedBackend(value: string, fallback: ServerConfig["backend"]): ServerConfig["backend"] {
  return value === "opencode" || value === "omp" || value === "pi" || value === "claude" || value === "codex"
    ? value
    : fallback
}

function configForAgent(runtime: RuntimeMachine, agent: MachineAgentHost): ServerConfig {
  return {
    ...runtime.machine.config,
    backend: supportedBackend(agent.backend, runtime.machine.config.backend),
    agentId: agent.id
  }
}

function harnessIconUrl(backend: string): string | undefined {
  const file = HARNESS_ICON_FILES[backend.toLowerCase()]
  return file ? `${import.meta.env.BASE_URL}harness-icons/${file}` : undefined
}

function HarnessBadge({ agent }: { agent: MachineAgentHost }) {
  const source = harnessIconUrl(agent.backend)
  return (
    <span className="td3-agent-badge" title={`${agent.label} · ${agent.transport}`}>
      {source ? <img src={source} alt="" aria-hidden="true" /> : <span>{agent.label.slice(0, 2).toUpperCase()}</span>}
      <b>{agent.label}</b>
      <i className={`td3-agent-state td3-agent-state-${agent.state}`} />
    </span>
  )
}

function runSessionID(run?: MachineTaskRun | null): string | null {
  return run?.sessionId || run?.sessionID || null
}

function formatRelative(value: string | null | undefined, t: TaskDeskTranslator): string {
  if (!value) return ""
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  const delta = Math.max(0, Date.now() - timestamp)
  if (delta < 60_000) return t("time.now")
  if (delta < 3_600_000) return t("time.minutes", { value: Math.max(1, Math.round(delta / 60_000)) })
  if (delta < 86_400_000) return t("time.hours", { value: Math.round(delta / 3_600_000) })
  return t("time.days", { value: Math.round(delta / 86_400_000) })
}

function formatDate(value: string | undefined, t: TaskDeskTranslator): string {
  if (!value) return t("value.unknown")
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp)
    : value
}

function taskWorkspaceLabel(task: ProductTask, t: TaskDeskTranslator): string {
  return task.workspace?.mode === "worktree" ? t("workspace.worktree") : t("workspace.project")
}

function productTaskState(task: ProductTask): ProductTaskState {
  if (task.finishedAt) return "finished"
  const status = normalizeTaskStatus(task.status)
  if (status === "running" || status === "preparing" || status === "queued") return "active"
  if (status === "completed") return "review"
  if (status === "failed") return "failed"
  if (status === "cancelled") return "cancelled"
  return "draft"
}

function productTaskLabel(task: ProductTask, t: TaskDeskTranslator): string {
  return t(`state.${productTaskState(task)}` as "state.active")
}

function filterMatches(task: ProductTask, filter: TaskFilter): boolean {
  if (filter === "all") return true
  const state = productTaskState(task)
  if (filter === "active") return state === "active" || state === "draft"
  if (filter === "review") return state === "review"
  if (filter === "finished") return state === "finished"
  return state === "failed" || state === "cancelled"
}

function taskRunHistory(task: ProductTask): MachineTaskRun[] {
  if (Array.isArray(task.runs) && task.runs.length) return task.runs
  return task.run ? [task.run] : []
}

function emptyDetail(ownerKey: string | null = null, loading = false): TaskDetail {
  return { ownerKey, loading, messages: [], diff: [], todos: [], vcs: null, result: null, error: null }
}

function taskForSession(runtime: RuntimeMachine, sessionID: string): ProductTask | undefined {
  return runtime.tasks.find((task) => taskRunHistory(task).some((run) => runSessionID(run) === sessionID))
}

function pageIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden"
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Every overlay closes the same three ways: its own close control, Escape, and Android back. The
 * dialog therefore owns none of that logic — the shell's back stack does — and this wrapper only
 * guarantees the parts a dialog must not get wrong: a labelled modal region, a backdrop that does
 * not swallow clicks meant for the panel, and initial focus inside the dialog rather than left on
 * whatever button opened it.
 */
function Modal({
  label,
  className = "",
  onClose,
  children
}: {
  label: string
  className?: string
  onClose: () => void
  children: ReactNode
}) {
  const panel = useRef<HTMLElement>(null)

  useEffect(() => {
    const target = panel.current
    if (!target) return
    if (target.contains(document.activeElement)) return
    // Prefer the field the dialog exists to collect. `querySelector` matches in document order, so a
    // single list would always land on the header's close button instead of the prompt.
    const field = target.querySelector<HTMLElement>("textarea, input:not([type=hidden]), select")
    const focusable = field || target.querySelector<HTMLElement>(
      "button:not([disabled]), [tabindex]:not([tabindex='-1'])"
    )
    focusable?.focus()
  }, [])

  return (
    <div className="td3-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={panel}
        className={`td3-modal ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </section>
    </div>
  )
}

function ModalHeader({
  eyebrow,
  title,
  description,
  closeLabel,
  onClose
}: {
  eyebrow?: string
  title: string
  description?: string
  closeLabel: string
  onClose: () => void
}) {
  return (
    <header>
      <div>
        {eyebrow ? <small>{eyebrow}</small> : null}
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      <button type="button" onClick={onClose} aria-label={closeLabel} title={closeLabel}>
        <CloseIcon size={17} />
      </button>
    </header>
  )
}

function NewTaskModal({
  runtimes,
  initialMachineID,
  t,
  onClose,
  onCreated
}: {
  runtimes: RuntimeMachine[]
  initialMachineID: string
  t: TaskDeskTranslator
  onClose: () => void
  onCreated: (runtime: RuntimeMachine, task: ProductTask) => void
}) {
  const online = runtimes.filter((runtime) => runtime.state === "online" && runtime.snapshot)
  const first = online.find((runtime) => runtime.machine.id === initialMachineID) || online[0]
  const [machineID, setMachineID] = useState(first?.machine.id || "")
  const runtime = online.find((candidate) => candidate.machine.id === machineID) || first
  const agents = runtime?.agents || []
  const [projectID, setProjectID] = useState(runtime?.projects[0]?.id || "")
  const [agentID, setAgentID] = useState(agents[0]?.id || "")
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelKey, setModelKey] = useState("")
  const [modelsLoading, setModelsLoading] = useState(false)
  const [prompt, setPrompt] = useState("")
  const [isolated, setIsolated] = useState(true)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const modelGeneration = useRef(0)

  useEffect(() => {
    if (!runtime) return
    if (!runtime.projects.some((project) => project.id === projectID)) setProjectID(runtime.projects[0]?.id || "")
    if (!runtime.agents.some((agent) => agent.id === agentID)) setAgentID(runtime.agents[0]?.id || "")
  }, [machineID, runtime?.machine.id])

  useEffect(() => {
    if (!runtime || !agentID) {
      setModels([])
      setModelKey("")
      return
    }
    const generation = ++modelGeneration.current
    setModelsLoading(true)
    setError(null)
    void taskClient.listAgentModels(runtime.machine.config, agentID).then((catalog) => {
      if (generation !== modelGeneration.current) return
      setModels(catalog.models)
      const selected = catalog.models.find((model) => model.isDefault) || catalog.models[0]
      setModelKey(selected ? `${selected.providerID}|${selected.modelID}|${selected.variant || ""}` : "")
    }).catch((reason) => {
      if (generation === modelGeneration.current) {
        setModels([])
        setModelKey("")
        setError(errorText(reason))
      }
    }).finally(() => {
      if (generation === modelGeneration.current) setModelsLoading(false)
    })
  }, [runtime?.machine.id, agentID])

  const project = runtime?.projects.find((candidate) => candidate.id === projectID)
  const agent = agents.find((candidate) => candidate.id === agentID)
  const model = models.find((candidate) => `${candidate.providerID}|${candidate.modelID}|${candidate.variant || ""}` === modelKey)
  const canStart = Boolean(runtime && project && agent && prompt.trim()) && !starting && !modelsLoading

  async function start() {
    if (!runtime || !project || !agent || !canStart) return
    setStarting(true)
    setError(null)
    try {
      let task = await taskClient.createTask(runtime.machine.config, {
        projectId: project.id,
        agentId: agent.id,
        prompt: prompt.trim(),
        model: model ? { providerID: model.providerID, modelID: model.modelID, variant: model.variant } : undefined
      }) as ProductTask
      if (isolated && project.kind === "git") task = await taskClient.prepareWorktree(runtime.machine.config, task.id) as ProductTask
      task = await taskClient.launch(runtime.machine.config, task.id) as ProductTask
      onCreated(runtime, task)
      onClose()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setStarting(false)
    }
  }

  return (
    <Modal label={t("action.newTask")} className="td3-new-task" onClose={onClose}>
      <ModalHeader
        eyebrow={t("newTask.eyebrow")}
        title={t("action.newTask")}
        description={t("newTask.subtitle")}
        closeLabel={t("nav.close")}
        onClose={onClose}
      />
      <div className="td3-modal-body td3-form-grid">
        <label>
          <span>{t("field.machine")}</span>
          <select value={runtime?.machine.id || ""} onChange={(event) => setMachineID(event.target.value)}>
            {online.map((item) => <option key={item.machine.id} value={item.machine.id}>{item.snapshot?.machine.name || item.machine.name}</option>)}
          </select>
        </label>
        <label>
          <span>{t("field.project")}</span>
          <select value={projectID} onChange={(event) => setProjectID(event.target.value)}>
            {runtime?.projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>
          <span>{t("field.agent")}</span>
          <select value={agentID} onChange={(event) => setAgentID(event.target.value)}>
            {agents.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label>
          <span>{t("field.model")}</span>
          <select value={modelKey} onChange={(event) => setModelKey(event.target.value)} disabled={modelsLoading}>
            {modelsLoading ? <option value="">{t("model.loading")}</option> : null}
            {!modelsLoading && models.length === 0 ? <option value="">{t("model.agentDefault")}</option> : null}
            {models.map((item) => {
              const key = `${item.providerID}|${item.modelID}|${item.variant || ""}`
              return <option key={key} value={key}>{item.modelName}{item.variant ? ` (${item.variant})` : ""}</option>
            })}
          </select>
        </label>
        <label className="td3-form-wide">
          <span>{t("field.task")}</span>
          <textarea rows={7} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t("newTask.promptPlaceholder")} />
        </label>
        <label className="td3-workspace-choice td3-form-wide">
          <input type="checkbox" checked={isolated} onChange={(event) => setIsolated(event.target.checked)} disabled={project?.kind !== "git"} />
          <span>
            <strong>{t("worktree.title")}</strong>
            <small>{project?.kind === "git" ? t("worktree.recommended") : t("worktree.notGit")}</small>
          </span>
        </label>
        {!isolated && project?.kind === "git" ? <div className="td3-inline-warning td3-form-wide">{t("worktree.warning")}</div> : null}
        {online.length === 0 ? <div className="td3-inline-warning td3-form-wide">{t("newTask.noMachine")}</div> : null}
        {runtime && runtime.projects.length === 0 ? <div className="td3-inline-warning td3-form-wide">{t("newTask.noProject")}</div> : null}
        {error ? <div className="td3-inline-error td3-form-wide" role="alert">{error}</div> : null}
      </div>
      <footer>
        <button type="button" className="td3-button" onClick={onClose}>{t("action.cancel")}</button>
        <button type="button" className="td3-button primary" disabled={!canStart} onClick={() => void start()}>
          {starting ? <LoadingIcon size={15} /> : <PlusIcon size={15} />}
          {starting ? t("newTask.startingTask") : t("newTask.startTask")}
        </button>
      </footer>
    </Modal>
  )
}

function ContinueTaskModal({
  record,
  t,
  onClose,
  onContinued
}: {
  record: TaskRecord
  t: TaskDeskTranslator
  onClose: () => void
  onContinued: (task: ProductTask) => void
}) {
  const [prompt, setPrompt] = useState("")
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!prompt.trim() || working) return
    setWorking(true)
    setError(null)
    try {
      onContinued(await taskClient.continueTask(record.runtime.machine.config, record.task.id, prompt.trim()) as ProductTask)
      onClose()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setWorking(false)
    }
  }

  return (
    <Modal label={t("continue.title")} className="td3-continue-modal" onClose={onClose}>
      <ModalHeader
        eyebrow={t("continue.eyebrow")}
        title={t("continue.title")}
        description={taskTitle(record.task)}
        closeLabel={t("nav.close")}
        onClose={onClose}
      />
      <div className="td3-modal-body">
        <label className="td3-stack-field">
          <span>{t("continue.prompt")}</span>
          <textarea rows={7} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t("continue.placeholder")} />
        </label>
        {error ? <div className="td3-inline-error" role="alert">{error}</div> : null}
      </div>
      <footer>
        <button type="button" className="td3-button" onClick={onClose}>{t("action.cancel")}</button>
        <button type="button" className="td3-button primary" disabled={!prompt.trim() || working} onClick={() => void submit()}>
          {working ? <LoadingIcon size={15} /> : null}
          {working ? t("continue.starting") : t("continue.start")}
        </button>
      </footer>
    </Modal>
  )
}

/**
 * A previous Run stays reviewable product history. The shell already knows which machine, task and
 * agent own the Run, so this loads one transcript on demand instead of re-listing every machine's
 * tasks to work out where the Session came from, and it adds no polling.
 */
function RunReviewModal({
  target,
  t,
  onClose
}: {
  target: RunReviewTarget
  t: TaskDeskTranslator
  onClose: () => void
}) {
  const [messages, setMessages] = useState<MessageEnvelope[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const { record, run, sequence } = target
  const sessionID = runSessionID(run)
  const agent = record.runtime.agents.find((candidate) => candidate.id === (run.agentId || record.task.agentId))

  useEffect(() => {
    if (!sessionID) return
    if (!agent) {
      setLoading(false)
      setError(t("runs.agentUnavailable"))
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    const directory = run.directory || record.task.workspace.path
    void api.loadMessages(configForAgent(record.runtime, agent), sessionID, directory).then((loaded) => {
      if (!cancelled) setMessages(loaded)
    }).catch((reason) => {
      if (!cancelled) setError(errorText(reason))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [sessionID, agent?.id])

  return (
    <Modal label={t("runs.archiveTitle", { sequence })} className="td3-run-review" onClose={onClose}>
      <ModalHeader
        eyebrow={t("runs.archiveEyebrow")}
        title={t("runs.archiveTitle", { sequence })}
        description={run.prompt || record.task.prompt}
        closeLabel={t("runs.archiveClose")}
        onClose={onClose}
      />
      <div className="td3-run-review-meta">
        <span><small>{t("detail.session")}</small><b>{sessionID || t("value.unknown")}</b></span>
        <span><small>{t("field.agent")}</small><b>{agent?.label || run.agentId || record.task.agentId}</b></span>
        <span><small>{t("detail.machine")}</small><b>{record.runtime.snapshot?.machine.name || record.runtime.machine.name}</b></span>
        <span><small>{t("column.status")}</small><b>{run.finishedAt ? t("runs.statusCompleted") : run.status || t("runs.statusRecorded")}</b></span>
      </div>
      <div className="td3-modal-body td3-conversation">
        {loading ? <div className="td3-detail-loading"><LoadingIcon size={22} /><strong>{t("runs.archiveLoading")}</strong></div> : null}
        {!loading && error ? <div className="td3-inline-error" role="alert">{error}</div> : null}
        {!loading && !error && messages.length === 0 ? <div className="td3-empty-state"><span>{t("conversation.empty")}</span></div> : null}
        {!loading && !error ? messages.map((message) => (
          <article key={message.info.id} className={message.info.role === "user" ? "user" : "assistant"}>
            <header><strong>{message.info.role === "user" ? t("conversation.you") : agent?.label || t("conversation.agent")}</strong></header>
            <TaskDeskMessageContent message={message} />
          </article>
        )) : null}
      </div>
      <footer>
        <button type="button" className="td3-button" onClick={onClose}>{t("nav.close")}</button>
      </footer>
    </Modal>
  )
}

function SettingsModal({
  language,
  theme,
  t,
  onLanguage,
  onTheme,
  onClose
}: {
  language: LanguageCode
  theme: ThemePreference
  t: TaskDeskTranslator
  onLanguage: (language: LanguageCode) => void
  onTheme: (theme: ThemePreference) => void
  onClose: () => void
}) {
  const themeLabel: Record<ThemePreference, string> = {
    system: t("settings.themeSystem"),
    light: t("settings.themeLight"),
    dark: t("settings.themeDark")
  }

  return (
    <Modal label={t("settings.title")} className="td3-settings-modal" onClose={onClose}>
      <ModalHeader
        eyebrow={t("settings.eyebrow")}
        title={t("settings.title")}
        description={t("settings.subtitle")}
        closeLabel={t("nav.close")}
        onClose={onClose}
      />
      <div className="td3-modal-body td3-settings-body">
        <fieldset className="td3-settings-group">
          <legend>{t("settings.theme")}</legend>
          <div className="td3-choice-row" role="radiogroup" aria-label={t("settings.theme")}>
            {themePreferences.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={theme === option}
                className={theme === option ? "active" : ""}
                onClick={() => onTheme(option)}
              >
                {themeLabel[option]}
              </button>
            ))}
          </div>
          <p className="td3-settings-hint">{t("settings.themeHint")}</p>
        </fieldset>

        <fieldset className="td3-settings-group">
          <legend>{t("settings.language")}</legend>
          <div className="td3-choice-row" role="radiogroup" aria-label={t("settings.language")}>
            {languageOptions.map((option) => (
              <button
                key={option.code}
                type="button"
                role="radio"
                aria-checked={language === option.code}
                lang={option.code}
                className={language === option.code ? "active" : ""}
                onClick={() => onLanguage(option.code)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="td3-settings-hint">{t("settings.languageHint")}</p>
        </fieldset>
      </div>
      <footer>
        <button type="button" className="td3-button primary" onClick={onClose}>{t("settings.done")}</button>
      </footer>
    </Modal>
  )
}

function MoreSheet({
  items,
  t,
  onClose
}: {
  items: Array<{ id: string; label: string; icon: ReactNode; active?: boolean; onSelect: () => void }>
  t: TaskDeskTranslator
  onClose: () => void
}) {
  return (
    <Modal label={t("nav.moreTitle")} className="td3-more-sheet" onClose={onClose}>
      <ModalHeader
        title={t("nav.moreTitle")}
        description={t("nav.moreHint")}
        closeLabel={t("nav.close")}
        onClose={onClose}
      />
      <div className="td3-modal-body td3-more-list">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.active ? "active" : ""}
            aria-current={item.active ? "page" : undefined}
            onClick={() => {
              item.onSelect()
              onClose()
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </Modal>
  )
}

function QuestionAttentionCard({
  item,
  t,
  onResolved,
  onOpenSession,
  onError
}: {
  item: Extract<AttentionItem, { type: "question" }>
  t: TaskDeskTranslator
  onResolved: () => void
  onOpenSession: (runtime: RuntimeMachine, sessionID: string) => void
  onError: (message: string) => void
}) {
  const [answers, setAnswers] = useState<Record<number, string[]>>({})
  const [sending, setSending] = useState(false)
  const config = configForAgent(item.runtime, item.agent)

  async function reply() {
    if (sending) return
    setSending(true)
    try {
      const payload = item.request.questions.map((_question, index) => answers[index] || [])
      await api.replyQuestion(config, item.request.id, payload, item.task?.workspace.path)
      onResolved()
    } catch (reason) {
      onError(errorText(reason))
    } finally {
      setSending(false)
    }
  }

  return (
    <article className="td3-attention-card">
      <header>
        <span className="td3-attention-icon">?</span>
        <div>
          <strong>{t("needs.question")}</strong>
          <small>{item.task ? taskTitle(item.task) : item.agent.label}</small>
        </div>
        <span className="td3-attention-origin">{item.runtime.snapshot?.machine.name || item.runtime.machine.name}</span>
      </header>
      {item.request.questions.map((question, index) => (
        <div className="td3-question" key={`${item.request.id}-${index}`}>
          <p>{question.question}</p>
          <div>
            {question.options.map((option) => {
              const selected = answers[index]?.includes(option.label) || false
              return (
                <button
                  type="button"
                  key={option.label}
                  aria-pressed={selected}
                  className={selected ? "selected" : ""}
                  onClick={() => setAnswers((current) => ({
                    ...current,
                    [index]: question.multiple
                      ? (selected ? (current[index] || []).filter((value) => value !== option.label) : [...(current[index] || []), option.label])
                      : [option.label]
                  }))}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <footer>
        <button type="button" className="td3-link-button" onClick={() => onOpenSession(item.runtime, item.request.sessionID)}>
          {t("action.openSession")}
        </button>
        <button type="button" className="td3-button primary" disabled={sending} onClick={() => void reply()}>
          {sending ? t("action.sending") : t("action.answer")}
        </button>
      </footer>
    </article>
  )
}

function PermissionAttentionCard({
  item,
  t,
  onResolved,
  onOpenSession,
  onError
}: {
  item: Extract<AttentionItem, { type: "permission" }>
  t: TaskDeskTranslator
  onResolved: () => void
  onOpenSession: (runtime: RuntimeMachine, sessionID: string) => void
  onError: (message: string) => void
}) {
  const [sending, setSending] = useState(false)

  async function reply(decision: "once" | "always" | "reject") {
    if (sending) return
    setSending(true)
    try {
      await api.replyPermission(configForAgent(item.runtime, item.agent), item.request.id, decision, item.task?.workspace.path)
      onResolved()
    } catch (reason) {
      onError(errorText(reason))
    } finally {
      setSending(false)
    }
  }

  return (
    <article className="td3-attention-card">
      <header>
        <span className="td3-attention-icon warning">!</span>
        <div>
          <strong>{t("needs.permission")}</strong>
          <small>{item.task ? taskTitle(item.task) : item.agent.label}</small>
        </div>
        <span className="td3-attention-origin">{item.runtime.snapshot?.machine.name || item.runtime.machine.name}</span>
      </header>
      <p>{item.request.permission}</p>
      {item.request.patterns?.length ? <code>{item.request.patterns.join(", ")}</code> : null}
      <footer>
        <button type="button" className="td3-link-button" onClick={() => onOpenSession(item.runtime, item.request.sessionID)}>
          {t("action.openSession")}
        </button>
        <button type="button" className="td3-button danger" disabled={sending} onClick={() => void reply("reject")}>{t("action.reject")}</button>
        <button type="button" className="td3-button" disabled={sending} onClick={() => void reply("once")}>{t("action.once")}</button>
        <button type="button" className="td3-button primary" disabled={sending} onClick={() => void reply("always")}>{t("action.always")}</button>
      </footer>
    </article>
  )
}

export function TaskDeskV3Unified({ machines, activeMachineID, onActiveMachineID, onPersistMachines, onManageMachines, legacyView }: Props) {
  const [view, setView] = useState<TaskDeskView>("tasks")
  const [runtimes, setRuntimes] = useState<RuntimeMachine[]>([])
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState<TaskFilter>("all")
  const [query, setQuery] = useState("")
  const [machineScope, setMachineScope] = useState(activeMachineID || "all")
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailTab, setDetailTab] = useState<DetailTab>("review")
  const [detail, setDetail] = useState<TaskDetail>(() => emptyDetail())
  const [attention, setAttention] = useState<AttentionItem[]>([])
  const [attentionError, setAttentionError] = useState<string | null>(null)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [continueOpen, setContinueOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [runReview, setRunReview] = useState<RunReviewTarget | null>(null)
  const [sessionFocusRequest, setSessionFocusRequest] = useState<SessionFocusRequest | null>(null)
  const [sessionPane, setSessionPane] = useState<SessionPane>("list")
  const [newSessionRequest, setNewSessionRequest] = useState(0)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [language, setLanguage] = useState<LanguageCode>(loadLanguage)
  const [theme, setTheme] = useState<ThemePreference>(loadThemePreference)
  const refreshInFlight = useRef(false)
  const detailInFlight = useRef(false)
  const detailGeneration = useRef(0)
  const detailHeading = useRef<HTMLHeadingElement>(null)

  const isMobile = useMediaQuery(TASKDESK_MOBILE_QUERY)
  const t = useMemo(() => createTaskDeskTranslator(language), [language])

  useEffect(() => {
    const sync = () => {
      setLanguage(loadLanguage())
      setTheme(loadThemePreference())
    }
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, sync)
    return () => window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, sync)
  }, [])

  useEffect(() => {
    if (activeMachineID && machines.some((machine) => machine.id === activeMachineID)) setMachineScope(activeMachineID)
  }, [activeMachineID, machines])

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    setRefreshing(true)
    try {
      const next = await Promise.all(machines.map(async (machine): Promise<RuntimeMachine> => {
        try {
          const snapshot = await discoverMachine(machine.config)
          if (!snapshot) return { key: machine.id, machine, snapshot: null, projects: [], tasks: [], agents: [], state: "offline", error: "Not a Harness machine daemon" }
          const [projects, tasks] = await Promise.all([
            taskClient.listProjects(machine.config).catch(() => []),
            taskClient.listTasks(machine.config).catch(() => [])
          ])
          return { key: machine.id, machine, snapshot, projects, tasks: sortTasksByActivity(tasks) as ProductTask[], agents: selectableMachineAgents(snapshot), state: "online" }
        } catch (reason) {
          return { key: machine.id, machine, snapshot: null, projects: [], tasks: [], agents: [], state: "offline", error: errorText(reason) }
        }
      }))
      setRuntimes(next)

      const nextAttention = (await Promise.all(next.filter((runtime) => runtime.state === "online").flatMap((runtime) => runtime.agents.map(async (agent) => {
        const config = configForAgent(runtime, agent)
        const [questions, permissions] = await Promise.all([
          api.loadQuestions(config).catch(() => []),
          api.loadPermissions(config).catch(() => [])
        ])
        return [
          ...permissions.map((request): AttentionItem => ({ key: `${runtime.key}|${agent.id}|permission|${request.id}`, type: "permission", runtime, agent, request, task: taskForSession(runtime, request.sessionID) })),
          ...questions.map((request): AttentionItem => ({ key: `${runtime.key}|${agent.id}|question|${request.id}`, type: "question", runtime, agent, request, task: taskForSession(runtime, request.sessionID) }))
        ]
      })))).flat()
      setAttention(nextAttention)

      // A Task lives on its machine, so a single failed discovery empties that machine's list for
      // one cycle. Dropping the selection on that would close the Task the user is reading and lose
      // their place, so an unreachable owner keeps the selection and only a machine that answered
      // without the Task can clear it.
      const records = next.flatMap((runtime) => runtime.tasks.map((task) => ({ key: `${runtime.key}|${task.id}`, runtime, task })))
      setSelectedKey((current) => {
        if (!current) return current
        if (records.some((record) => record.key === current)) return current
        const owner = next.find((runtime) => current.startsWith(`${runtime.key}|`))
        return owner && owner.state !== "online" ? current : null
      })
      setLoaded(true)
    } finally {
      refreshInFlight.current = false
      setRefreshing(false)
    }
  }, [machines])

  useEffect(() => {
    void refresh()
    if (view === "sessions" || view === "classic") return
    const timer = window.setInterval(() => {
      if (pageIsVisible()) void refresh()
    }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [refresh, view])

  const records = useMemo(() => runtimes.flatMap((runtime) => runtime.tasks.map((task) => ({ key: `${runtime.key}|${task.id}`, runtime, task }))), [runtimes])
  const selected = records.find((record) => record.key === selectedKey) || null

  const loadDetail = useCallback(async (record: TaskRecord, tab: DetailTab, silent = false) => {
    if (detailInFlight.current && silent) return
    detailInFlight.current = true
    const generation = ++detailGeneration.current
    if (!silent) setDetail(emptyDetail(record.key, true))
    const agent = record.runtime.agents.find((candidate) => candidate.id === record.task.agentId)
    const sessionID = runSessionID(record.task.run)
    try {
      const resultPromise = taskClient.inspectResult(record.runtime.machine.config, record.task.id).catch(() => null)
      if (!agent || !sessionID) {
        const result = await resultPromise
        if (generation === detailGeneration.current) setDetail({ ...emptyDetail(record.key), result })
        return
      }
      const config = configForAgent(record.runtime, agent)
      const directory = record.task.run?.directory || record.task.workspace.path
      const needsMessages = tab === "review" || tab === "conversation"
      const needsDiff = tab === "review" || tab === "diff"
      const needsTodos = tab === "review"
      const needsVcs = tab === "review"
      const [messages, diff, todos, vcs, result] = await Promise.all([
        needsMessages ? api.loadMessages(config, sessionID, directory).catch(() => []) : Promise.resolve([] as MessageEnvelope[]),
        needsDiff ? api.loadDiff(config, sessionID, directory).catch(() => []) : Promise.resolve([] as DiffFile[]),
        needsTodos ? api.loadTodo(config, sessionID, directory).catch(() => []) : Promise.resolve([] as TodoItem[]),
        needsVcs ? api.loadVcs(config, directory).catch(() => null) : Promise.resolve(null as VcsStatus | null),
        resultPromise
      ])
      if (generation !== detailGeneration.current) return
      setDetail({ ownerKey: record.key, loading: false, messages, diff, todos, vcs, result, error: null })
    } catch (reason) {
      if (generation === detailGeneration.current) setDetail({ ...emptyDetail(record.key), error: errorText(reason) })
    } finally {
      detailInFlight.current = false
    }
  }, [])

  // Which Task is open, which tab it shows and whether the pane exists at all are the only reasons
  // to blank the detail and show a spinner. A running Task changes `updatedAt` on every poll, and
  // treating that as a reason to reload from scratch replaced the Review, Conversation or Diff the
  // user was reading with "Loading Task…" every few seconds and threw away their scroll position.
  const selectedKeyForDetail = selected?.key ?? null
  const detailVisible = view === "tasks" && Boolean(selected) && detailOpen

  useEffect(() => {
    detailGeneration.current += 1
    detailInFlight.current = false
    if (view !== "tasks" || !selected || !detailOpen) {
      setDetail(emptyDetail())
      return
    }
    setDetail(emptyDetail(selected.key, true))
    void loadDetail(selected, detailTab, false)
    const timer = window.setInterval(() => {
      if (pageIsVisible()) void loadDetail(selected, detailTab, true)
    }, DETAIL_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [selectedKeyForDetail, detailOpen, detailTab, view, loadDetail])

  const selectedUpdatedAt = selected?.task.updatedAt
  useEffect(() => {
    if (!detailVisible || !selected) return
    void loadDetail(selected, detailTab, true)
  }, [selectedUpdatedAt])

  const scopedRuntimes = useMemo(
    () => runtimes.filter((runtime) => machineScope === "all" || runtime.machine.id === machineScope),
    [runtimes, machineScope]
  )
  const scopedRecords = useMemo(() => records.filter((record) => machineScope === "all" || record.runtime.machine.id === machineScope), [records, machineScope])
  const scopedAttention = useMemo(
    () => attention.filter((item) => machineScope === "all" || item.runtime.machine.id === machineScope),
    [attention, machineScope]
  )
  const filteredRecords = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return scopedRecords.filter((record) => {
      if (!filterMatches(record.task, filter)) return false
      if (!needle) return true
      return [taskTitle(record.task), record.task.prompt, record.task.project?.name, agentLabel(record.runtime.agents, record.task.agentId), modelLabel(record.task), record.runtime.snapshot?.machine.name, record.runtime.machine.name].some((value) => value?.toLowerCase().includes(needle))
    })
  }, [scopedRecords, query, filter])

  const counts = useMemo(() => ({
    tasks: scopedRecords.length,
    active: scopedRecords.filter((record) => productTaskState(record.task) === "active").length,
    review: scopedRecords.filter((record) => productTaskState(record.task) === "review").length,
    finished: scopedRecords.filter((record) => productTaskState(record.task) === "finished").length,
    machines: scopedRuntimes.filter((runtime) => runtime.state === "online").length,
    agents: scopedRuntimes.reduce((sum, runtime) => sum + runtime.agents.length, 0)
  }), [scopedRecords, scopedRuntimes])

  const scopeRuntime = machineScope === "all" ? null : scopedRuntimes[0] || null
  const anyOnline = runtimes.some((runtime) => runtime.state === "online")
  const scopeOnline = machineScope === "all" ? counts.machines > 0 : scopeRuntime?.state === "online"
  // With every machine in scope the strip must describe the fleet, not whichever machine happens to
  // be first: showing one machine's harnesses under the label "All machines" reads as a fact about
  // the fleet and is wrong as soon as a second machine exposes something different.
  const stripAgents = useMemo(() => {
    const seen = new Set<string>()
    const unique: MachineAgentHost[] = []
    for (const runtime of scopedRuntimes) {
      for (const agent of runtime.agents) {
        const identity = machineScope === "all" ? agent.backend : agent.id
        if (seen.has(identity)) continue
        seen.add(identity)
        unique.push(agent)
      }
    }
    return unique
  }, [scopedRuntimes, machineScope])

  const selectedAgent = selected?.runtime.agents.find((agent) => agent.id === selected.task.agentId)
  const selectedSessionID = selected ? runSessionID(selected.task.run) : null
  const detailReady = Boolean(selected && detail.ownerKey === selected.key && !detail.loading)
  const summary = selected?.task.run?.outcome
    || (detailReady && selected
      ? assistantTerminalTextForPrompt(detail.messages, selected.task.run?.prompt || selected.task.prompt)
      : "")
  const sessionProfiles = useMemo(
    () => machineScope === "all" ? machines : machines.filter((machine) => machine.id === machineScope),
    [machines, machineScope]
  )
  const detailChangeCount = detail.diff.length || detail.result?.changeCount || 0

  async function refreshAndReselect(taskID?: string, machineID?: string, openDetail = true) {
    await refresh()
    if (taskID && machineID) {
      setSelectedKey(`${machineID}|${taskID}`)
      if (openDetail) setDetailOpen(true)
    }
  }

  function openTask(record: TaskRecord, tab: DetailTab = "review") {
    setSelectedKey(record.key)
    setDetailTab(tab)
    setDetailOpen(true)
    setActionError(null)
  }

  function closeTaskDetail() {
    setDetailOpen(false)
    setActionError(null)
  }

  function goToView(next: TaskDeskView) {
    setView(next)
    // Sessions is a master/detail stack on a phone, so arriving from the navigation must always land
    // on the list. Only an explicit Open Session drills straight into a conversation.
    if (next === "sessions") setSessionPane("list")
  }

  function openNativeSession(runtime: RuntimeMachine, sessionID: string) {
    setMachineScope(runtime.machine.id)
    onActiveMachineID(runtime.machine.id)
    setSessionFocusRequest((current) => ({ sessionID, requestID: (current?.requestID ?? 0) + 1 }))
    setSessionPane("detail")
    setView("sessions")
  }

  useEffect(() => {
    if (!detailVisible || !isMobile) return
    detailHeading.current?.focus()
  }, [detailVisible, isMobile, selectedKeyForDetail])

  // One ordered stack for Escape, Android's hardware back and the Android edge-swipe-back gesture,
  // which the webview delivers as the same back event. Deepest surface first, so back never skips a
  // layer and never leaves the app while something is still open.
  useBackNavigation([
    () => { if (!runReview) return false; setRunReview(null); return true },
    () => { if (!moreOpen) return false; setMoreOpen(false); return true },
    () => { if (!settingsOpen) return false; setSettingsOpen(false); return true },
    () => { if (!continueOpen) return false; setContinueOpen(false); return true },
    () => { if (!newTaskOpen) return false; setNewTaskOpen(false); return true },
    () => { if (view !== "sessions" || sessionPane !== "detail" || !isMobile) return false; setSessionPane("list"); return true },
    () => { if (view !== "tasks" || !detailOpen) return false; closeTaskDetail(); return true },
    () => { if (view === "tasks") return false; goToView("tasks"); return true }
  ])

  async function finishSelected() {
    if (!selected || actionBusy) return
    setActionBusy(true)
    setActionError(null)
    try {
      const response = await taskClient.finish(selected.runtime.machine.config, selected.task.id)
      await refreshAndReselect(response.task.id, selected.runtime.machine.id)
    } catch (reason) {
      setActionError(errorText(reason))
    } finally {
      setActionBusy(false)
    }
  }

  async function cleanupSelected() {
    if (!selected || actionBusy) return
    if (!window.confirm(t("cleanup.confirm"))) return
    setActionBusy(true)
    setActionError(null)
    try {
      const response = await taskClient.cleanupWorkspace(selected.runtime.machine.config, selected.task.id)
      await refreshAndReselect(response.task.id, selected.runtime.machine.id)
    } catch (reason) {
      setActionError(errorText(reason))
    } finally {
      setActionBusy(false)
    }
  }

  function applyTheme(next: ThemePreference) {
    setTheme(next)
    persistThemePreference(next)
  }

  function applyLanguage(next: LanguageCode) {
    setLanguage(next)
    persistLanguage(next)
  }

  const navItems: Array<{ view: TaskDeskView; label: string; icon: ReactNode; count?: number; attention?: boolean }> = [
    { view: "overview", label: t("nav.overview"), icon: <SparkIcon size={16} /> },
    { view: "tasks", label: t("nav.tasks"), icon: <TaskListIcon size={16} />, count: counts.tasks },
    { view: "sessions", label: t("nav.sessions"), icon: <ChatIcon size={16} /> },
    { view: "projects", label: t("nav.projects"), icon: <FolderIcon size={16} /> },
    { view: "needs", label: t("nav.needs"), icon: <AlertIcon size={16} />, count: attention.length, attention: true },
    { view: "agents", label: t("nav.agents"), icon: <AgentIcon size={16} /> },
    { view: "machines", label: t("nav.machines"), icon: <ServerIcon size={16} /> }
  ]
  // A phone gets four destinations plus More. Everything else stays reachable through the sheet
  // rather than being hidden by an `nth-child` rule, which is how Machines and Manage machines
  // became unreachable on a phone once the bottom bar ran out of room.
  const mobilePrimary: TaskDeskView[] = ["tasks", "sessions", "needs", "projects"]
  const primaryNav = isMobile ? navItems.filter((item) => mobilePrimary.includes(item.view)) : navItems
  const overflowNav = isMobile ? navItems.filter((item) => !mobilePrimary.includes(item.view)) : []

  const navButton = (item: typeof navItems[number]) => (
    <button
      key={item.view}
      type="button"
      className={view === item.view ? "active" : ""}
      aria-current={view === item.view ? "page" : undefined}
      onClick={() => goToView(item.view)}
    >
      {item.icon}
      <span className="td3-nav-label">{item.label}</span>
      {item.count ? <b className={item.attention ? "attention" : undefined}>{item.count}</b> : null}
    </button>
  )

  const moreItems = [
    ...overflowNav.map((item) => ({
      id: item.view,
      label: item.label,
      icon: item.icon,
      active: view === item.view,
      onSelect: () => goToView(item.view)
    })),
    { id: "settings", label: t("nav.settings"), icon: <SettingsIcon size={16} />, onSelect: () => setSettingsOpen(true) },
    { id: "manage", label: t("nav.manageMachines"), icon: <ServerIcon size={16} />, onSelect: onManageMachines },
    { id: "classic", label: t("nav.classic"), icon: <ChatIcon size={16} />, active: view === "classic", onSelect: () => goToView("classic") }
  ]

  const nav = (
    <aside className="td3-sidebar">
      <div className="td3-brand">
        <span>TD</span>
        <div><strong>{t("brand.name")}</strong><small>{t("brand.product")}</small></div>
      </div>
      <nav aria-label={t("brand.name")}>
        {primaryNav.map(navButton)}
        {isMobile ? (
          <button type="button" className={moreOpen ? "active" : ""} onClick={() => setMoreOpen(true)}>
            <MoreVerticalIcon size={16} />
            <span className="td3-nav-label">{t("nav.more")}</span>
          </button>
        ) : null}
      </nav>
      <div className="td3-sidebar-bottom">
        <button type="button" onClick={() => setSettingsOpen(true)}><SettingsIcon size={15} /><span className="td3-nav-label">{t("nav.settings")}</span></button>
        <button type="button" className={view === "classic" ? "active" : ""} aria-current={view === "classic" ? "page" : undefined} onClick={() => goToView("classic")}>
          <ChatIcon size={15} /><span className="td3-nav-label">{t("nav.classic")}</span>
        </button>
        <button type="button" onClick={onManageMachines}><ServerIcon size={15} /><span className="td3-nav-label">{t("nav.manageMachines")}</span></button>
      </div>
    </aside>
  )

  // The primary action follows the surface: Tasks-side views create a Task, the Sessions view
  // creates a Session. Both are always rendered — the label collapses to an icon at narrow widths
  // instead of the control being removed, which is what used to make New Task unreachable on every
  // viewport below 1220px and New Session unreachable everywhere but a phone.
  const primaryAction = view === "classic" ? null : view === "sessions" ? (
    <button
      type="button"
      className="td3-button primary td3-topbar-primary"
      onClick={() => setNewSessionRequest((value) => value + 1)}
      title={t("action.newSession")}
      aria-label={t("action.newSession")}
    >
      <PlusIcon size={15} />
      <span className="td3-button-label">{t("action.newSession")}</span>
    </button>
  ) : (
    <button
      type="button"
      className="td3-button primary td3-topbar-primary"
      onClick={() => setNewTaskOpen(true)}
      disabled={!anyOnline}
      title={t("action.newTask")}
      aria-label={t("action.newTask")}
    >
      <PlusIcon size={15} />
      <span className="td3-button-label">{t("action.newTask")}</span>
    </button>
  )

  const topbar = (
    <header className="td3-topbar td3-topbar-unified">
      <div className="td3-machine-selector">
        <ServerIcon size={16} />
        <select
          value={machineScope}
          aria-label={t("machine.scopeLabel")}
          onChange={(event) => {
            const value = event.target.value
            setMachineScope(value)
            if (value !== "all") onActiveMachineID(value)
          }}
        >
          <option value="all">{t("machine.all")}</option>
          {runtimes.map((runtime) => <option key={runtime.machine.id} value={runtime.machine.id}>{runtime.snapshot?.machine.name || runtime.machine.name}</option>)}
        </select>
        <span className={`td3-online-dot ${scopeOnline ? "online" : "offline"}`} />
        <small>{machineScope === "all"
          ? t("machine.onlineCount", { online: counts.machines, total: runtimes.length })
          : scopeOnline ? t("machine.online") : t("machine.offline")}</small>
      </div>
      <div className="td3-agent-strip">
        {stripAgents.slice(0, 5).map((agent) => <HarnessBadge key={`${agent.backend}|${agent.id}`} agent={agent} />)}
        {stripAgents.length > 5 ? <span className="td3-agent-overflow">+{stripAgents.length - 5}</span> : null}
      </div>
      {view === "sessions" ? (
        <div className="td3-view-context">
          <ChatIcon size={16} />
          <div><strong>{t("nav.sessions")}</strong><small>{t("sessions.viewHint")}</small></div>
        </div>
      ) : (
        <div className="td3-global-search">
          <SearchIcon size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("search.placeholder")} aria-label={t("search.placeholder")} />
        </div>
      )}
      <div className="td3-topbar-actions">
        <button
          type="button"
          className="td3-button td3-icon-button"
          onClick={() => void refresh()}
          disabled={refreshing}
          title={t("action.refresh")}
          aria-label={t("action.refresh")}
        >
          {refreshing ? <LoadingIcon size={15} /> : <RefreshIcon size={15} />}
        </button>
        {primaryAction}
      </div>
    </header>
  )

  const outsideScope = attention.length - scopedAttention.length

  return (
    <div className="td3-shell td3-shell-unified">
      {nav}
      <div className="td3-workspace">
        {topbar}

        {view === "overview" ? (
          <main className="td3-overview">
            <section className="td3-page-heading">
              <div><small>{t("overview.eyebrow")}</small><h1>{t("overview.title")}</h1><p>{t("overview.subtitle")}</p></div>
            </section>
            <section className="td3-kpis">
              <article><span>{t("kpi.working")}</span><strong>{counts.active}</strong><small>{t("kpi.workingHint")}</small></article>
              <article><span>{t("kpi.review")}</span><strong>{counts.review}</strong><small>{t("kpi.reviewHint")}</small></article>
              <article><span>{t("nav.needs")}</span><strong>{scopedAttention.length}</strong><small>{t("kpi.needsHint")}</small></article>
              <article><span>{t("kpi.machines")}</span><strong>{counts.machines}/{scopedRuntimes.length}</strong><small>{t("kpi.machinesHint")}</small></article>
            </section>
            <div className="td3-overview-grid">
              <section className="td3-panel">
                <header>
                  <div><h2>{t("panel.recentTasks")}</h2><p>{t("panel.recentTasksHint")}</p></div>
                  <button type="button" onClick={() => goToView("tasks")}>{t("action.viewAll")}</button>
                </header>
                {scopedRecords.length === 0 ? <div className="td3-empty-mini">{t("panel.emptyRecentTasks")}</div> : scopedRecords.slice(0, 6).map((record) => (
                  <button type="button" className="td3-recent-task" key={record.key} onClick={() => { goToView("tasks"); openTask(record) }}>
                    <span className={`td3-status-dot td3-status-${productTaskState(record.task)}`} />
                    <div><strong>{taskTitle(record.task)}</strong><small>{record.task.project.name} · {agentLabel(record.runtime.agents, record.task.agentId)}</small></div>
                    <time>{formatRelative(record.task.updatedAt, t)}</time>
                  </button>
                ))}
              </section>
              <section className="td3-panel">
                <header>
                  <div><h2>{t("nav.needs")}</h2><p>{t("panel.needsYouHint")}</p></div>
                  <button type="button" onClick={() => goToView("needs")}>{t("action.viewAll")}</button>
                </header>
                {scopedAttention.length === 0 ? <div className="td3-empty-mini">{t("needs.emptyMini")}</div> : scopedAttention.slice(0, 5).map((item) => (
                  <button type="button" className="td3-attention-row" key={item.key} onClick={() => goToView("needs")}>
                    <span>{item.type === "permission" ? "!" : "?"}</span>
                    <div><strong>{item.type === "permission" ? t("needs.permission") : t("needs.question")}</strong><small>{item.task ? taskTitle(item.task) : item.agent.label}</small></div>
                  </button>
                ))}
              </section>
            </div>
          </main>
        ) : null}

        {view === "tasks" ? (
          <main className={`td3-tasks-layout td3-tasks-layout-unified${detailOpen ? " detail-open" : ""}`}>
            <section className="td3-task-list-pane">
              <div className="td3-page-heading compact">
                <div><small>{t("tasks.eyebrow")}</small><h1>{t("nav.tasks")}</h1><p>{t("tasks.subtitle")}</p></div>
              </div>
              <div className="td3-filters" role="tablist" aria-label={t("column.status")}>
                {(["all", "active", "review", "finished", "failed"] as TaskFilter[]).map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="tab"
                    aria-selected={filter === item}
                    className={filter === item ? "active" : ""}
                    onClick={() => setFilter(item)}
                  >
                    {t(`filter.${item}` as "filter.all")}
                    <span>{item === "all" ? scopedRecords.length : scopedRecords.filter((record) => filterMatches(record.task, item)).length}</span>
                  </button>
                ))}
              </div>
              <div className="td3-task-table-head" aria-hidden="true">
                <span>{t("column.task")}</span>
                <span>{t("column.project")}</span>
                <span>{t("column.agent")}</span>
                <span>{t("column.model")}</span>
                <span>{t("column.workspace")}</span>
                <span>{t("column.status")}</span>
                <span>{t("column.activity")}</span>
              </div>
              <div className="td3-task-list">
                {!loaded ? (
                  <div className="td3-detail-loading"><LoadingIcon size={22} /><strong>{t("tasks.loading")}</strong></div>
                ) : !anyOnline && runtimes.length > 0 ? (
                  <div className="td3-empty-state">
                    <strong>{t("tasks.offlineTitle")}</strong>
                    <span>{t("tasks.offlineHint")}</span>
                    <button type="button" className="td3-button" onClick={() => void refresh()}><RefreshIcon size={15} />{t("action.retry")}</button>
                  </div>
                ) : filteredRecords.length === 0 ? (
                  <div className="td3-empty-state"><strong>{t("tasks.emptyTitle")}</strong><span>{t("tasks.emptyHint")}</span></div>
                ) : filteredRecords.map((record) => {
                  const agent = record.runtime.agents.find((candidate) => candidate.id === record.task.agentId)
                  const state = productTaskState(record.task)
                  return (
                    <button
                      type="button"
                      className={`td3-task-row${record.key === selectedKey && detailOpen ? " selected" : ""}`}
                      key={record.key}
                      aria-expanded={record.key === selectedKey && detailOpen}
                      onClick={() => openTask(record)}
                    >
                      <span className="td3-task-title">
                        <i className={`td3-status-dot td3-status-${state}`} />
                        <span>
                          <strong>{taskTitle(record.task)}</strong>
                          <small>{record.task.prompt.split(/\r?\n/).slice(1).join(" ").slice(0, 100) || record.runtime.snapshot?.machine.name || record.runtime.machine.name}</small>
                        </span>
                      </span>
                      <span>{record.task.project?.name || record.task.projectId}</span>
                      <span>{agent ? <HarnessBadge agent={agent} /> : record.task.agentId}</span>
                      <span>{modelLabel(record.task)}</span>
                      <span>{taskWorkspaceLabel(record.task, t)}</span>
                      <span><b className={`td3-status-pill td3-status-${state}`}>{productTaskLabel(record.task, t)}</b></span>
                      <time>{formatRelative(record.task.updatedAt, t)}</time>
                    </button>
                  )
                })}
              </div>
            </section>

            {detailOpen ? <aside className="td3-task-detail td3-task-detail-open" aria-label={t("detail.eyebrow")}>
              {!selected ? <div className="td3-empty-state"><strong>{t("detail.selectTitle")}</strong><span>{t("detail.selectHint")}</span></div> : (
                <>
                  <header className="td3-detail-header">
                    <div>
                      <div className="td3-detail-title-line">
                        <div>
                          <small className="td3-detail-eyebrow">{t("detail.eyebrow")}</small>
                          <h2 ref={detailHeading} tabIndex={-1}>{taskTitle(selected.task)}</h2>
                        </div>
                        <div className="td3-detail-title-actions">
                          <b className={`td3-status-pill td3-status-${productTaskState(selected.task)}`}>{productTaskLabel(selected.task, t)}</b>
                          <button type="button" className="td3-detail-close" onClick={closeTaskDetail} aria-label={t("detail.close")} title={t("detail.close")}>
                            <CloseIcon size={16} />
                          </button>
                        </div>
                      </div>
                      <p>{selected.task.prompt}</p>
                    </div>
                  </header>
                  <section className="td3-detail-meta">
                    <span><small>{t("field.project")}</small><b>{selected.task.project.name}</b></span>
                    <span><small>{t("field.agent")}</small><b>{selectedAgent?.label || selected.task.agentId}</b></span>
                    <span><small>{t("field.model")}</small><b>{modelLabel(selected.task)}</b></span>
                    <span><small>{t("column.workspace")}</small><b>{taskWorkspaceLabel(selected.task, t)}</b></span>
                    <span><small>{t("detail.machine")}</small><b>{selected.runtime.snapshot?.machine.name || selected.runtime.machine.name}</b></span>
                    <span><small>{t("detail.run")}</small><b>{selected.task.run?.id || t("value.notStarted")}</b></span>
                    <span><small>{t("detail.session")}</small><b>{selectedSessionID || t("value.none")}</b></span>
                    <span><small>{t("detail.branch")}</small><b>{selected.task.workspace.branch || detail.vcs?.branch || t("value.projectCheckout")}</b></span>
                  </section>
                  <nav className="td3-detail-tabs" role="tablist" aria-label={t("detail.eyebrow")}>
                    {(["review", "conversation", "diff", "runs"] as DetailTab[]).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        role="tab"
                        aria-selected={detailTab === tab}
                        className={detailTab === tab ? "active" : ""}
                        onClick={() => setDetailTab(tab)}
                      >
                        {t(`tab.${tab}` as "tab.review")}
                        {tab === "diff" && detailChangeCount ? <span>{detailChangeCount}</span> : null}
                      </button>
                    ))}
                  </nav>
                  <div className="td3-detail-body">
                    {detail.loading && detail.ownerKey === selected.key ? <div className="td3-detail-loading"><LoadingIcon size={22} /><strong>{t("detail.loading")}</strong></div> : null}
                    {!detail.loading && detailTab === "review" ? (
                      <>
                        <section className="td3-review-hero">
                          <div>
                            <small>{t("review.eyebrow")}</small>
                            <h3>{productTaskState(selected.task) === "review"
                              ? t("review.runComplete")
                              : productTaskState(selected.task) === "finished"
                                ? t("review.finished")
                                : productTaskState(selected.task) === "active"
                                  ? t("review.working")
                                  : t("review.default")}</h3>
                          </div>
                          <div className="td3-review-metrics">
                            <span><small>{t("review.files")}</small><b>{detailChangeCount}</b></span>
                            <span><small>{t("review.ahead")}</small><b>{detail.result?.commitsAhead ?? "-"}</b></span>
                            <span><small>{t("review.dirty")}</small><b>{detail.result?.dirty ? t("value.yes") : t("value.no")}</b></span>
                          </div>
                        </section>
                        <section className="td3-relationship">
                          <h3>{t("relationship.title")}</h3>
                          <div>
                            <article><small>{t("column.task")}</small><strong>{taskTitle(selected.task)}</strong><span>{t("relationship.taskHint")}</span></article>
                            <i aria-hidden="true">→</i>
                            <article><small>{t("detail.run")}</small><strong>{selected.task.run?.id || t("value.notStarted")}</strong><span>{selected.task.run?.startedAt ? t("relationship.runStarted", { when: formatRelative(selected.task.run.startedAt, t) }) : t("relationship.noRun")}</span></article>
                            <i aria-hidden="true">→</i>
                            <article><small>{t("detail.session")}</small><strong>{selectedSessionID || t("value.none")}</strong><span>{selectedAgent?.label || selected.task.agentId}</span></article>
                          </div>
                        </section>
                        <div className="td3-detail-cards">
                          <section>
                            <header><h3>{t("card.resultSummary")}</h3></header>
                            {summary ? <div className="td3-markdown"><ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{summary}</ReactMarkdown></div> : <p className="td3-muted">{t("card.noResult")}</p>}
                            {selected.task.error?.message ? <div className="td3-inline-error" role="alert">{selected.task.error.message}</div> : null}
                          </section>
                          <section>
                            <header><h3>{t("column.workspace")}</h3></header>
                            <dl>
                              <dt>{t("card.changedFiles")}</dt><dd>{detailChangeCount}</dd>
                              <dt>{t("card.commitsAhead")}</dt><dd>{detail.result?.commitsAhead ?? "-"}</dd>
                              <dt>{t("card.commitsBehind")}</dt><dd>{detail.result?.commitsBehind ?? "-"}</dd>
                              <dt>{t("card.mergedToSource")}</dt><dd>{detail.result?.mergedIntoSource === undefined ? "-" : detail.result.mergedIntoSource ? t("value.yes") : t("value.no")}</dd>
                            </dl>
                            {detail.todos.length ? (
                              <div className="td3-todo-summary">
                                <strong>{t("card.agentPlan")}</strong>
                                {detail.todos.slice(0, 5).map((todo) => <span key={todo.id}>{todo.status === "completed" ? "✓" : "•"} {todo.content}</span>)}
                              </div>
                            ) : null}
                          </section>
                        </div>
                      </>
                    ) : null}
                    {!detail.loading && detailTab === "conversation" ? (
                      <div className="td3-conversation">
                        {detail.messages.length === 0 ? <div className="td3-empty-state"><span>{t("conversation.empty")}</span></div> : detail.messages.map((message) => (
                          <article key={message.info.id} className={message.info.role === "user" ? "user" : "assistant"}>
                            <header><strong>{message.info.role === "user" ? t("conversation.you") : selectedAgent?.label || t("conversation.agent")}</strong></header>
                            <TaskDeskMessageContent message={message} />
                          </article>
                        ))}
                      </div>
                    ) : null}
                    {!detail.loading && detailTab === "diff" ? (
                      <div className="td3-diff-list">
                        {detail.diff.length === 0 ? <div className="td3-empty-state"><span>{t("diff.empty")}</span></div> : detail.diff.map((file) => (
                          <details key={file.file}>
                            <summary><code>{file.file}</code><span><b>+{file.additions}</b><i>-{file.deletions}</i></span></summary>
                            {file.patch ? <pre>{file.patch}</pre> : <p>{t("diff.noPatch")}</p>}
                          </details>
                        ))}
                      </div>
                    ) : null}
                    {!detail.loading && detailTab === "runs" ? (
                      <div className="td3-runs">
                        <header><h3>{t("runs.title")}</h3><p>{t("runs.hint")}</p></header>
                        {taskRunHistory(selected.task).length === 0 ? <div className="td3-empty-state"><span>{t("runs.empty")}</span></div> : [...taskRunHistory(selected.task)].reverse().map((run, index) => {
                          const total = taskRunHistory(selected.task).length
                          const sequence = run.sequence ?? total - index
                          const sessionID = runSessionID(run)
                          return (
                            <article key={run.id || index}>
                              <span className="td3-run-index">#{sequence}</span>
                              <div>
                                <strong>{run.id || t("detail.run")}</strong>
                                <small>{run.prompt || taskTitle(selected.task)}</small>
                                {sessionID ? (
                                  <button type="button" className="td3-run-review-button" onClick={() => setRunReview({ record: selected, run, sequence })}>
                                    {t("runs.review")}
                                  </button>
                                ) : null}
                              </div>
                              <dl>
                                <dt>{t("detail.session")}</dt><dd>{sessionID || "-"}</dd>
                                <dt>{t("runs.started")}</dt><dd>{formatDate(run.startedAt, t)}</dd>
                                <dt>{t("runs.finished")}</dt><dd>{formatDate(run.finishedAt, t)}</dd>
                              </dl>
                            </article>
                          )
                        })}
                      </div>
                    ) : null}
                    {detail.error ? <div className="td3-inline-error" role="alert">{detail.error}</div> : null}
                  </div>
                  <footer className="td3-detail-actions">
                    <div className="td3-detail-actions-primary">
                      {selectedSessionID ? <button type="button" className="td3-button" onClick={() => openNativeSession(selected.runtime, selectedSessionID)}>{t("action.openSession")}</button> : null}
                      {["review", "failed", "cancelled", "finished"].includes(productTaskState(selected.task)) ? <button type="button" className="td3-button" onClick={() => setContinueOpen(true)}>{t("action.continue")}</button> : null}
                      {!selected.task.finishedAt && !["active", "draft"].includes(productTaskState(selected.task)) ? <button type="button" className="td3-button primary" disabled={actionBusy} onClick={() => void finishSelected()}>{t("action.finishTask")}</button> : null}
                    </div>
                    {selected.task.workspace.mode === "worktree" && productTaskState(selected.task) !== "active" ? <button type="button" className="td3-button danger" disabled={actionBusy} onClick={() => void cleanupSelected()}>{t("action.cleanupWorkspace")}</button> : null}
                    {actionError ? <span className="td3-action-error" role="alert">{actionError}</span> : null}
                  </footer>
                </>
              )}
            </aside> : null}
          </main>
        ) : null}

        {view === "sessions" ? (
          <main className={`td3-sessions-embedded${isMobile && sessionPane === "detail" ? " td3-mobile-session-detail" : ""}`}>
            <UniversalWorkspace
              profiles={sessionProfiles}
              activeProfileID={activeMachineID}
              focusSessionRequest={sessionFocusRequest}
              mobilePane={isMobile ? sessionPane : undefined}
              newSessionRequest={newSessionRequest}
              onOpenSessionDetail={() => setSessionPane("detail")}
              onBackToSessionList={() => setSessionPane("list")}
              t={t}
              onPersistProfiles={(nextMachines, nextActiveID) => {
                onPersistMachines(nextMachines as WorkspaceMachine[])
                onActiveMachineID(nextActiveID)
              }}
              legacyView={legacyView}
            />
          </main>
        ) : null}

        {view === "projects" ? (
          <main className="td3-simple-page">
            <section className="td3-page-heading">
              <div><small>{t("projects.eyebrow")}</small><h1>{t("nav.projects")}</h1><p>{t("projects.subtitle")}</p></div>
            </section>
            <div className="td3-card-grid">
              {scopedRuntimes.flatMap((runtime) => runtime.projects.map((project) => (
                <article key={`${runtime.key}|${project.id}`}>
                  <FolderIcon size={20} />
                  <div>
                    <h3>{project.name}</h3>
                    <code>{project.path}</code>
                    <span>{runtime.snapshot?.machine.name || runtime.machine.name} · {project.kind}</span>
                  </div>
                  <button type="button" onClick={() => { setMachineScope(runtime.machine.id); onActiveMachineID(runtime.machine.id); goToView("tasks"); setNewTaskOpen(true) }}>
                    {t("action.newTask")}
                  </button>
                </article>
              )))}
            </div>
            {scopedRuntimes.every((runtime) => runtime.projects.length === 0) ? <div className="td3-empty-state"><span>{t("projects.empty")}</span></div> : null}
          </main>
        ) : null}

        {view === "agents" ? (
          <main className="td3-simple-page">
            <section className="td3-page-heading">
              <div><small>{t("agents.eyebrow")}</small><h1>{t("nav.agents")}</h1><p>{t("agents.subtitle")}</p></div>
            </section>
            <div className="td3-card-grid">
              {scopedRuntimes.flatMap((runtime) => runtime.agents.map((agent) => (
                <article key={`${runtime.key}|${agent.id}`}>
                  <HarnessBadge agent={agent} />
                  <div>
                    <h3>{agent.label}</h3>
                    <span>{runtime.snapshot?.machine.name || runtime.machine.name}</span>
                    <code>{agent.backend} · {agent.transport}</code>
                  </div>
                </article>
              )))}
            </div>
            {counts.agents === 0 ? <div className="td3-empty-state"><span>{t("agents.empty")}</span></div> : null}
          </main>
        ) : null}

        {view === "machines" ? (
          <main className="td3-simple-page">
            <section className="td3-page-heading">
              <div><small>{t("machines.eyebrow")}</small><h1>{t("nav.machines")}</h1><p>{t("machines.subtitle")}</p></div>
              <button type="button" className="td3-button primary" onClick={onManageMachines}>{t("nav.manageMachines")}</button>
            </section>
            <div className="td3-card-grid">
              {runtimes.map((runtime) => (
                <article key={runtime.key}>
                  <ServerIcon size={22} />
                  <div>
                    <h3>{runtime.snapshot?.machine.name || runtime.machine.name}</h3>
                    <code>{runtime.machine.config.host}:{runtime.machine.config.port}</code>
                    <span>{t("machines.counts", { agents: runtime.agents.length, tasks: runtime.tasks.length })}</span>
                    {runtime.error ? <small className="td3-card-error">{runtime.error === "Not a Harness machine daemon" ? t("machine.notDaemon") : runtime.error}</small> : null}
                  </div>
                  <b className={`td3-machine-state ${runtime.state}`}>{runtime.state === "online" ? t("machine.online") : t("machine.offline")}</b>
                </article>
              ))}
            </div>
            {runtimes.length === 0 ? <div className="td3-empty-state"><span>{t("machines.empty")}</span></div> : null}
          </main>
        ) : null}

        {view === "needs" ? (
          <main className="td3-simple-page">
            <section className="td3-page-heading">
              <div><small>{t("needs.eyebrow")}</small><h1>{t("needs.title")}</h1><p>{t("needs.subtitle")}</p></div>
            </section>
            {attentionError ? <div className="td3-page-error td3-inline-error" role="alert">{attentionError}</div> : null}
            <div className="td3-attention-list">
              {scopedAttention.length === 0 ? <div className="td3-empty-state"><strong>{t("needs.emptyTitle")}</strong></div> : scopedAttention.map((item) => item.type === "permission" ? (
                <PermissionAttentionCard
                  key={item.key}
                  item={item}
                  t={t}
                  onResolved={() => { setAttentionError(null); void refresh() }}
                  onOpenSession={openNativeSession}
                  onError={setAttentionError}
                />
              ) : (
                <QuestionAttentionCard
                  key={item.key}
                  item={item}
                  t={t}
                  onResolved={() => { setAttentionError(null); void refresh() }}
                  onOpenSession={openNativeSession}
                  onError={setAttentionError}
                />
              ))}
            </div>
            {outsideScope > 0 ? (
              <div className="td3-scope-note">
                <span>{t("needs.outsideScope", { count: outsideScope })}</span>
                <button type="button" className="td3-link-button" onClick={() => setMachineScope("all")}>{t("needs.showAllMachines")}</button>
              </div>
            ) : null}
          </main>
        ) : null}

        {view === "classic" ? (
          <main className="td3-classic-integrated">
            <div className="td3-classic-notice">
              <div><small>{t("classic.eyebrow")}</small><strong>{t("nav.classic")}</strong><span>{t("classic.hint")}</span></div>
              <button type="button" className="td3-button" onClick={() => goToView("tasks")}>{t("action.backToTasks")}</button>
            </div>
            <div className="td3-classic-integrated-host">{legacyView}</div>
          </main>
        ) : null}
      </div>

      {newTaskOpen ? (
        <NewTaskModal
          runtimes={runtimes}
          initialMachineID={machineScope === "all" ? activeMachineID : machineScope}
          t={t}
          onClose={() => setNewTaskOpen(false)}
          onCreated={(runtime, task) => {
            setMachineScope(runtime.machine.id)
            onActiveMachineID(runtime.machine.id)
            goToView("tasks")
            setSelectedKey(`${runtime.key}|${task.id}`)
            setDetailOpen(true)
            setDetailTab("review")
            void refreshAndReselect(task.id, runtime.machine.id)
          }}
        />
      ) : null}
      {continueOpen && selected ? (
        <IntelligentContinueTaskModal
          record={selected}
          language={language}
          t={t}
          legacyFallback={ContinueTaskModal}
          onClose={() => setContinueOpen(false)}
          onContinued={(task) => { setDetailTab("review"); void refreshAndReselect(task.id, selected.runtime.machine.id) }}
        />
      ) : null}
      {runReview ? <RunReviewModal target={runReview} t={t} onClose={() => setRunReview(null)} /> : null}
      {settingsOpen ? (
        <SettingsModal
          language={language}
          theme={theme}
          t={t}
          onLanguage={applyLanguage}
          onTheme={applyTheme}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      {moreOpen ? <MoreSheet items={moreItems} t={t} onClose={() => setMoreOpen(false)} /> : null}
    </div>
  )
}
