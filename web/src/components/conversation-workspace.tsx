import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react"
import {
  isThemePreference,
  loadLanguage,
  loadThemePreference,
  persistLanguage,
  persistThemePreference,
  type ThemePreference
} from "../appPreferences"
import { createTranslator, languageOptions, type LanguageCode } from "../i18n"
import { discoverMachine, selectableMachineAgents } from "../machineClient"
import {
  taskClient,
  type MachineProject,
  type MachineTask
} from "../taskClient"
import type { MachineAgentHost, MachineSnapshot, ModelOption } from "../types"
import type { WorkspaceMachine } from "../workspaceMachines"
import {
  ChatIcon,
  FolderIcon,
  LoadingIcon,
  PlusIcon,
  RefreshIcon,
  ServerIcon,
  SettingsIcon
} from "../Icons"
import { ModelPicker, modelOptionKey } from "./model-picker"
import { ConversationDetail } from "./conversation-detail"
import "../taskdesk-workthreads.css"
import "../taskdesk-mobile-navigation.css"
import "../taskdesk-focus-layout.css"
import "../conversation-control-plane.css"

type Props = {
  machines: WorkspaceMachine[]
  activeMachineID: string
  onActiveMachineID: (id: string) => void
  onManageMachines: () => void
}

type Runtime = {
  machine: WorkspaceMachine
  snapshot: MachineSnapshot | null
  projects: MachineProject[]
  conversations: MachineTask[]
  agents: MachineAgentHost[]
  state: "loading" | "online" | "offline"
  error?: string
}

type ConversationRecord = {
  key: string
  runtime: Runtime
  conversation: MachineTask
}

type ProjectRecord = {
  key: string
  runtime: Runtime
  project: MachineProject
  count: number
}

type ConversationState = "working" | "ready" | "attention" | "stopped"
type ConversationFilter = "all" | "working" | "attention"
type WorkspaceSection = "machines" | "projects" | "harnesses" | "filters"

const WORKSPACE_COLLAPSED_KEY = "harness-remote.v3.workspace-collapsed"
const WORKSPACE_SECTIONS_COLLAPSED_KEY = "harness-remote.v3.workspace-sections-collapsed"
const CONVERSATION_PANE_WIDTH_KEY = "harness-remote.v3.conversation-pane-width"
const CONVERSATION_DRAWER_OPEN_KEY = "harness-remote.v3.conversation-drawer-open"

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function conversationTitle(conversation: MachineTask): string {
  if (conversation.title?.trim()) return conversation.title.trim()
  const line = conversation.prompt.trim().split(/\r?\n/).find(Boolean)?.trim() || "Untitled conversation"
  return line.length > 86 ? `${line.slice(0, 83)}...` : line
}

function conversationAgentID(conversation: MachineTask): string {
  return conversation.run?.agentId || conversation.agentId
}

function conversationState(conversation: MachineTask): ConversationState {
  if (conversation.status === "starting" || conversation.status === "running") return "working"
  if (conversation.status === "failed") return "attention"
  if (conversation.status === "cancelled") return "stopped"
  return "ready"
}

function conversationStateLabel(conversation: MachineTask): string {
  const state = conversationState(conversation)
  if (state === "working") return "Working"
  if (state === "attention") return "Needs attention"
  if (state === "stopped") return "Stopped"
  return "Ready"
}

function filterMatches(conversation: MachineTask, filter: ConversationFilter): boolean {
  const state = conversationState(conversation)
  if (filter === "all") return true
  if (filter === "working") return state === "working"
  return state === "attention" || state === "stopped"
}

function formatRelative(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ""
  const delta = Math.max(0, Date.now() - timestamp)
  if (delta < 60_000) return "now"
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))}m`
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h`
  return `${Math.round(delta / 86_400_000)}d`
}

function modelLabel(conversation: MachineTask): string {
  const model = conversation.run?.model ?? conversation.model
  if (!model) return "Default model"
  const variant = model.variant ? ` · ${model.variant}` : ""
  return `${model.modelID}${variant}`
}

function agentForConversation(record: ConversationRecord): MachineAgentHost | undefined {
  return record.runtime.agents.find((agent) => agent.id === conversationAgentID(record.conversation))
}

function harnessReady(agent: MachineAgentHost): boolean {
  return agent.state === "available" || agent.state === "configured"
}

