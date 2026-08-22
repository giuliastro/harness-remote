import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { api, isValidServerConfig } from "../api"
import { backendDisplayName } from "../backendSetup"
import { discoverMachine, selectableMachineAgents } from "../machineClient"
import { messageText } from "../message-content"
import { mergeLatestMessagePage, prependOlderMessagePage } from "../message-pages"
import { taskClient, type MachineProject } from "../taskClient"
import type { SavedServerProfile } from "../serverProfiles"
import { createTaskDeskTranslator, type TaskDeskTranslator } from "../taskdesk-i18n"
import { startTaskDeskSessionLiveRefresh, type SessionLiveTarget } from "../taskdesk-session-live-refresh"
import type {
  BackendKind,
  DiffFile,
  MachineAgentHost,
  MachineSnapshot,
  MessageEnvelope,
  ModelOption,
  ModelSelection,
  PermissionRequest,
  QuestionRequest,
  ServerConfig,
  Session,
  SessionStatus,
  TodoItem,
  VcsStatus
} from "../types"
import {
  ArrowLeftIcon,
  ChatIcon,
  CloseIcon,
  FolderIcon,
  LoadingIcon,
  MoreVerticalIcon,
  PanelRightIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  StopCircleIcon
} from "../Icons"
import { TaskDeskConversation } from "./taskdesk-conversation"
import { TaskDeskMessageContent } from "./taskdesk-message-content"

const REFRESH_INTERVAL_MS = 60_000
const DETAIL_REFRESH_INTERVAL_MS = 30_000
const AGENT_SESSION_LOAD_TIMEOUT_MS = 12_000
const PINNED_STORAGE_KEY = "harness-remote.universal-workspace.pinned"
const HARNESS_ICON_FILES: Record<string, string> = {
  codex: "codex.svg",
  claude: "claude.svg",
  opencode: "opencode.svg",
  omp: "omp.svg",
  pi: "pi.svg"
}

type WorkspaceFilter = "all" | "working" | "needs-you" | "idle" | "pinned"
type DetailTab = "conversation" | "changes"
type ConnectionState = "online" | "offline" | "loading"

type MachineSource = {
  key: string
  profile: SavedServerProfile
  machine: MachineSnapshot | null
  agents: MachineAgentHost[]
  projects: MachineProject[]
  state: ConnectionState
  error?: string
}

type UniversalSession = {
  key: string
  machineKey: string
  machineId: string
  machineName: string
  profileId: string
  agent: MachineAgentHost
  config: ServerConfig
  session: Session
  status: SessionStatus
  attention: number
  projectName: string
}

type SelectedDetail = {
  messages: MessageEnvelope[]
  diff: DiffFile[]
  todos: TodoItem[]
  vcs: VcsStatus | null
  questions: QuestionRequest[]
  permissions: PermissionRequest[]
}

type UniversalWorkspaceProps = {
  profiles: SavedServerProfile[]
  activeProfileID: string
  focusSessionRequest?: { sessionID: string; requestID: number } | null
  /**
   * TaskDesk drives the phone master/detail stack, so the pane is a prop rather than something this
   * component infers. Absent means the host is not stacking panes and both are laid out at once.
   */
  mobilePane?: "list" | "detail"
  /** Incremented by the host to open New Session from chrome that lives outside this component. */
  newSessionRequest?: number
  onOpenSessionDetail?: () => void
  onBackToSessionList?: () => void
  t?: TaskDeskTranslator
  onPersistProfiles: (profiles: SavedServerProfile[], activeProfileID: string) => void
  legacyView: ReactNode
}

const EMPTY_DETAIL: SelectedDetail = {
  messages: [],
  diff: [],
  todos: [],
  vcs: null,
  questions: [],
  permissions: []
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = AGENT_SESSION_LOAD_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`)),
      timeoutMs
    )
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (reason) => {
        window.clearTimeout(timer)
        reject(reason)
      }
    )
  })
}

function endpointKey(config: ServerConfig): string {
  return `${config.host.trim().toLowerCase()}:${config.port}:${config.username}`
}

function supportedBackend(value: string, fallback: BackendKind): BackendKind {
  return value === "opencode" || value === "omp" || value === "pi" || value === "claude" || value === "codex"
    ? value
    : fallback
}

function configForAgent(source: MachineSource, agent: MachineAgentHost): ServerConfig {
  return {
    ...source.profile.config,
    backend: supportedBackend(agent.backend, source.profile.config.backend),
    agentId: agent.id
  }
}

function machineLabel(source: MachineSource): string {
  return source.machine?.machine.name || source.profile.name || `${source.profile.config.host}:${source.profile.config.port}`
}

function directoryLabel(directory: string): string {
  const normalized = directory.replace(/[\\/]+$/, "")
  const chunks = normalized.split(/[\\/]/).filter(Boolean)
  return (chunks.length ? chunks[chunks.length - 1] : "") || directory || "Project"
}

function projectNameFor(session: Session): string {
  return session.project?.name || directoryLabel(session.directory)
}

function normalizeStatus(status: SessionStatus | undefined, attention: number): "working" | "needs-you" | "idle" | "failed" {
  if (attention > 0) return "needs-you"
  const type = (status?.type || "idle").toLowerCase()
  if (type === "busy" || type === "running" || type === "retry" || type === "waiting" || type === "active") return "working"
  if (type === "failed" || type === "error") return "failed"
  return "idle"
}

function statusLabel(status: SessionStatus | undefined, attention: number): string {
  const normalized = normalizeStatus(status, attention)
  if (normalized === "needs-you") return "Needs you"
  if (normalized === "working") return status?.type === "retry" ? "Retrying" : "Working"
  if (normalized === "failed") return "Failed"
  return "Idle"
}

function statusClass(status: SessionStatus | undefined, attention: number): string {
  return `uw-status-${normalizeStatus(status, attention)}`
}

function formatRelative(timestamp: number): string {
  if (!timestamp) return ""
  const delta = Date.now() - timestamp
  if (delta < 60_000) return "now"
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))}m`
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h`
  if (delta < 604_800_000) return `${Math.round(delta / 86_400_000)}d`
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp)
}

function formatClock(timestamp: number): string {
  if (!timestamp) return ""
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(timestamp)
}

function modelLabel(model?: Session["model"] | ModelSelection | null): string {
  if (!model) return "Default model"
  const candidate = "modelID" in model ? model.modelID : model.id
  const variant = model.variant ? ` · ${model.variant}` : ""
  return `${model.providerID}/${candidate}${variant}`
}

function modelOptionKey(model: ModelSelection): string {
  return `${model.providerID}/${model.modelID}/${model.variant || ""}`
}

function harnessIconUrl(backend: string): string | undefined {
  const file = HARNESS_ICON_FILES[backend.toLowerCase()]
  return file ? `${import.meta.env.BASE_URL}harness-icons/${file}` : undefined
}

function uniqueEndpointProfiles(profiles: SavedServerProfile[]): SavedServerProfile[] {
  const seen = new Set<string>()
  return profiles.filter((profile) => {
    if (!isValidServerConfig(profile.config)) return false
    const key = endpointKey(profile.config)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function loadPinned(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PINNED_STORAGE_KEY) || "[]")
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [])
  } catch {
    return new Set()
  }
}

function pageIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden"
}

function BeautifulButton({
  children,
  onClick,
  variant = "ghost",
  disabled = false,
  title,
  className = "",
  type = "button"
}: {
  children: ReactNode
  onClick?: () => void
  variant?: "primary" | "secondary" | "ghost" | "danger"
  disabled?: boolean
  title?: string
  className?: string
  type?: "button" | "submit"
}) {
  return (
    <button
      type={type}
      className={`uw-button uw-button-${variant}${className ? ` ${className}` : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  )
}