function harnessStateLabel(agent: MachineAgentHost): string {
  if (agent.state === "available") return "Running"
  if (agent.state === "configured") return "Ready"
  if (agent.state === "unavailable") return "Unavailable"
  return agent.state
}

function loadCollapsedWorkspaceSections(): Set<WorkspaceSection> {
  try {
    const value = JSON.parse(localStorage.getItem(WORKSPACE_SECTIONS_COLLAPSED_KEY) || "[]")
    if (!Array.isArray(value)) return new Set()
    const allowed = new Set<WorkspaceSection>(["machines", "projects", "harnesses", "filters"])
    return new Set(value.filter((item): item is WorkspaceSection => allowed.has(item)))
  } catch {
    return new Set()
  }
}

function ConversationSettingsModal({ onClose }: { onClose: () => void }) {
  const [language, setLanguage] = useState<LanguageCode>(loadLanguage)
  const [theme, setTheme] = useState<ThemePreference>(loadThemePreference)
  const t = useMemo(() => createTranslator(language), [language])

  function changeLanguage(value: string) {
    const next = languageOptions.find((option) => option.code === value)?.code
    if (!next) return
    setLanguage(next)
    persistLanguage(next)
  }

  function changeTheme(value: string) {
    if (!isThemePreference(value)) return
    setTheme(value)
    persistThemePreference(value)
  }

  return (
    <div className="tdw-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="tdw-modal tdw-settings-modal hr-settings-modal" role="dialog" aria-modal="true" aria-label={t("nav.settings")} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span>Harness Remote</span><h2>{t("nav.settings")}</h2></div>
          <button type="button" onClick={onClose} aria-label={t("action.close")}>×</button>
        </header>
        <div className="tdw-modal-body">
          <div className="tdw-form-row">
            <label>
              <span>{t("settings.theme")}</span>
              <select value={theme} onChange={(event) => changeTheme(event.target.value)}>
                <option value="system">{t("settings.themeSystem")}</option>
                <option value="light">{t("settings.themeLight")}</option>
                <option value="dark">{t("settings.themeDark")}</option>
              </select>
            </label>
            <label>
              <span>{t("settings.language")}</span>
              <select value={language} onChange={(event) => changeLanguage(event.target.value)}>
                {languageOptions.map((option) => <option value={option.code} key={option.code}>{option.label}</option>)}
              </select>
            </label>
          </div>
          <p className="tdw-safety-note">Appearance and language are shared across Harness Remote on this device.</p>
        </div>
        <footer><button type="button" className="tdw-button primary" onClick={onClose}>{t("action.close")}</button></footer>
      </section>
    </div>
  )
}

function NewConversationModal({
  runtimes,
  initialMachineID,
  initialProjectKey,
  onClose,
  onCreated
}: {
  runtimes: Runtime[]
  initialMachineID: string
  initialProjectKey: string
  onClose: () => void
  onCreated: (runtime: Runtime, conversation: MachineTask) => void
}) {
  const online = runtimes.filter((runtime) => runtime.state === "online" && runtime.projects.length > 0 && runtime.agents.length > 0)
  const initialProject = initialProjectKey.includes(":") ? initialProjectKey.split(":").slice(1).join(":") : ""
  const initialRuntime = online.find((runtime) => runtime.machine.id === initialMachineID) || online[0]
  const [machineID, setMachineID] = useState(initialRuntime?.machine.id || "")
  const runtime = online.find((candidate) => candidate.machine.id === machineID) || initialRuntime
  const [projectID, setProjectID] = useState(
    runtime?.projects.some((project) => project.id === initialProject) ? initialProject : runtime?.projects[0]?.id || ""
  )
  const [agentID, setAgentID] = useState(runtime?.agents[0]?.id || "")
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelKey, setModelKey] = useState("")
  const [modelsLoading, setModelsLoading] = useState(false)
  const [prompt, setPrompt] = useState("")
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    if (!runtime) return
    if (!runtime.projects.some((project) => project.id === projectID)) setProjectID(runtime.projects[0]?.id || "")
    if (!runtime.agents.some((agent) => agent.id === agentID)) setAgentID(runtime.agents[0]?.id || "")
  }, [runtime?.machine.id])

  useEffect(() => {
    if (!runtime || !agentID) {
      setModels([])
      setModelKey("")
      return
    }
    const current = ++generation.current
    setModelsLoading(true)
    setError(null)
    void taskClient.listAgentModels(runtime.machine.config, agentID).then((catalog) => {
      if (generation.current !== current) return
      setModels(catalog.models)
      const selected = catalog.models.find((model) => model.isDefault) || catalog.models[0]
      setModelKey(selected ? modelOptionKey(selected) : "")
    }).catch((reason) => {
      if (generation.current === current) {
        setModels([])
        setModelKey("")
        setError(errorText(reason))
      }
    }).finally(() => {
      if (generation.current === current) setModelsLoading(false)
    })
  }, [runtime?.machine.id, agentID])

  const project = runtime?.projects.find((candidate) => candidate.id === projectID)
  const agent = runtime?.agents.find((candidate) => candidate.id === agentID)
  const selectedModel = models.find((model) => modelOptionKey(model) === modelKey)
  const canStart = Boolean(runtime && project && agent && prompt.trim()) && !starting && !modelsLoading

  async function start() {
    if (!runtime || !project || !agent || !canStart) return
    setStarting(true)
    setError(null)
    try {
      let conversation = await taskClient.createTask(runtime.machine.config, {
        projectId: project.id,
        agentId: agent.id,
        prompt: prompt.trim(),
        model: selectedModel ? {
          providerID: selectedModel.providerID,
          modelID: selectedModel.modelID,
          variant: selectedModel.variant
        } : undefined
      })
      conversation = await taskClient.launch(runtime.machine.config, conversation.id)
      onCreated(runtime, conversation)
      onClose()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setStarting(false)
    }
  }

  if (!runtime) {
    return (
      <div className="tdw-modal-backdrop" role="presentation" onMouseDown={onClose}>
        <section className="tdw-modal" role="dialog" aria-modal="true" aria-label="New conversation" onMouseDown={(event) => event.stopPropagation()}>
          <header><div><span>New conversation</span><h2>No coding machine is ready</h2></div><button type="button" onClick={onClose}>×</button></header>
          <div className="tdw-modal-body"><p>Connect a machine with at least one project and one available coding agent.</p></div>
        </section>
      </div>
    )
  }

  return (
    <div className="tdw-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="tdw-modal hr-new-conversation-modal" role="dialog" aria-modal="true" aria-label="New conversation" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span>New conversation</span><h2>Start with the best agent for this work</h2></div>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="tdw-modal-body">
          <div className="tdw-form-row">
            <label><span>Machine</span><select value={runtime.machine.id} onChange={(event) => setMachineID(event.target.value)}>{online.map((item) => <option value={item.machine.id} key={item.machine.id}>{item.snapshot?.machine.name || item.machine.name}</option>)}</select></label>
            <label><span>Project</span><select value={projectID} onChange={(event) => setProjectID(event.target.value)}>{runtime.projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          </div>
          <div className="tdw-form-row">
            <label><span>Coding agent</span><select value={agentID} onChange={(event) => setAgentID(event.target.value)}>{runtime.agents.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
            <label><span>Model</span><ModelPicker models={models} value={modelKey} onChange={setModelKey} disabled={starting} loading={modelsLoading} /></label>
          </div>
          <label className="tdw-prompt-field"><span>First message</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} autoFocus placeholder="What do you want to build, fix or understand?" /></label>
          <div className="hr-workspace-note">
            <strong>Uses the real project workspace</strong>
            <span>No hidden worktree is created. You can continue this conversation with another coding agent at any time.</span>
          </div>
          {error ? <div className="tdw-inline-error" role="alert">{error}</div> : null}
        </div>
        <footer>
          <button type="button" className="tdw-button secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="tdw-button primary" disabled={!canStart} onClick={() => void start()}>{starting ? <><LoadingIcon size={15} /> Starting...</> : <><PlusIcon size={15} /> Start conversation</>}</button>
        </footer>
      </section>
    </div>
  )
}