function BeautifulPill({
  children,
  active = false,
  onClick,
  count
}: {
  children: ReactNode
  active?: boolean
  onClick?: () => void
  count?: number
}) {
  return (
    <button type="button" className={`uw-pill${active ? " active" : ""}`} onClick={onClick}>
      <span>{children}</span>
      {count !== undefined ? <span className="uw-pill-count">{count}</span> : null}
    </button>
  )
}

function BeautifulSelect({
  value,
  onChange,
  children,
  disabled = false
}: {
  value: string
  onChange: (value: string) => void
  children: ReactNode
  disabled?: boolean
}) {
  return (
    <div className="uw-select-wrap">
      <select className="uw-select" value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        {children}
      </select>
      <span className="uw-select-chevron" aria-hidden="true">⌄</span>
    </div>
  )
}

function Modal({
  title,
  subtitle,
  onClose,
  children
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div className="uw-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="uw-modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header className="uw-modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <BeautifulButton onClick={onClose} title="Close"><CloseIcon size={16} /></BeautifulButton>
        </header>
        {children}
      </section>
    </div>
  )
}

function HarnessAvatar({ backend, label }: { backend: string; label: string }) {
  const [failed, setFailed] = useState(false)
  const source = harnessIconUrl(backend)
  return (
    <div className="uw-avatar uw-avatar-agent" title={label}>
      {source && !failed ? (
        <img src={source} alt="" aria-hidden="true" onError={() => setFailed(true)} />
      ) : label.slice(0, 2).toUpperCase()}
    </div>
  )
}

const MessageBubble = memo(function MessageBubble({ message, agentLabel, agentBackend }: { message: MessageEnvelope; agentLabel: string; agentBackend: string }) {
  const isUser = message.info.role === "user"
  return (
    <article className={`uw-message ${isUser ? "uw-message-user" : "uw-message-agent"}`}>
      {isUser ? (
        <div className="uw-avatar uw-avatar-user">You</div>
      ) : (
        <HarnessAvatar backend={agentBackend} label={agentLabel} />
      )}
      <div className="uw-message-body">
        <header>
          <strong>{isUser ? "You" : agentLabel}</strong>
          <time>{formatClock(message.info.time.created)}</time>
        </header>
        <TaskDeskMessageContent message={message} />
      </div>
    </article>
  )
})

function SessionCard({
  item,
  selected,
  pinned,
  onSelect,
  onTogglePin
}: {
  item: UniversalSession
  selected: boolean
  pinned: boolean
  onSelect: () => void
  onTogglePin: () => void
}) {
  const session = item.session
  const status = statusLabel(item.status, item.attention)
  return (
    <button type="button" className={`uw-session-card${selected ? " selected" : ""}`} onClick={onSelect}>
      <span className={`uw-session-accent ${statusClass(item.status, item.attention)}`} />
      <span className="uw-session-card-main">
        <span className="uw-session-title-row">
          <strong>{session.title || "Untitled session"}</strong>
          <span className={`uw-status-chip ${statusClass(item.status, item.attention)}`}>{status}</span>
        </span>
        <span className="uw-session-meta">
          {item.agent.label} · {modelLabel(session.model)} · {item.machineName}
        </span>
        <span className="uw-session-preview">
          {session.summary?.files ? `${session.summary.files} files changed · +${session.summary.additions} −${session.summary.deletions}` : item.session.directory}
        </span>
        <span className="uw-session-footer">
          <span>{item.projectName}</span>
          <span>{formatRelative(session.time.updated)}</span>
        </span>
      </span>
      <span
        role="button"
        tabIndex={0}
        className={`uw-pin${pinned ? " pinned" : ""}`}
        title={pinned ? "Unpin session" : "Pin session"}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onTogglePin()
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            event.stopPropagation()
            onTogglePin()
          }
        }}
      >
        {pinned ? "★" : "☆"}
      </span>
    </button>
  )
}

function ConnectionEditor({
  profile,
  onSave,
  onClose
}: {
  profile: SavedServerProfile
  onSave: (next: SavedServerProfile) => void
  onClose: () => void
}) {
  const [name, setName] = useState(profile.name)
  const [host, setHost] = useState(profile.config.host)
  const [port, setPort] = useState(String(profile.config.port))
  const [username, setUsername] = useState(profile.config.username)
  const [password, setPassword] = useState(profile.config.password)

  const validPort = Number(port) >= 1 && Number(port) <= 65_535
  const valid = Boolean(host.trim() && validPort)

  return (
    <Modal title="Connection" subtitle="Edit the selected machine endpoint." onClose={onClose}>
      <div className="uw-modal-body uw-form-grid">
        <label>
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span>Host</span>
          <input value={host} onChange={(event) => setHost(event.target.value)} spellCheck={false} />
        </label>
        <label>
          <span>Port</span>
          <input value={port} onChange={(event) => setPort(event.target.value.replace(/\D/g, ""))} inputMode="numeric" />
        </label>
        <label>
          <span>Username</span>
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
        </label>
        <label className="uw-form-span-2">
          <span>Password</span>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
        </label>
      </div>
      <footer className="uw-modal-footer">
        <BeautifulButton onClick={onClose}>Cancel</BeautifulButton>
        <BeautifulButton
          variant="primary"
          disabled={!valid}
          onClick={() => {
            if (!valid) return
            onSave({
              ...profile,
              name: name.trim() || profile.name,
              config: {
                ...profile.config,
                host: host.trim(),
                port: Number(port),
                username: username.trim(),
                password
              }
            })
          }}
        >
          Save and reconnect
        </BeautifulButton>
      </footer>
    </Modal>
  )
}

function NewSessionModal({
  machines,
  initialMachineKey,
  initialProject,
  initialAgentId,
  onClose,
  onCreated
}: {
  machines: MachineSource[]
  initialMachineKey?: string
  initialProject?: string
  initialAgentId?: string
  onClose: () => void
  onCreated: (machine: MachineSource, agent: MachineAgentHost, session: Session) => void
}) {
  const firstMachine = machines.find((machine) => machine.state === "online" && machine.agents.length > 0) || machines[0]
  const [machineKey, setMachineKey] = useState(initialMachineKey || firstMachine?.key || "")
  const machine = machines.find((candidate) => candidate.key === machineKey) || firstMachine
  const availableAgents = machine?.agents || []
  const [agentId, setAgentId] = useState(initialAgentId && availableAgents.some((agent) => agent.id === initialAgentId)
    ? initialAgentId
    : availableAgents[0]?.id || "")
  const agent = availableAgents.find((candidate) => candidate.id === agentId) || availableAgents[0]
  const [directory, setDirectory] = useState(initialProject || machine?.projects[0]?.path || "")
  const [prompt, setPrompt] = useState("")
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelKey, setModelKey] = useState("")
  const [loadingModels, setLoadingModels] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!machine) return
    if (!machine.projects.some((project) => project.path === directory)) {
      setDirectory(initialProject && machine.projects.some((project) => project.path === initialProject)
        ? initialProject
        : machine.projects[0]?.path || "")
    }
    if (!availableAgents.some((candidate) => candidate.id === agentId)) {
      setAgentId(availableAgents[0]?.id || "")
    }
  }, [machineKey])

  useEffect(() => {
    if (!machine || !agent) {
      setModels([])
      setModelKey("")
      return
    }
    let cancelled = false
    setLoadingModels(true)
    setError(null)
    void taskClient.listAgentModels(machine.profile.config, agent.id)
      .then((catalog) => {
        if (cancelled) return
        setModels(catalog.models)
        const defaultModel = catalog.models.find((model) => model.isDefault) || catalog.models[0]
        setModelKey(defaultModel ? `${defaultModel.providerID}/${defaultModel.modelID}/${defaultModel.variant || ""}` : "")
      })
      .catch(async () => {
        try {
          const fallback = await api.listModels(configForAgent(machine, agent), directory || undefined)
          if (cancelled) return
          setModels(fallback)
          const defaultModel = fallback.find((model) => model.isDefault) || fallback[0]
          setModelKey(defaultModel ? `${defaultModel.providerID}/${defaultModel.modelID}/${defaultModel.variant || ""}` : "")
        } catch (reason) {
          if (!cancelled) {
            setModels([])
            setModelKey("")
            setError(reason instanceof Error ? reason.message : String(reason))
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false)
      })
    return () => { cancelled = true }
  }, [machineKey, agentId, directory])

  const selectedModel = models.find((model) => `${model.providerID}/${model.modelID}/${model.variant || ""}` === modelKey)
  const canCreate = Boolean(machine && agent && directory && !creating)

  async function create() {
    if (!machine || !agent || !directory || creating) return
    setCreating(true)
    setError(null)
    try {
      const config = configForAgent(machine, agent)
      const title = prompt.trim() ? prompt.trim().split(/\r?\n/)[0].slice(0, 88) : undefined
      const model = selectedModel
        ? { providerID: selectedModel.providerID, modelID: selectedModel.modelID, variant: selectedModel.variant }
        : undefined
      const created = await api.createSession(config, title, model, directory)
      if (prompt.trim()) {
        await api.sendPrompt(config, created.id, prompt.trim(), created.directory || directory, model)
      }
      onCreated(machine, agent, created)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal title="New Session" subtitle="Start native work on any available harness." onClose={onClose}>
      <div className="uw-modal-body uw-new-session-grid">
        <label>
          <span>Machine</span>
          <BeautifulSelect value={machine?.key || ""} onChange={setMachineKey}>
            {machines.map((candidate) => (
              <option key={candidate.key} value={candidate.key}>{machineLabel(candidate)}</option>
            ))}
          </BeautifulSelect>
        </label>
        <label>
          <span>Project</span>
          <BeautifulSelect value={directory} onChange={setDirectory}>
            {machine?.projects.map((project) => (
              <option key={project.id || project.path} value={project.path}>{project.name}</option>
            ))}
            {!machine?.projects.length && directory ? <option value={directory}>{directoryLabel(directory)}</option> : null}
          </BeautifulSelect>
        </label>
        <label>
          <span>Harness</span>
          <BeautifulSelect value={agent?.id || ""} onChange={setAgentId}>
            {availableAgents.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
            ))}
          </BeautifulSelect>
        </label>
        <label>
          <span>Model</span>
          <BeautifulSelect value={modelKey} onChange={setModelKey} disabled={loadingModels || models.length === 0}>
            {loadingModels ? <option value="">Loading models…</option> : null}
            {!loadingModels && models.length === 0 ? <option value="">Harness default</option> : null}
            {models.map((model) => {
              const key = `${model.providerID}/${model.modelID}/${model.variant || ""}`
              return <option key={key} value={key}>{model.providerName}: {model.modelName}{model.variant ? ` (${model.variant})` : ""}</option>
            })}
          </BeautifulSelect>
        </label>
        <label className="uw-form-span-2">
          <span>Initial request</span>
          <textarea
            rows={7}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="What do you want the agent to work on?"
            autoFocus
          />
        </label>
        {error ? <div className="uw-inline-error uw-form-span-2">{error}</div> : null}
      </div>
      <footer className="uw-modal-footer">
        <BeautifulButton onClick={onClose}>Cancel</BeautifulButton>
        <BeautifulButton variant="primary" disabled={!canCreate} onClick={() => void create()}>
          {creating ? <LoadingIcon size={15} /> : <PlusIcon size={15} />}
          {creating ? "Starting…" : "Start session"}
        </BeautifulButton>
      </footer>
    </Modal>
  )
}