export function ConversationWorkspace({ machines, activeMachineID, onActiveMachineID, onManageMachines }: Props) {
  const [runtimes, setRuntimes] = useState<Runtime[]>(() => machines.map((machine) => ({ machine, snapshot: null, projects: [], conversations: [], agents: [], state: "loading" })))
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [revision, setRevision] = useState(0)
  const [selectedMachineID, setSelectedMachineID] = useState("all")
  const [selectedProjectKey, setSelectedProjectKey] = useState("all")
  const [conversationFilter, setConversationFilter] = useState<ConversationFilter>("all")
  const [selectedConversationKey, setSelectedConversationKey] = useState<string | null>(null)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const [newConversationOpen, setNewConversationOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [conversationDrawerOpen, setConversationDrawerOpen] = useState(() => localStorage.getItem(CONVERSATION_DRAWER_OPEN_KEY) === "true")
  const [search, setSearch] = useState("")
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(() => localStorage.getItem(WORKSPACE_COLLAPSED_KEY) === "true")
  const [collapsedSections, setCollapsedSections] = useState<Set<WorkspaceSection>>(loadCollapsedWorkspaceSections)
  const [conversationPaneWidth, setConversationPaneWidth] = useState(() => {
    const saved = Number(localStorage.getItem(CONVERSATION_PANE_WIDTH_KEY))
    return Number.isFinite(saved) && saved >= 280 && saved <= 500 ? saved : 350
  })
  const refreshGeneration = useRef(0)

  useEffect(() => {
    const generation = ++refreshGeneration.current
    let cancelled = false
    if (machines.length === 0) {
      setRuntimes([])
      setLoaded(true)
      return
    }
    setRefreshing(true)
    setRuntimes((current) => machines.map((machine) => {
      const previous = current.find((runtime) => runtime.machine.id === machine.id)
      return previous ? { ...previous, machine, state: previous.state === "offline" ? "loading" : previous.state } : { machine, snapshot: null, projects: [], conversations: [], agents: [], state: "loading" }
    }))
    void Promise.all(machines.map(async (machine): Promise<Runtime> => {
      try {
        const snapshot = await discoverMachine(machine.config)
        if (!snapshot) return { machine, snapshot: null, projects: [], conversations: [], agents: [], state: "offline", error: "This endpoint is not a Harness machine daemon." }
        const [projects, conversations] = await Promise.all([
          taskClient.listProjects(machine.config),
          taskClient.listTasks(machine.config)
        ])
        return {
          machine,
          snapshot,
          projects,
          conversations: [...conversations].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
          agents: selectableMachineAgents(snapshot),
          state: "online"
        }
      } catch (reason) {
        return { machine, snapshot: null, projects: [], conversations: [], agents: [], state: "offline", error: errorText(reason) }
      }
    })).then((next) => {
      if (!cancelled && refreshGeneration.current === generation) setRuntimes(next)
    }).finally(() => {
      if (!cancelled && refreshGeneration.current === generation) {
        setLoaded(true)
        setRefreshing(false)
      }
    })
    return () => { cancelled = true }
  }, [machines, revision])

  useEffect(() => {
    if (!loaded) return
    let timer: number | undefined
    const schedule = () => {
      if (timer !== undefined) window.clearInterval(timer)
      timer = undefined
      if (document.visibilityState === "visible") timer = window.setInterval(() => setRevision((value) => value + 1), 10_000)
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") setRevision((value) => value + 1)
      schedule()
    }
    schedule()
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      if (timer !== undefined) window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [loaded])

  useEffect(() => {
    if (!conversationDrawerOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConversationDrawerOpen(false)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [conversationDrawerOpen])

  useEffect(() => { localStorage.setItem(WORKSPACE_COLLAPSED_KEY, String(workspaceCollapsed)) }, [workspaceCollapsed])
  useEffect(() => { localStorage.setItem(WORKSPACE_SECTIONS_COLLAPSED_KEY, JSON.stringify([...collapsedSections])) }, [collapsedSections])
  useEffect(() => { localStorage.setItem(CONVERSATION_DRAWER_OPEN_KEY, String(conversationDrawerOpen)) }, [conversationDrawerOpen])

  const conversations = useMemo<ConversationRecord[]>(() => runtimes.flatMap((runtime) => runtime.conversations.map((conversation) => ({
    key: `${runtime.machine.id}:${conversation.id}`,
    runtime,
    conversation
  }))).sort((a, b) => Date.parse(b.conversation.updatedAt) - Date.parse(a.conversation.updatedAt)), [runtimes])

  const projects = useMemo<ProjectRecord[]>(() => runtimes.flatMap((runtime) => runtime.projects.map((project) => ({
    key: `${runtime.machine.id}:${project.id}`,
    runtime,
    project,
    count: runtime.conversations.filter((conversation) => conversation.projectId === project.id).length
  }))).sort((a, b) => a.project.name.localeCompare(b.project.name)), [runtimes])

  const visibleProjects = useMemo(() => selectedMachineID === "all" ? projects : projects.filter((record) => record.runtime.machine.id === selectedMachineID), [projects, selectedMachineID])

  const projectScopedConversations = useMemo(() => conversations.filter((record) => {
    const inMachine = selectedMachineID === "all" || record.runtime.machine.id === selectedMachineID
    const inProject = selectedProjectKey === "all" || `${record.runtime.machine.id}:${record.conversation.projectId}` === selectedProjectKey
    return inMachine && inProject
  }), [conversations, selectedMachineID, selectedProjectKey])

  const visibleConversations = useMemo(() => {
    const query = search.trim().toLowerCase()
    return projectScopedConversations.filter((record) => {
      if (!filterMatches(record.conversation, conversationFilter)) return false
      if (!query) return true
      return `${conversationTitle(record.conversation)} ${record.conversation.project?.name || ""} ${record.conversation.prompt}`.toLowerCase().includes(query)
    })
  }, [projectScopedConversations, conversationFilter, search])

  useEffect(() => {
    if (!selectedConversationKey) return
    if (conversations.some((record) => record.key === selectedConversationKey)) return
    setSelectedConversationKey(null)
    setMobileDetailOpen(false)
  }, [conversations, selectedConversationKey])

  const selected = conversations.find((record) => record.key === selectedConversationKey) || null
  const selectedProject = selectedProjectKey === "all" ? null : projects.find((record) => record.key === selectedProjectKey) || null
  const drawerEyebrow = selectedProject?.project.name
    || selected?.conversation.project?.name
    || (selectedMachineID !== "all" ? runtimes.find((runtime) => runtime.machine.id === selectedMachineID)?.machine.name : undefined)
    || "All projects"
  const onlineCount = runtimes.filter((runtime) => runtime.state === "online").length
  const shownRuntimes = selectedMachineID === "all" ? runtimes : runtimes.filter((runtime) => runtime.machine.id === selectedMachineID)
  const shownHarnesses = shownRuntimes.flatMap((runtime) => (runtime.snapshot?.agents ?? []).map((agent) => ({ runtime, agent })))
  const statusCounts = {
    all: projectScopedConversations.length,
    working: projectScopedConversations.filter((record) => conversationState(record.conversation) === "working").length,
    attention: projectScopedConversations.filter((record) => ["attention", "stopped"].includes(conversationState(record.conversation))).length
  }

  function selectMachine(id: string) {
    setSelectedConversationKey(null)
    setSelectedMachineID(id)
    setSelectedProjectKey("all")
    setConversationFilter("all")
    setConversationDrawerOpen(true)
    setMobileDetailOpen(false)
  }

  function selectProject(key: string) {
    setSelectedConversationKey(null)
    setSelectedProjectKey(key)
    if (key !== "all") {
      const record = projects.find((candidate) => candidate.key === key)
      if (record) setSelectedMachineID(record.runtime.machine.id)
    }
    setConversationFilter("all")
    setConversationDrawerOpen(true)
    setMobileDetailOpen(false)
  }

  function toggleWorkspaceSection(section: WorkspaceSection) {
    setCollapsedSections((current) => {
      const next = new Set(current)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }

  function beginConversationPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 900) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = conversationPaneWidth
    const move = (pointer: PointerEvent) => {
      const next = Math.max(280, Math.min(500, startWidth + pointer.clientX - startX))
      setConversationPaneWidth(next)
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      setConversationPaneWidth((value) => {
        localStorage.setItem(CONVERSATION_PANE_WIDTH_KEY, String(value))
        return value
      })
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up, { once: true })
  }

  function updateConversation(machineID: string, conversation: MachineTask) {
    setRuntimes((current) => current.map((runtime) => runtime.machine.id === machineID
      ? {
          ...runtime,
          conversations: [conversation, ...runtime.conversations.filter((candidate) => candidate.id !== conversation.id)].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        }
      : runtime))
  }

  function upsertCreated(runtime: Runtime, conversation: MachineTask) {
    refreshGeneration.current += 1
    updateConversation(runtime.machine.id, conversation)
    setSelectedMachineID(runtime.machine.id)
    setSelectedProjectKey(`${runtime.machine.id}:${conversation.projectId}`)
    setConversationFilter("all")
    setSelectedConversationKey(`${runtime.machine.id}:${conversation.id}`)
    setConversationDrawerOpen(false)
    setMobileDetailOpen(true)
    onActiveMachineID(runtime.machine.id)
    setRevision((value) => value + 1)
  }

  useEffect(() => {
    if (selected) onActiveMachineID(selected.runtime.machine.id)
  }, [selected?.runtime.machine.id])

  const shellStyle = { "--tdw-thread-width": `${conversationPaneWidth}px` } as CSSProperties

  return (
    <div className={`tdw-shell hr-control-plane${workspaceCollapsed ? " workspace-collapsed" : ""}${conversationDrawerOpen ? " task-drawer-open" : ""}`} style={shellStyle}>
      <header className="tdw-topbar hr-topbar">
        <div className="tdw-brand hr-brand"><span className="tdw-logo hr-logo">H</span><div><strong>Harness Remote</strong><small>Any coding agent. One workspace.</small></div></div>
        <div className="tdw-context-path" aria-label="Current workspace context">
          <span>{selectedProject?.project.name || selected?.conversation.project?.name || (selectedMachineID === "all" ? "All projects" : runtimes.find((runtime) => runtime.machine.id === selectedMachineID)?.machine.name || "Machine")}</span><b>/</b><strong>Conversations</strong>
          {selected ? <><b>/</b><em>{conversationTitle(selected.conversation)}</em></> : null}
        </div>
        <div className="tdw-top-actions">
          <span className="tdw-machine-health"><i className={onlineCount > 0 ? "online" : "offline"} />{onlineCount}/{machines.length} machines</span>
          <button type="button" className={`tdw-button secondary tdw-tasks-toggle${conversationDrawerOpen ? " active" : ""}`} onClick={() => setConversationDrawerOpen((value) => !value)} aria-expanded={conversationDrawerOpen}><ChatIcon size={15} /> Conversations <span>{visibleConversations.length}</span></button>
          <button type="button" className="tdw-button secondary tdw-machines-button" onClick={onManageMachines}><ServerIcon size={15} /> Machines</button>
          <button type="button" className="tdw-icon-button" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings"><SettingsIcon size={16} /></button>
          <button type="button" className="tdw-icon-button" onClick={() => setRevision((value) => value + 1)} title="Refresh" aria-label="Refresh" disabled={refreshing}><RefreshIcon size={16} /></button>
          <button type="button" className="tdw-button primary hr-new-conversation" onClick={() => setNewConversationOpen(true)}><PlusIcon size={15} /> New conversation</button>
        </div>
      </header>

      <div className="tdw-layout">
        <aside className="tdw-project-column">
          <div className="tdw-column-heading tdw-workspace-heading"><div><span>Navigation</span><h2>Workspace</h2></div><button type="button" className="tdw-sidebar-collapse" onClick={() => setWorkspaceCollapsed((value) => !value)} title={workspaceCollapsed ? "Expand workspace" : "Collapse workspace"} aria-label={workspaceCollapsed ? "Expand workspace" : "Collapse workspace"}>{workspaceCollapsed ? "›" : "‹"}</button></div>

          <div className={`tdw-workspace-section tdw-machine-section${collapsedSections.has("machines") ? " section-collapsed" : ""}`}>
            <button type="button" className="tdw-workspace-section-header" onClick={() => toggleWorkspaceSection("machines")} aria-expanded={!collapsedSections.has("machines")}>
              <span className="tdw-workspace-label">Machines</span><span className="tdw-section-chevron">⌄</span>
            </button>
            <div className="tdw-workspace-section-body">
              <button type="button" className={`tdw-side-row${selectedMachineID === "all" ? " active" : ""}`} onClick={() => selectMachine("all")} title="All machines"><span className="tdw-side-icon"><ServerIcon size={14} /></span><span><strong>All machines</strong><small>{onlineCount}/{runtimes.length} online</small></span></button>
              {runtimes.map((runtime) => {
                const machineName = runtime.snapshot?.machine.name || runtime.machine.name
                const summary = runtime.state === "offline"
                  ? runtime.error || "Machine offline"
                  : runtime.state === "loading"
                    ? "Connecting..."
                    : `${runtime.snapshot?.agents.filter(harnessReady).length || 0}/${runtime.snapshot?.agents.length || 0} agents ready`
                return <button type="button" className={`tdw-side-row${selectedMachineID === runtime.machine.id ? " active" : ""}`} onClick={() => selectMachine(runtime.machine.id)} key={runtime.machine.id} title={runtime.state === "offline" && runtime.error ? `${machineName}: ${runtime.error}` : machineName}><span className={`tdw-presence-dot ${runtime.state}`} /><span><strong>{machineName}</strong><small>{summary}</small></span></button>
              })}
            </div>
          </div>

          <div className={`tdw-workspace-section tdw-project-section${collapsedSections.has("projects") ? " section-collapsed" : ""}`}>
            <button type="button" className="tdw-workspace-section-header" onClick={() => toggleWorkspaceSection("projects")} aria-expanded={!collapsedSections.has("projects")}>
              <span className="tdw-workspace-label">Projects</span><span className="tdw-section-chevron">⌄</span>
            </button>
            <div className="tdw-workspace-section-body">
              <button type="button" className={`tdw-project-row${selectedProjectKey === "all" ? " active" : ""}`} onClick={() => selectProject("all")} title="All projects"><span className="tdw-project-icon"><ChatIcon size={15} /></span><span><strong>All projects</strong><small>Across the selected machines</small></span><b>{projectScopedConversations.length}</b></button>
              <div className="tdw-project-list">
                {visibleProjects.map((record) => <button type="button" className={`tdw-project-row${selectedProjectKey === record.key ? " active" : ""}`} onClick={() => selectProject(record.key)} key={record.key} title={record.project.name}><span className="tdw-project-icon"><FolderIcon size={15} /></span><span><strong>{record.project.name}</strong><small>{record.runtime.snapshot?.machine.name || record.runtime.machine.name}</small></span><b>{record.count}</b></button>)}
              </div>
            </div>
          </div>

          <div className={`tdw-workspace-section tdw-harness-section${collapsedSections.has("harnesses") ? " section-collapsed" : ""}`}>
            <button type="button" className="tdw-workspace-section-header" onClick={() => toggleWorkspaceSection("harnesses")} aria-expanded={!collapsedSections.has("harnesses")}>
              <span className="tdw-workspace-label">Coding agents</span><span className="tdw-section-chevron">⌄</span>
            </button>
            <div className="tdw-workspace-section-body">
              {shownHarnesses.length ? shownHarnesses.map(({ runtime, agent }) => <div className="tdw-harness-row" key={`${runtime.machine.id}:${agent.id}`} title={`${agent.label} · ${harnessStateLabel(agent)}`}><span className={`tdw-presence-dot ${agent.state}`} /><span><strong>{agent.label}</strong><small>{harnessStateLabel(agent)}{agent.state === "configured" ? " · starts on use" : ""}{selectedMachineID === "all" ? ` · ${runtime.snapshot?.machine.name || runtime.machine.name}` : ""}</small></span></div>) : <div className="tdw-side-empty">No coding agents detected</div>}
            </div>
          </div>

          <div className={`tdw-workspace-section tdw-filter-section${collapsedSections.has("filters") ? " section-collapsed" : ""}`}>
            <button type="button" className="tdw-workspace-section-header" onClick={() => toggleWorkspaceSection("filters")} aria-expanded={!collapsedSections.has("filters")}>
              <span className="tdw-workspace-label">Conversation filters</span><span className="tdw-section-chevron">⌄</span>
            </button>
            <div className="tdw-workspace-section-body">
              {(["all", "working", "attention"] as ConversationFilter[]).map((filter) => <button type="button" className={`tdw-filter-row${conversationFilter === filter ? " active" : ""}`} key={filter} onClick={() => { setConversationFilter(filter); setConversationDrawerOpen(true) }}><span className={`tdw-filter-dot ${filter}`} /><span>{filter === "all" ? "All" : filter === "working" ? "Working" : "Needs attention"}</span><b>{statusCounts[filter]}</b></button>)}
            </div>
          </div>
        </aside>

        {conversationDrawerOpen ? <button type="button" className="tdw-task-drawer-scrim" aria-label="Close conversation list" onClick={() => setConversationDrawerOpen(false)} /> : null}

        <section className="tdw-thread-column hr-conversation-column">
          <div className="tdw-column-heading tdw-task-drawer-heading"><div><span>{drawerEyebrow}</span><h2>Conversations <strong className="tdw-task-drawer-count">{visibleConversations.length}</strong></h2></div><button type="button" className="tdw-sidebar-collapse tdw-task-drawer-close" onClick={() => setConversationDrawerOpen(false)} aria-label="Close conversation list" title="Close conversation list">×</button></div>
          <div className="tdw-thread-search"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search conversations..." /></div>
          <div className="tdw-thread-list">
            {!loaded && conversations.length === 0 ? <div className="tdw-empty"><LoadingIcon size={22} /><strong>Connecting your workspace...</strong><span>Discovering machines, projects and coding agents.</span></div> : visibleConversations.length === 0 ? <div className="tdw-empty"><ChatIcon size={22} /><strong>No conversations here</strong><span>Start one with any available coding agent.</span><button type="button" className="tdw-button primary" onClick={() => setNewConversationOpen(true)}><PlusIcon size={14} /> New conversation</button></div> : visibleConversations.map((record) => {
              const state = conversationState(record.conversation)
              const agent = agentForConversation(record)
              return <button type="button" className={`tdw-thread-card${selectedConversationKey === record.key ? " selected" : ""}`} onClick={() => { setSelectedConversationKey(record.key); setConversationDrawerOpen(false); setMobileDetailOpen(true) }} key={record.key}><span className={`tdw-thread-state ${state}`} /><span className="tdw-thread-card-main"><span className="tdw-thread-title"><strong>{conversationTitle(record.conversation)}</strong><time>{formatRelative(record.conversation.updatedAt || record.conversation.createdAt)}</time></span><span className="tdw-thread-project">{record.conversation.project?.name || record.conversation.projectId}</span><span className="tdw-thread-meta">{agent?.label || conversationAgentID(record.conversation)} · {modelLabel(record.conversation)}</span><span className={`tdw-thread-status ${state}`}>{conversationStateLabel(record.conversation)}</span></span></button>
            })}
          </div>
          <div className="tdw-pane-resizer" role="separator" aria-orientation="vertical" aria-label="Resize conversation list" onPointerDown={beginConversationPaneResize} />
        </section>

        <main className={`tdw-main${mobileDetailOpen ? " mobile-open" : ""}`}>
          {selected ? <button type="button" className="tdw-mobile-back" onClick={() => setMobileDetailOpen(false)} aria-label="Back to conversations">← Conversations</button> : null}
          {selected ? (
            <ConversationDetail
              key={selected.key}
              conversation={selected.conversation}
              baseConfig={selected.runtime.machine.config}
              agents={selected.runtime.agents}
              machineName={selected.runtime.snapshot?.machine.name || selected.runtime.machine.name}
              onConversationUpdate={(conversation) => updateConversation(selected.runtime.machine.id, conversation)}
              onWorkspaceRefresh={() => setRevision((value) => value + 1)}
            />
          ) : (
            <div className="tdw-welcome hr-welcome">
              <div className="tdw-welcome-mark hr-welcome-mark"><ChatIcon size={30} /></div>
              <span>Harness Remote 3.0</span>
              <h1>Your projects. Any coding agent.</h1>
              <p>Start with Codex, Claude, OpenCode, OMP or PI. Continue with another agent without leaving the conversation. Native Sessions stay native.</p>
              <div className="hr-welcome-principles" aria-label="Product principles"><span>Native Sessions</span><span>Agent handoff</span><span>Local-first</span></div>
              <div className="hr-welcome-actions">
                <button type="button" className="tdw-button primary" onClick={() => setNewConversationOpen(true)}><PlusIcon size={15} /> New conversation</button>
                <button type="button" className="tdw-button secondary" onClick={() => setConversationDrawerOpen(true)}><ChatIcon size={15} /> Browse conversations</button>
              </div>
            </div>
          )}
        </main>
      </div>

      {newConversationOpen ? <NewConversationModal runtimes={runtimes} initialMachineID={selected?.runtime.machine.id || (selectedMachineID !== "all" ? selectedMachineID : activeMachineID)} initialProjectKey={selectedProjectKey} onClose={() => setNewConversationOpen(false)} onCreated={upsertCreated} /> : null}
      {settingsOpen ? <ConversationSettingsModal onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  )
}