function HandoffModal({
  current,
  messages,
  machines,
  onClose,
  onCreated
}: {
  current: UniversalSession
  messages: MessageEnvelope[]
  machines: MachineSource[]
  onClose: () => void
  onCreated: (machine: MachineSource, agent: MachineAgentHost, session: Session) => void
}) {
  const choices = machines.flatMap((machine) => machine.agents.map((agent) => ({ machine, agent })))
  const initial = choices.find((choice) => choice.agent.id !== current.agent.id || choice.machine.key !== current.machineKey) || choices[0]
  const [choiceKey, setChoiceKey] = useState(initial ? `${initial.machine.key}|${initial.agent.id}` : "")
  const selected = choices.find((choice) => `${choice.machine.key}|${choice.agent.id}` === choiceKey) || initial
  const sameMachine = selected?.machine.key === current.machineKey
  const discoveredTargetProject = selected?.machine.projects.find((project) => project.path === current.session.directory)
    || selected?.machine.projects.find((project) => project.name === current.projectName)
  const targetDirectory = sameMachine ? current.session.directory : discoveredTargetProject?.path
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handoff() {
    if (!selected || !targetDirectory || creating) return
    setCreating(true)
    setError(null)
    try {
      const config = configForAgent(selected.machine, selected.agent)
      const transcript = messages.slice(-10).map((message) => {
        const role = message.info.role === "user" ? "User" : current.agent.label
        const text = messageText(message)
        return text ? `${role}: ${text}` : ""
      }).filter(Boolean).join("\n\n")
      const prompt = [
        "Continue the work from another Harness Remote session.",
        `Project: ${current.projectName}`,
        `Previous harness: ${current.agent.label}`,
        `Previous session: ${current.session.title || current.session.id}`,
        "",
        "Before changing anything, inspect the current repository state and continue from what is already on disk.",
        transcript ? `\nRecent conversation:\n${transcript}` : ""
      ].join("\n")
      const created = await api.createSession(config, current.session.title || "Continued session", undefined, targetDirectory)
      await api.sendPrompt(config, created.id, prompt, created.directory || targetDirectory)
      onCreated(selected.machine, selected.agent, created)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal title="Continue with another harness" subtitle="Create a native session on another harness and hand over the recent context." onClose={onClose}>
      <div className="uw-modal-body uw-form-grid">
        <label className="uw-form-span-2">
          <span>Target agent</span>
          <BeautifulSelect value={choiceKey} onChange={setChoiceKey}>
            {choices.map(({ machine, agent }) => (
              <option key={`${machine.key}|${agent.id}`} value={`${machine.key}|${agent.id}`}>
                {agent.label} · {machineLabel(machine)}
              </option>
            ))}
          </BeautifulSelect>
        </label>
        <div className="uw-handoff-summary uw-form-span-2">
          <strong>{current.session.title}</strong>
          <span>{current.agent.label} → {selected?.agent.label || "Agent"}</span>
          <span>Workspace: {targetDirectory || "No matching project on target machine"}</span>
        </div>
        {!targetDirectory ? (
          <div className="uw-inline-error uw-form-span-2">
            Harness Remote cannot safely hand this Session to another machine because the same project was not discovered there.
          </div>
        ) : null}
        {error ? <div className="uw-inline-error uw-form-span-2">{error}</div> : null}
      </div>
      <footer className="uw-modal-footer">
        <BeautifulButton onClick={onClose}>Cancel</BeautifulButton>
        <BeautifulButton variant="primary" disabled={!selected || !targetDirectory || creating} onClick={() => void handoff()}>
          {creating ? <LoadingIcon size={15} /> : <ChatIcon size={15} />}
          {creating ? "Handing off…" : "Create handoff session"}
        </BeautifulButton>
      </footer>
    </Modal>
  )
}

function QuestionPanel({
  request,
  config,
  directory,
  onResolved
}: {
  request: QuestionRequest
  config: ServerConfig
  directory: string
  onResolved: () => void
}) {
  const [answers, setAnswers] = useState<Record<number, string[]>>({})
  const [custom, setCustom] = useState<Record<number, string>>({})
  const [sending, setSending] = useState(false)

  async function submit() {
    setSending(true)
    try {
      const payload = request.questions.map((_question, index) => {
        const selected = answers[index] || []
        const customValue = custom[index]?.trim()
        return customValue ? [...selected, customValue] : selected
      })
      await api.replyQuestion(config, request.id, payload, directory)
      onResolved()
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="uw-attention-card">
      <strong>Agent question</strong>
      {request.questions.map((question, index) => (
        <div className="uw-question" key={`${request.id}-${index}`}>
          <span>{question.header || question.question}</span>
          {question.header ? <p>{question.question}</p> : null}
          <div className="uw-question-options">
            {question.options.map((option) => {
              const selected = answers[index]?.includes(option.label) || false
              return (
                <button
                  type="button"
                  key={option.label}
                  className={`uw-choice${selected ? " selected" : ""}`}
                  onClick={() => {
                    setAnswers((current) => {
                      const existing = current[index] || []
                      const next = question.multiple
                        ? selected ? existing.filter((value) => value !== option.label) : [...existing, option.label]
                        : [option.label]
                      return { ...current, [index]: next }
                    })
                  }}
                  title={option.description}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
          {question.custom ? (
            <input
              value={custom[index] || ""}
              onChange={(event) => setCustom((current) => ({ ...current, [index]: event.target.value }))}
              placeholder="Custom answer…"
            />
          ) : null}
        </div>
      ))}
      <div className="uw-attention-actions">
        <BeautifulButton
          variant="danger"
          disabled={sending}
          onClick={() => void api.rejectQuestion(config, request.id, directory).then(onResolved)}
        >
          Reject
        </BeautifulButton>
        <BeautifulButton variant="primary" disabled={sending} onClick={() => void submit()}>
          {sending ? "Sending…" : "Reply"}
        </BeautifulButton>
      </div>
    </div>
  )
}

export function UniversalWorkspace({
  profiles,
  activeProfileID,
  focusSessionRequest,
  mobilePane,
  newSessionRequest,
  onOpenSessionDetail,
  onBackToSessionList,
  t: hostTranslator,
  onPersistProfiles,
  legacyView
}: UniversalWorkspaceProps) {
  const t = useMemo(() => hostTranslator ?? createTaskDeskTranslator("en"), [hostTranslator])
  const [machines, setMachines] = useState<MachineSource[]>([])
  const [sessions, setSessions] = useState<UniversalSession[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [filter, setFilter] = useState<WorkspaceFilter>("all")
  const [projectFilter, setProjectFilter] = useState<string>("all")
  const [machineFilter, setMachineFilter] = useState<string>("all")
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [detail, setDetail] = useState<SelectedDetail>(EMPTY_DETAIL)
  const [detailSessionKey, setDetailSessionKey] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [messageCursor, setMessageCursor] = useState<string | undefined>(undefined)
  const [messageHasMore, setMessageHasMore] = useState(false)
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false)
  const [detailTab, setDetailTab] = useState<DetailTab>("conversation")
  const [composer, setComposer] = useState("")
  const [sessionModels, setSessionModels] = useState<ModelOption[]>([])
  const [sessionModelKey, setSessionModelKey] = useState("")
  const [sessionModelsLoading, setSessionModelsLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [classicOpen, setClassicOpen] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [connectionProfileID, setConnectionProfileID] = useState<string | null>(null)
  const [pinned, setPinned] = useState<Set<string>>(() => loadPinned())
  const [questionRevision, setQuestionRevision] = useState(0)
  const refreshGeneration = useRef(0)
  const refreshInFlight = useRef(false)
  const detailInFlight = useRef(false)
  const messageRefreshInFlight = useRef(false)
  const selectedKeyRef = useRef<string | null>(null)
  const selectedSessionRef = useRef<UniversalSession | null>(null)
  const appliedFocusRequest = useRef<number | null>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const preserveTranscriptPosition = useRef(false)

  const selected = sessions.find((item) => item.key === selectedKey) || null
  selectedKeyRef.current = selectedKey
  selectedSessionRef.current = selected
  const selectedSessionModel = sessionModels.find((model) => modelOptionKey(model) === sessionModelKey)
  const detailReady = Boolean(selected && detailSessionKey === selected.key)
  const sessionWaiting = Boolean(
    selected && detailReady && !detailLoading
    && (sending || normalizeStatus(selected.status, selected.attention) === "working")
  )

  const refreshAll = useCallback(async (silent = false) => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    const generation = ++refreshGeneration.current
    if (!silent) setLoading(true)
    else setRefreshing(true)
    setGlobalError(null)
    try {
      const sourceProfiles = uniqueEndpointProfiles(profiles)
      const nextMachines = await Promise.all(sourceProfiles.map(async (profile): Promise<MachineSource> => {
        const key = endpointKey(profile.config)
        try {
          const machine = await discoverMachine(profile.config)
          if (!machine) {
            return {
              key,
              profile,
              machine: null,
              agents: [{
                id: profile.config.agentId || profile.config.backend,
                label: backendDisplayName(profile.config.backend),
                backend: profile.config.backend,
                transport: "http",
                managed: false,
                state: "available",
                capabilities: {}
              }],
              projects: [],
              state: "online"
            }
          }
          const projects = await taskClient.listProjects(profile.config).catch(() => [])
          return {
            key,
            profile,
            machine,
            agents: selectableMachineAgents(machine),
            projects,
            state: "online"
          }
        } catch (reason) {
          return {
            key,
            profile,
            machine: null,
            agents: [],
            projects: [],
            state: "offline",
            error: reason instanceof Error ? reason.message : String(reason)
          }
        }
      }))

      const collected = (await Promise.all(nextMachines.flatMap((machine) => machine.agents.map(async (agent) => {
        const config = configForAgent(machine, agent)
        try {
          const [agentSessions, statuses, questions, permissions] = await withTimeout(Promise.all([
            api.listGlobalSessions(config).catch(() => api.listSessions(config)),
            api.listStatuses(config).catch(() => ({} as Record<string, SessionStatus>)),
            api.loadQuestions(config).catch(() => []),
            api.loadPermissions(config).catch(() => [])
          ]), `${agent.label} session loading`)
          const attentionBySession = new Map<string, number>()
          for (const request of [...questions, ...permissions]) {
            attentionBySession.set(request.sessionID, (attentionBySession.get(request.sessionID) || 0) + 1)
          }
          return agentSessions.map((session): UniversalSession => ({
            key: `${machine.key}|${agent.id}|${session.id}`,
            machineKey: machine.key,
            machineId: machine.machine?.machine.id || machine.key,
            machineName: machineLabel(machine),
            profileId: machine.profile.id,
            agent,
            config,
            session,
            status: statuses[session.id] || { type: "idle" },
            attention: attentionBySession.get(session.id) || 0,
            projectName: projectNameFor(session)
          }))
        } catch {
          return []
        }
      })))).flat()

      if (generation !== refreshGeneration.current) return
      collected.sort((left, right) => right.session.time.updated - left.session.time.updated)
      setMachines(nextMachines)
      setSessions(collected)
      const pendingFocus = focusSessionRequest && appliedFocusRequest.current !== focusSessionRequest.requestID
        ? focusSessionRequest
        : null
      setSelectedKey((current) => {
        const focused = pendingFocus
          ? collected.find((item) => item.session.id === pendingFocus.sessionID)
          : undefined
        if (focused) {
          appliedFocusRequest.current = pendingFocus?.requestID ?? null
          return focused.key
        }
        if (current && collected.some((item) => item.key === current)) return current
        return collected[0]?.key || null
      })
    } catch (reason) {
      if (generation !== refreshGeneration.current) return
      setGlobalError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (generation === refreshGeneration.current) {
        setLoading(false)
        setRefreshing(false)
      }
      refreshInFlight.current = false
    }
  }, [profiles, focusSessionRequest?.sessionID, focusSessionRequest?.requestID])

  useEffect(() => {
    void refreshAll(false)
    const timer = window.setInterval(() => {
      if (pageIsVisible()) void refreshAll(true)
    }, REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [refreshAll])

  useEffect(() => {
    if (!newSessionRequest) return
    setNewSessionOpen(true)
  }, [newSessionRequest])

  useEffect(() => {
    if (!focusSessionRequest || appliedFocusRequest.current === focusSessionRequest.requestID) return
    const target = sessions.find((item) => item.session.id === focusSessionRequest.sessionID)
    if (!target) return
    appliedFocusRequest.current = focusSessionRequest.requestID
    setMachineFilter(target.machineKey)
    setProjectFilter("all")
    setFilter("all")
    setQuery("")
    setDetailTab("conversation")
    setSelectedKey(target.key)
  }, [focusSessionRequest, sessions])

  const loadDetail = useCallback(async (item: UniversalSession, silent = false) => {
    if (detailInFlight.current && silent) return
    detailInFlight.current = true
    if (!silent) setDetailLoading(true)
    try {
      const [messagePage, diff, todos, vcs, questions, permissions] = await Promise.all([
        api.loadMessagePage(item.config, item.session.id, item.session.directory),
        api.loadDiff(item.config, item.session.id, item.session.directory).catch(() => []),
        api.loadTodo(item.config, item.session.id, item.session.directory).catch(() => []),
        api.loadVcs(item.config, item.session.directory).catch(() => null),
        api.loadQuestions(item.config, item.session.directory).catch(() => []),
        api.loadPermissions(item.config, item.session.directory).catch(() => [])
      ])
      if (selectedKeyRef.current !== item.key) return
      if (!silent) {
        setMessageCursor(messagePage.before)
        setMessageHasMore(messagePage.hasMore)
      }
      setDetail((current) => ({
        messages: silent ? mergeLatestMessagePage(current.messages, messagePage.messages) : messagePage.messages,
        diff,
        todos,
        vcs,
        questions: questions.filter((request) => request.sessionID === item.session.id),
        permissions: permissions.filter((request) => request.sessionID === item.session.id)
      }))
      setDetailSessionKey(item.key)
    } catch (reason) {
      if (!silent && selectedKeyRef.current === item.key) {
        setGlobalError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      detailInFlight.current = false
      if (!silent && selectedKeyRef.current === item.key) setDetailLoading(false)
    }
  }, [])

  const refreshMessageTail = useCallback(async (item: UniversalSession) => {
    if (messageRefreshInFlight.current) return
    messageRefreshInFlight.current = true
    try {
      const page = await api.loadMessagePage(item.config, item.session.id, item.session.directory)
      if (selectedKeyRef.current !== item.key) return
      setDetail((current) => ({ ...current, messages: mergeLatestMessagePage(current.messages, page.messages) }))
      setDetailSessionKey(item.key)
    } catch {
      // Slow reconciliation polling remains the fallback when a live tail refresh fails.
    } finally {
      messageRefreshInFlight.current = false
    }
  }, [])

  const liveTargets = useMemo<SessionLiveTarget[]>(() => machines.flatMap((machine) =>
    machine.state === "online"
      ? machine.agents.map((agent) => ({
          key: `${machine.key}|${agent.id}`,
          profile: machine.profile,
          config: configForAgent(machine, agent)
        }))
      : []
  ), [machines])
  const liveTargetSignature = useMemo(() => liveTargets.map((target) => [
    target.key,
    target.config.backend,
    target.config.agentId || "",
    target.config.host,
    target.config.port,
    target.config.username
  ].join(":" )).join("|"), [liveTargets])

  useEffect(() => {
    if (!liveTargets.length) return
    const subscription = startTaskDeskSessionLiveRefresh({
      targets: liveTargets,
      getSelected: () => {
        const item = selectedSessionRef.current
        return item ? { targetKey: `${item.machineKey}|${item.agent.id}`, sessionID: item.session.id } : null
      },
      onMessage: () => {
        if (!pageIsVisible()) return
        const item = selectedSessionRef.current
        if (item) void refreshMessageTail(item)
      },
      onIndex: () => {
        if (pageIsVisible()) void refreshAll(true)
      },
      onDetail: () => {
        if (!pageIsVisible()) return
        const item = selectedSessionRef.current
        if (item) void loadDetail(item, true)
      }
    })
    return () => subscription.close()
  }, [liveTargetSignature, refreshAll, loadDetail, refreshMessageTail])

  useEffect(() => {
    detailInFlight.current = false
    messageRefreshInFlight.current = false
    if (!selected) {
      setDetail(EMPTY_DETAIL)
      setDetailSessionKey(null)
      setDetailLoading(false)
      setMessageCursor(undefined)
      setMessageHasMore(false)
      setLoadingOlderMessages(false)
      return
    }
    setDetail(EMPTY_DETAIL)
    setDetailSessionKey(null)
    setDetailLoading(true)
    setMessageCursor(undefined)
    setMessageHasMore(false)
    setLoadingOlderMessages(false)
    void loadDetail(selected, false)
    const timer = window.setInterval(() => {
      if (pageIsVisible()) void loadDetail(selected, true)
    }, DETAIL_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [selected?.key, questionRevision, loadDetail])

  useEffect(() => {
    if (!selected) {
      setSessionModels([])
      setSessionModelKey("")
      setSessionModelsLoading(false)
      return
    }
    let cancelled = false
    setSessionModelsLoading(true)
    void withTimeout(
      api.listModels(selected.config, selected.session.directory, selected.session.id),
      `${selected.agent.label} model loading`
    ).then((models) => {
      if (cancelled) return
      setSessionModels(models)
      const nativeModel = selected.session.model
        ? models.find((model) => model.providerID === selected.session.model?.providerID
          && model.modelID === selected.session.model?.id
          && (model.variant || "") === (selected.session.model?.variant || ""))
        : undefined
      const currentModel = nativeModel || models.find((model) => model.isDefault) || models[0]
      setSessionModelKey(currentModel ? modelOptionKey(currentModel) : "")
    }).catch(() => {
      if (!cancelled) {
        setSessionModels([])
        setSessionModelKey("")
      }
    }).finally(() => {
      if (!cancelled) setSessionModelsLoading(false)
    })
    return () => { cancelled = true }
  }, [selected?.key])

  useEffect(() => {
    if (!transcriptRef.current || detailTab !== "conversation" || !detailReady) return
    if (preserveTranscriptPosition.current) {
      preserveTranscriptPosition.current = false
      return
    }
    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
  }, [selected?.key, detail.messages.length, detailTab, detailReady, sessionWaiting])

  useEffect(() => {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify([...pinned]))
  }, [pinned])

  const machineScopedSessions = useMemo(() =>
    sessions.filter((item) => machineFilter === "all" || item.machineKey === machineFilter),
  [sessions, machineFilter])

  const projects = useMemo(() => {
    const map = new Map<string, number>()
    for (const item of machineScopedSessions) map.set(item.projectName, (map.get(item.projectName) || 0) + 1)
    return [...map.entries()].sort((left, right) => right[1] - left[1])
  }, [machineScopedSessions])

  const scopedSessions = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return machineScopedSessions.filter((item) => {
      if (projectFilter !== "all" && item.projectName !== projectFilter) return false
      if (!needle) return true
      return [
        item.session.title,
        item.projectName,
        item.agent.label,
        item.machineName,
        item.session.directory,
        modelLabel(item.session.model)
      ].some((value) => value?.toLowerCase().includes(needle))
    })
  }, [machineScopedSessions, projectFilter, query])

  const counts = useMemo(() => ({
    all: scopedSessions.length,
    working: scopedSessions.filter((item) => normalizeStatus(item.status, item.attention) === "working").length,
    needs: scopedSessions.filter((item) => normalizeStatus(item.status, item.attention) === "needs-you").length,
    idle: scopedSessions.filter((item) => normalizeStatus(item.status, item.attention) === "idle").length,
    pinned: scopedSessions.filter((item) => pinned.has(item.key)).length
  }), [scopedSessions, pinned])

  const filteredSessions = useMemo(() => scopedSessions.filter((item) => {
    const normalized = normalizeStatus(item.status, item.attention)
    if (filter === "working" && normalized !== "working") return false
    if (filter === "needs-you" && normalized !== "needs-you") return false
    if (filter === "idle" && normalized !== "idle") return false
    if (filter === "pinned" && !pinned.has(item.key)) return false
    return true
  }), [scopedSessions, filter, pinned])

  async function loadOlderMessages() {
    if (!selected || !detailReady || !messageHasMore || !messageCursor || loadingOlderMessages) return
    const transcript = transcriptRef.current
    const previousHeight = transcript?.scrollHeight ?? 0
    const previousTop = transcript?.scrollTop ?? 0
    setLoadingOlderMessages(true)
    setGlobalError(null)
    try {
      const page = await api.loadMessagePage(
        selected.config,
        selected.session.id,
        selected.session.directory,
        messageCursor
      )
      if (selectedKeyRef.current !== selected.key) return
      if (page.messages.length) preserveTranscriptPosition.current = true
      setDetail((current) => ({
        ...current,
        messages: prependOlderMessagePage(current.messages, page.messages)
      }))
      setMessageCursor(page.before)
      setMessageHasMore(page.hasMore)
      if (page.messages.length && transcript) {
        window.requestAnimationFrame(() => {
          if (!transcriptRef.current || selectedKeyRef.current !== selected.key) return
          transcriptRef.current.scrollTop = previousTop + (transcriptRef.current.scrollHeight - previousHeight)
        })
      }
    } catch (reason) {
      if (selectedKeyRef.current === selected.key) {
        setGlobalError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (selectedKeyRef.current === selected.key) setLoadingOlderMessages(false)
    }
  }

  async function sendPrompt() {
    if (!selected || !composer.trim() || sending) return
    const text = composer.trim()
    setComposer("")
    setSending(true)
    setGlobalError(null)
    try {
      const model = selectedSessionModel
        ? { providerID: selectedSessionModel.providerID, modelID: selectedSessionModel.modelID, variant: selectedSessionModel.variant }
        : selected.session.model
          ? { providerID: selected.session.model.providerID, modelID: selected.session.model.id, variant: selected.session.model.variant }
          : undefined
      await api.sendPrompt(selected.config, selected.session.id, text, selected.session.directory, model)
      await refreshMessageTail(selected)
      await refreshAll(true)
    } catch (reason) {
      setComposer((current) => current || text)
      setGlobalError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSending(false)
    }
  }

  async function stopSession() {
    if (!selected) return
    try {
      await api.abort(selected.config, selected.session.id, selected.session.directory)
      await loadDetail(selected, true)
      await refreshAll(true)
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  async function renameSelected() {
    if (!selected) return
    const nextTitle = window.prompt("Session title", selected.session.title || "")
    if (!nextTitle?.trim() || nextTitle.trim() === selected.session.title) return
    try {
      await api.renameSession(selected.config, selected.session.id, nextTitle.trim(), selected.session.directory)
      await refreshAll(true)
    } catch (reason) {
      setGlobalError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  function selectMachine(machine: MachineSource) {
    setMachineFilter(machine.key)
    setProjectFilter("all")
    setDetailTab("conversation")
    setSelectedKey((current) => {
      const currentItem = current ? sessions.find((item) => item.key === current) : undefined
      if (currentItem?.machineKey === machine.key) return current
      return sessions.find((item) => item.machineKey === machine.key)?.key || null
    })
  }

  function selectProject(project: string) {
    setProjectFilter(project)
    setDetailTab("conversation")
    const candidate = sessions.find((item) =>
      (machineFilter === "all" || item.machineKey === machineFilter) && item.projectName === project
    )
    if (candidate) setSelectedKey(candidate.key)
  }

  const selectedMachine = selected ? machines.find((machine) => machine.key === selected.machineKey) : undefined
  const activeProfile = profiles.find((profile) => profile.id === activeProfileID) || profiles[0]
  const connectionProfile = profiles.find((profile) => profile.id === connectionProfileID) || null
  const selectedQuestions = detailReady ? detail.questions : []
  const selectedPermissions = detailReady ? detail.permissions : []
  const selectedModelLabel = selectedSessionModel ? modelLabel(selectedSessionModel) : modelLabel(selected?.session.model)

  if (classicOpen) {
    return (
      <div className="uw-classic-shell">
        <div className="uw-classic-bar">
          <BeautifulButton onClick={() => setClassicOpen(false)}>← Universal workspace</BeautifulButton>
          <span>Classic session UI</span>
        </div>
        <div className="uw-classic-host">{legacyView}</div>
      </div>
    )
  }

  return (
    <div className="uw-shell">
      <header className="uw-topbar">
        <div className="uw-brand">
          <span className="uw-brand-mark">H</span>
          <div>
            <strong>Harness Remote</strong>
            <small>Universal workspace</small>
          </div>
        </div>

        <div className="uw-global-search">
          <SearchIcon size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions, projects, agents, machines…"
          />
          <kbd>⌘K</kbd>
        </div>

        <div className="uw-top-actions">
          <BeautifulButton onClick={() => void refreshAll(true)} disabled={refreshing} title="Refresh everything">
            <RefreshIcon size={16} />
            <span className="uw-desktop-label">{refreshing ? "Refreshing" : "Refresh"}</span>
          </BeautifulButton>
          <BeautifulButton onClick={() => setClassicOpen(true)} title="Open the existing interface">
            <ChatIcon size={16} />
            <span className="uw-desktop-label">Classic</span>
          </BeautifulButton>
          <BeautifulButton
            onClick={() => activeProfile && setConnectionProfileID(activeProfile.id)}
            title="Connection settings"
          >
            <SettingsIcon size={16} />
          </BeautifulButton>
        </div>
      </header>

      <div className="uw-layout">
        <aside className="uw-nav">
          <BeautifulButton variant="primary" className="uw-new-button" onClick={() => setNewSessionOpen(true)}>
            <PlusIcon size={16} />
            New Session
          </BeautifulButton>

          <section className="uw-nav-section">
            <span className="uw-nav-label">Quick views</span>
            <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
              <ChatIcon size={15} /><span>All Sessions</span><b>{counts.all}</b>
            </button>
            <button className={filter === "needs-you" ? "active" : ""} onClick={() => setFilter("needs-you")}>
              <span className="uw-nav-symbol">!</span><span>Needs You</span><b className="attention">{counts.needs}</b>
            </button>
            <button className={filter === "working" ? "active" : ""} onClick={() => setFilter("working")}>
              <span className="uw-nav-symbol">●</span><span>Working</span><b>{counts.working}</b>
            </button>
            <button className={filter === "idle" ? "active" : ""} onClick={() => setFilter("idle")}>
              <span className="uw-nav-symbol">○</span><span>Idle</span><b>{counts.idle}</b>
            </button>
            <button className={filter === "pinned" ? "active" : ""} onClick={() => setFilter("pinned")}>
              <span className="uw-nav-symbol">★</span><span>Pinned</span><b>{counts.pinned}</b>
            </button>
          </section>

          <section className="uw-nav-section">
            <div className="uw-nav-heading">
              <span className="uw-nav-label">Projects</span>
              <button type="button" title="Show all projects" onClick={() => setProjectFilter("all")}>×</button>
            </div>
            {projects.slice(0, 8).map(([project, count]) => (
              <button key={project} className={projectFilter === project ? "active" : ""} onClick={() => selectProject(project)}>
                <FolderIcon size={15} /><span title={project}>{project}</span><b>{count}</b>
              </button>
            ))}
            {projects.length === 0 ? <p className="uw-nav-empty">Projects appear from native sessions.</p> : null}
          </section>

          <section className="uw-nav-section uw-machines-section">
            <div className="uw-nav-heading">
              <span className="uw-nav-label">Machines</span>
              <button type="button" onClick={() => {
                setMachineFilter("all")
                setProjectFilter("all")
              }} title="Show every machine">×</button>
            </div>
            {machines.map((machine) => (
              <button
                key={machine.key}
                className={machineFilter === machine.key ? "active" : ""}
                onClick={() => selectMachine(machine)}
                onDoubleClick={() => setConnectionProfileID(machine.profile.id)}
                title={machine.error || `${machine.profile.config.host}:${machine.profile.config.port}`}
              >
                <ServerIcon size={15} />
                <span>{machineLabel(machine)}</span>
                <i className={`uw-machine-dot ${machine.state}`} />
              </button>
            ))}
          </section>

          <div className="uw-nav-bottom">
            <button type="button" className={filter === "needs-you" ? "active" : ""} onClick={() => setFilter("needs-you")}>
              <span className="uw-nav-symbol">!</span><span>Needs You</span><b className="attention">{counts.needs}</b>
            </button>
          </div>
        </aside>

        <section className="uw-session-column">
          <div className="uw-session-column-header">
            <div>
              <h2>Sessions</h2>
              <span>{filteredSessions.length} visible</span>
            </div>
            <button type="button" title="Clear filters" onClick={() => {
              setFilter("all")
              setProjectFilter("all")
              setMachineFilter("all")
              setQuery("")
            }}>
              <MoreVerticalIcon size={16} />
            </button>
          </div>

          <div className="uw-filter-row">
            <BeautifulPill active={filter === "all"} onClick={() => setFilter("all")} count={counts.all}>All</BeautifulPill>
            <BeautifulPill active={filter === "working"} onClick={() => setFilter("working")} count={counts.working}>Working</BeautifulPill>
            <BeautifulPill active={filter === "needs-you"} onClick={() => setFilter("needs-you")} count={counts.needs}>Needs You</BeautifulPill>
          </div>

          <div className="uw-session-list">
            {loading && sessions.length === 0 ? (
              <div className="uw-empty-panel"><LoadingIcon size={22} /><strong>Loading native sessions…</strong></div>
            ) : filteredSessions.length === 0 ? (
              <div className="uw-empty-panel">
                <ChatIcon size={24} />
                <strong>No sessions match this view.</strong>
                <span>Change filters or start a new session.</span>
              </div>
            ) : filteredSessions.map((item) => (
              <SessionCard
                key={item.key}
                item={item}
                selected={selectedKey === item.key}
                pinned={pinned.has(item.key)}
                onSelect={() => {
                  setSelectedKey(item.key)
                  setDetailTab("conversation")
                  onOpenSessionDetail?.()
                }}
                onTogglePin={() => setPinned((current) => {
                  const next = new Set(current)
                  if (next.has(item.key)) next.delete(item.key)
                  else next.add(item.key)
                  return next
                })}
              />
            ))}
          </div>
        </section>

        <main className="uw-main">
          {globalError ? (
            <div className="uw-global-error">
              <span>{globalError}</span>
              <button type="button" onClick={() => setGlobalError(null)}>×</button>
            </div>
          ) : null}

          {!selected ? (
            <div className="uw-welcome">
              <div className="uw-welcome-icon"><ChatIcon size={32} /></div>
              <h1>{loading ? "Connecting to your agents…" : "Your agents, one workspace."}</h1>
              <p>Sessions stay native to Codex, Claude Code, OpenCode, PI and OMP. Harness Remote only gives them one place to live.</p>
              <BeautifulButton variant="primary" onClick={() => setNewSessionOpen(true)}>
                <PlusIcon size={16} /> New Session
              </BeautifulButton>
            </div>
          ) : (
            <>
              <header className="uw-session-header">
                {mobilePane === "detail" && onBackToSessionList ? (
                  <button
                    type="button"
                    className="uw-session-back"
                    onClick={onBackToSessionList}
                    aria-label={t("action.backToSessions")}
                  >
                    <ArrowLeftIcon size={15} />
                    <span>{t("nav.sessions")}</span>
                  </button>
                ) : null}
                <div className="uw-session-heading">
                  <div className="uw-session-heading-title">
                    <h1>{selected.session.title || "Untitled session"}</h1>
                    <button
                      type="button"
                      className={`uw-header-pin${pinned.has(selected.key) ? " pinned" : ""}`}
                      onClick={() => setPinned((current) => {
                        const next = new Set(current)
                        if (next.has(selected.key)) next.delete(selected.key)
                        else next.add(selected.key)
                        return next
                      })}
                      title={pinned.has(selected.key) ? "Unpin" : "Pin"}
                    >
                      {pinned.has(selected.key) ? "★" : "☆"}
                    </button>
                  </div>
                  <div className="uw-context-strip">
                    <span><small>Project</small><b>{selected.projectName}</b></span>
                    <span><small>Harness</small><b>{selected.agent.label}</b></span>
                    <span className="uw-context-model">
                      <small>Model</small>
                      {sessionModels.length > 0 ? (
                        <select
                          className="uw-context-model-select"
                          value={sessionModelKey}
                          onChange={(event) => setSessionModelKey(event.target.value)}
                          disabled={sessionModelsLoading || sending}
                          title="Model used for the next turn"
                        >
                          {sessionModels.map((model) => (
                            <option key={modelOptionKey(model)} value={modelOptionKey(model)}>
                              {model.modelName}{model.variant ? ` (${model.variant})` : ""}
                            </option>
                          ))}
                        </select>
                      ) : <b>{sessionModelsLoading ? "Loading…" : selectedModelLabel}</b>}
                    </span>
                    <span><small>Machine</small><b>{selected.machineName}</b></span>
                    <span className={statusClass(selected.status, selected.attention)}><small>Status</small><b>{statusLabel(selected.status, selected.attention)}</b></span>
                  </div>
                </div>
                <div className="uw-session-actions">
                  <BeautifulButton variant="primary" onClick={() => setHandoffOpen(true)}>Continue with…</BeautifulButton>
                  <BeautifulButton onClick={() => void renameSelected()}>Rename</BeautifulButton>
                  {normalizeStatus(selected.status, selected.attention) === "working" ? (
                    <BeautifulButton onClick={() => void stopSession()}><StopCircleIcon size={15} /> Stop</BeautifulButton>
                  ) : null}
                  <BeautifulButton onClick={() => setInspectorOpen((value) => !value)} title="Toggle inspector">
                    <PanelRightIcon size={16} />
                  </BeautifulButton>
                </div>
              </header>

              <div className="uw-detail-tabs">
                <button type="button" className={detailTab === "conversation" ? "active" : ""} onClick={() => setDetailTab("conversation")}>Conversation</button>
                <button type="button" className={detailTab === "changes" ? "active" : ""} onClick={() => setDetailTab("changes")}>
                  Changes <span>{detailReady ? detail.diff.length : 0}</span>
                </button>
              </div>

              {detailTab === "conversation" ? (
                <TaskDeskConversation
                  messages={detail.messages}
                  agentLabel={selected.agent.label}
                  agentBackend={selected.agent.backend}
                  loading={detailLoading}
                  waiting={sessionWaiting}
                  ready={detailReady}
                  hasMore={messageHasMore}
                  loadingOlder={loadingOlderMessages}
                  onLoadOlder={loadOlderMessages}
                  draft={composer}
                  onDraftChange={setComposer}
                  onSend={sendPrompt}
                  sending={sending}
                  placeholder={`Continue this ${selected.agent.label} session…`}
                  emptyText="This session has no messages yet."
                  directory={selected.session.directory}
                  renderMessage={(message) => (
                    <MessageBubble
                      key={message.info.id}
                      message={message}
                      agentLabel={selected.agent.label}
                      agentBackend={selected.agent.backend}
                    />
                  )}
                />
              ) : detailLoading || !detailReady ? (
                <div className="uw-changes-pane">
                  <div className="uw-empty-panel"><LoadingIcon size={22} /><strong>Loading session…</strong></div>
                </div>
              ) : (
                <div className="uw-changes-pane">
                  <header>
                    <div>
                      <h2>Workspace changes</h2>
                      <p>Native diff reported by {selected.agent.label} for this session.</p>
                    </div>
                    <div className="uw-diff-total">
                      <span>+{detail.diff.reduce((sum, file) => sum + file.additions, 0)}</span>
                      <span>−{detail.diff.reduce((sum, file) => sum + file.deletions, 0)}</span>
                    </div>
                  </header>
                  {detail.diff.length === 0 ? (
                    <div className="uw-empty-panel"><strong>No changed files reported.</strong></div>
                  ) : detail.diff.map((file) => (
                    <details className="uw-diff-file" key={file.file}>
                      <summary>
                        <code>{file.file}</code>
                        <span><b>+{file.additions}</b><i>−{file.deletions}</i></span>
                      </summary>
                      {file.patch ? <pre>{file.patch}</pre> : <p>No patch text available from this harness.</p>}
                    </details>
                  ))}
                </div>
              )}
            </>
          )}
        </main>

        {selected && inspectorOpen ? (
          <aside className="uw-inspector">
            <header>
              <div>
                <h3>Session details</h3>
                <span>Native session metadata</span>
              </div>
              <button type="button" onClick={() => setInspectorOpen(false)}><CloseIcon size={15} /></button>
            </header>

            <section className="uw-inspector-section">
              <span className="uw-inspector-label">Status</span>
              <div className="uw-status-line">
                <i className={`uw-machine-dot ${normalizeStatus(selected.status, selected.attention) === "working" ? "online" : "idle"}`} />
                <strong>{statusLabel(selected.status, selected.attention)}</strong>
                <small>{formatRelative(selected.session.time.updated)} ago</small>
              </div>
            </section>

            <section className="uw-inspector-grid">
              <span>Project</span><b>{selected.projectName}</b>
              <span>Harness</span><b>{selected.agent.label}</b>
              <span>Model</span><b>{selectedModelLabel}</b>
              <span>Machine</span><b>{selected.machineName}</b>
              <span>Working directory</span><code>{selected.session.directory}</code>
              <span>Branch</span><b>{detailReady ? detail.vcs?.branch || "Unknown" : "Loading…"}</b>
              <span>Last active</span><b>{formatRelative(selected.session.time.updated)} ago</b>
            </section>

            {(selectedPermissions.length > 0 || selectedQuestions.length > 0) ? (
              <section className="uw-inspector-section">
                <span className="uw-inspector-label">Needs You</span>
                {selectedPermissions.map((permission) => (
                  <div className="uw-attention-card" key={permission.id}>
                    <strong>Permission request</strong>
                    <p>{permission.permission}</p>
                    {permission.patterns?.length ? <code>{permission.patterns.join(", ")}</code> : null}
                    <div className="uw-attention-actions">
                      <BeautifulButton variant="danger" onClick={() => void api.replyPermission(selected.config, permission.id, "reject", selected.session.directory).then(() => setQuestionRevision((value) => value + 1))}>Reject</BeautifulButton>
                      <BeautifulButton onClick={() => void api.replyPermission(selected.config, permission.id, "once", selected.session.directory).then(() => setQuestionRevision((value) => value + 1))}>Once</BeautifulButton>
                      <BeautifulButton variant="primary" onClick={() => void api.replyPermission(selected.config, permission.id, "always", selected.session.directory).then(() => setQuestionRevision((value) => value + 1))}>Always</BeautifulButton>
                    </div>
                  </div>
                ))}
                {selectedQuestions.map((request) => (
                  <QuestionPanel
                    key={request.id}
                    request={request}
                    config={selected.config}
                    directory={selected.session.directory}
                    onResolved={() => setQuestionRevision((value) => value + 1)}
                  />
                ))}
              </section>
            ) : null}

            <section className="uw-inspector-section">
              <div className="uw-inspector-section-heading">
                <span className="uw-inspector-label">Files touched</span>
                <button type="button" onClick={() => setDetailTab("changes")}>{detailReady && detail.diff.length ? `View ${detail.diff.length}` : ""}</button>
              </div>
              <div className="uw-file-list">
                {detailReady ? detail.diff.slice(0, 8).map((file) => (
                  <button type="button" key={file.file} onClick={() => setDetailTab("changes")}>
                    <code>{file.file}</code>
                    <span><b>+{file.additions}</b><i>−{file.deletions}</i></span>
                  </button>
                )) : null}
                {detailReady && detail.diff.length === 0 ? <p>No diff reported yet.</p> : null}
                {!detailReady ? <p>Loading session…</p> : null}
              </div>
            </section>

            {detailReady && detail.todos.length > 0 ? (
              <section className="uw-inspector-section">
                <span className="uw-inspector-label">Agent plan</span>
                <div className="uw-todo-list">
                  {detail.todos.map((todo) => (
                    <div key={todo.id}>
                      <span className={`uw-todo-state uw-todo-${todo.status}`}>{todo.status === "completed" ? "✓" : "•"}</span>
                      <span>{todo.content}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="uw-inspector-section">
              <span className="uw-inspector-label">Continue on another agent</span>
              <p className="uw-inspector-copy">Hand off the recent context to another native harness session.</p>
              <div className="uw-agent-buttons">
                {machines.flatMap((machine) => machine.agents)
                  .filter((agent, index, all) => all.findIndex((candidate) => candidate.id === agent.id) === index)
                  .filter((agent) => agent.id !== selected.agent.id)
                  .slice(0, 4)
                  .map((agent) => (
                    <button type="button" key={agent.id} onClick={() => setHandoffOpen(true)}>{agent.label}</button>
                  ))}
              </div>
            </section>

            <section className="uw-inspector-section uw-inspector-danger">
              <BeautifulButton
                variant="danger"
                onClick={() => {
                  if (!window.confirm(`Delete "${selected.session.title}"?`)) return
                  void api.deleteSession(selected.config, selected.session.id, selected.session.directory)
                    .then(() => refreshAll(true))
                    .catch((reason) => setGlobalError(reason instanceof Error ? reason.message : String(reason)))
                }}
              >
                Delete session
              </BeautifulButton>
            </section>
          </aside>
        ) : null}
      </div>

      {newSessionOpen ? (
        <NewSessionModal
          machines={machines.filter((machine) => machine.state === "online" && machine.agents.length > 0)}
          initialMachineKey={selectedMachine?.key}
          initialProject={selected?.session.directory}
          initialAgentId={selected?.agent.id}
          onClose={() => setNewSessionOpen(false)}
          onCreated={(machine, agent, created) => {
            setNewSessionOpen(false)
            void refreshAll(true).then(() => {
              setSelectedKey(`${machine.key}|${agent.id}|${created.id}`)
            })
          }}
        />
      ) : null}

      {handoffOpen && selected ? (
        <HandoffModal
          current={selected}
          messages={detailReady ? detail.messages : []}
          machines={machines.filter((machine) => machine.state === "online" && machine.agents.length > 0)}
          onClose={() => setHandoffOpen(false)}
          onCreated={(machine, agent, created) => {
            setHandoffOpen(false)
            void refreshAll(true).then(() => setSelectedKey(`${machine.key}|${agent.id}|${created.id}`))
          }}
        />
      ) : null}

      {connectionProfile ? (
        <ConnectionEditor
          profile={connectionProfile}
          onClose={() => setConnectionProfileID(null)}
          onSave={(nextProfile) => {
            const nextProfiles = profiles.map((profile) => profile.id === nextProfile.id ? nextProfile : profile)
            onPersistProfiles(nextProfiles, nextProfile.id)
            setConnectionProfileID(null)
          }}
        />
      ) : null}
    </div>
  )
}
