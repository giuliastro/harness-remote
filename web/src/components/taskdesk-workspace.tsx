import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
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
import type { SavedServerProfile } from "../serverProfiles"
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
  MoreVerticalIcon,
  PlusIcon,
  RefreshIcon,
  ServerIcon,
  SettingsIcon
} from "../Icons"
import { ModelPicker, modelOptionKey } from "./model-picker"
import { UniversalWorkspace } from "./universal-workspace"
import { WorkThreadDetail } from "./work-thread-detail"
import "../taskdesk-workthreads.css"
import "../taskdesk-mobile-navigation.css"
import "../taskdesk-focus-layout.css"

type Props = {
  machines: WorkspaceMachine[]
  activeMachineID: string
  onActiveMachineID: (id: string) => void
  onManageMachines: () => void
  legacyView: ReactNode
}

type Runtime = {
  machine: WorkspaceMachine
  snapshot: MachineSnapshot | null
  projects: MachineProject[]
  tasks: MachineTask[]
  agents: MachineAgentHost[]
  state: "loading" | "online" | "offline"
  error?: string
}

type ThreadRecord = {
  key: string
  runtime: Runtime
  task: MachineTask
}

type ProjectRecord = {
  key: string
  runtime: Runtime
  project: MachineProject
  count: number
}

type ProductMode = "workspace" | "sessions" | "classic"
type ProductState = "working" | "ready" | "attention" | "stopped" | "done" | "idle"
type TaskFilter = "all" | "working" | "attention" | "done"
type WorkspaceSection = "machines" | "projects" | "harnesses" | "filters"

const WORKSPACE_COLLAPSED_KEY = "harness-remote.taskdesk.workspace-collapsed"
const WORKSPACE_SECTIONS_COLLAPSED_KEY = "harness-remote.taskdesk.workspace-sections-collapsed"
const TASK_PANE_WIDTH_KEY = "harness-remote.taskdesk.task-pane-width"
const TASK_DRAWER_OPEN_KEY = "harness-remote.taskdesk.task-drawer-open"

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function taskTitle(task: MachineTask): string {
  if (task.title?.trim()) return task.title.trim()
  const line = task.prompt.trim().split(/\r?\n/).find(Boolean)?.trim() || "Untitled Task"
  return line.length > 86 ? `${line.slice(0, 83)}...` : line
}

function taskAgentID(task: MachineTask): string {
  return task.run?.agentId || task.agentId
}

function taskState(task: MachineTask): ProductState {
  if (task.finishedAt) return "done"
  if (task.status === "starting" || task.status === "running") return "working"
  if (task.status === "failed") return "attention"
  if (task.status === "cancelled") return "stopped"
  if (task.status === "completed") return "ready"
  return "idle"
}

function taskStateLabel(task: MachineTask): string {
  const state = taskState(task)
  if (state === "working") return "Working"
  if (state === "attention") return "Needs attention"
  if (state === "stopped") return "Stopped"
  if (state === "done") return "Done"
  if (state === "ready") return "Ready"
  return "Idle"
}

function filterMatches(task: MachineTask, filter: TaskFilter): boolean {
  const state = taskState(task)
  if (filter === "all") return true
  if (filter === "working") return state === "working"
  if (filter === "attention") return state === "attention" || state === "stopped"
  return state === "done"
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

function modelLabel(task: MachineTask): string {
  const model = task.run?.model ?? task.model
  if (!model) return "Default model"
  const variant = model.variant ? ` · ${model.variant}` : ""
  return `${model.modelID}${variant}`
}

function profileForMachine(machine: WorkspaceMachine): SavedServerProfile {
  return { id: machine.id, name: machine.name, config: machine.config }
}

function agentForTask(record: ThreadRecord): MachineAgentHost | undefined {
  return record.runtime.agents.find((agent) => agent.id === taskAgentID(record.task))
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

function TaskDeskSettingsModal({ onClose }: { onClose: () => void }) {
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
      <section className="tdw-modal tdw-settings-modal" role="dialog" aria-modal="true" aria-label={t("nav.settings")} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span>TaskDesk</span><h2>{t("nav.settings")}</h2></div>
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
          <p className="tdw-safety-note">Appearance and language are app-wide preferences shared by TaskDesk, Advanced Sessions and Classic Harness Remote.</p>
        </div>
        <footer><button type="button" className="tdw-button primary" onClick={onClose}>{t("action.close")}</button></footer>
      </section>
    </div>
  )
}

function NewTaskModal({
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
  onCreated: (runtime: Runtime, task: MachineTask) => void
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
      let task = await taskClient.createTask(runtime.machine.config, {
        projectId: project.id,
        agentId: agent.id,
        prompt: prompt.trim(),
        model: selectedModel ? {
          providerID: selectedModel.providerID,
          modelID: selectedModel.modelID,
          variant: selectedModel.variant
        } : undefined
      })
      if (project.kind === "git") {
        task = await taskClient.prepareWorktree(runtime.machine.config, task.id)
        try {
          await taskClient.createCheckpoint(runtime.machine.config, task.id, {
            label: "Before work began",
            kind: "baseline"
          })
          task = await taskClient.getWorkThread(runtime.machine.config, task.id)
        } catch {
          // Restore points are useful but must never prevent a Task from starting.
        }
      }
      task = await taskClient.launch(runtime.machine.config, task.id)
      onCreated(runtime, task)
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
        <section className="tdw-modal" role="dialog" aria-modal="true" aria-label="New Task" onMouseDown={(event) => event.stopPropagation()}>
          <header><div><span>New Task</span><h2>No coding machine is ready</h2></div><button type="button" onClick={onClose}>×</button></header>
          <div className="tdw-modal-body"><p>Connect a machine with at least one project and one available coding agent.</p></div>
        </section>
      </div>
    )
  }

  return (
    <div className="tdw-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="tdw-modal" role="dialog" aria-modal="true" aria-label="New Task" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span>New Task</span><h2>What do you want to build or change?</h2></div>
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
          <label className="tdw-prompt-field"><span>Start the conversation</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} autoFocus placeholder="Describe the work you want. Keep refining it in this same Task after the agent responds." /></label>
          <p className="tdw-safety-note">TaskDesk prepares an isolated coding workspace automatically when the project supports it.</p>
          {error ? <div className="tdw-inline-error" role="alert">{error}</div> : null}
        </div>
        <footer>
          <button type="button" className="tdw-button secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="tdw-button primary" disabled={!canStart} onClick={() => void start()}>{starting ? <><LoadingIcon size={15} /> Starting...</> : <><PlusIcon size={15} /> Start Task</>}</button>
        </footer>
      </section>
    </div>
  )
}

export function TaskDeskWorkspace({ machines, activeMachineID, onActiveMachineID, onManageMachines, legacyView }: Props) {
  const [mode, setMode] = useState<ProductMode>("workspace")
  const [runtimes, setRuntimes] = useState<Runtime[]>(() => machines.map((machine) => ({ machine, snapshot: null, projects: [], tasks: [], agents: [], state: "loading" })))
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [revision, setRevision] = useState(0)
  const [selectedMachineID, setSelectedMachineID] = useState("all")
  const [selectedProjectKey, setSelectedProjectKey] = useState("all")
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all")
  const [selectedThreadKey, setSelectedThreadKey] = useState<string | null>(null)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const [newThreadOpen, setNewThreadOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(() => localStorage.getItem(TASK_DRAWER_OPEN_KEY) === "true")
  const [search, setSearch] = useState("")
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(() => localStorage.getItem(WORKSPACE_COLLAPSED_KEY) !== "false")
  const [collapsedSections, setCollapsedSections] = useState<Set<WorkspaceSection>>(loadCollapsedWorkspaceSections)
  const [taskPaneWidth, setTaskPaneWidth] = useState(() => {
    const saved = Number(localStorage.getItem(TASK_PANE_WIDTH_KEY))
    return Number.isFinite(saved) && saved >= 260 && saved <= 480 ? saved : 330
  })
  const refreshGeneration = useRef(0)
  const moreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const generation = ++refreshGeneration.current
    let cancelled = false
    if (machines.length === 0) {
      setRuntimes([])
      setLoaded(true)
      return
    }
    setRefreshing(true)
    void Promise.all(machines.map(async (machine): Promise<Runtime> => {
      try {
        const snapshot = await discoverMachine(machine.config)
        if (!snapshot) return { machine, snapshot: null, projects: [], tasks: [], agents: [], state: "offline", error: "This endpoint is not a Harness machine daemon." }
        const [projects, tasks] = await Promise.all([
          taskClient.listProjects(machine.config),
          taskClient.listTasks(machine.config)
        ])
        return {
          machine,
          snapshot,
          projects,
          tasks: [...tasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
          agents: selectableMachineAgents(snapshot),
          state: "online"
        }
      } catch (reason) {
        return { machine, snapshot: null, projects: [], tasks: [], agents: [], state: "offline", error: errorText(reason) }
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
    if (!moreOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [moreOpen])

  useEffect(() => {
    if (!taskDrawerOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTaskDrawerOpen(false)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [taskDrawerOpen])

  useEffect(() => {
    localStorage.setItem(WORKSPACE_COLLAPSED_KEY, String(workspaceCollapsed))
  }, [workspaceCollapsed])

  useEffect(() => {
    localStorage.setItem(WORKSPACE_SECTIONS_COLLAPSED_KEY, JSON.stringify([...collapsedSections]))
  }, [collapsedSections])

  useEffect(() => {
    localStorage.setItem(TASK_DRAWER_OPEN_KEY, String(taskDrawerOpen))
  }, [taskDrawerOpen])

  const threads = useMemo<ThreadRecord[]>(() => runtimes.flatMap((runtime) => runtime.tasks.map((task) => ({ key: `${runtime.machine.id}:${task.id}`, runtime, task }))).sort((a, b) => Date.parse(b.task.updatedAt) - Date.parse(a.task.updatedAt)), [runtimes])

  const projects = useMemo<ProjectRecord[]>(() => runtimes.flatMap((runtime) => runtime.projects.map((project) => ({
    key: `${runtime.machine.id}:${project.id}`,
    runtime,
    project,
    count: runtime.tasks.filter((task) => task.projectId === project.id).length
  }))).sort((a, b) => a.project.name.localeCompare(b.project.name)), [runtimes])

  const visibleProjects = useMemo(() => selectedMachineID === "all" ? projects : projects.filter((record) => record.runtime.machine.id === selectedMachineID), [projects, selectedMachineID])

  const projectScopedThreads = useMemo(() => threads.filter((record) => {
    const inMachine = selectedMachineID === "all" || record.runtime.machine.id === selectedMachineID
    const inProject = selectedProjectKey === "all" || `${record.runtime.machine.id}:${record.task.projectId}` === selectedProjectKey
    return inMachine && inProject
  }), [threads, selectedMachineID, selectedProjectKey])

  const visibleThreads = useMemo(() => {
    const query = search.trim().toLowerCase()
    return projectScopedThreads.filter((record) => {
      if (!filterMatches(record.task, taskFilter)) return false
      if (!query) return true
      return `${taskTitle(record.task)} ${record.task.project?.name || ""} ${record.task.prompt}`.toLowerCase().includes(query)
    })
  }, [projectScopedThreads, taskFilter, search])

  useEffect(() => {
    if (selectedThreadKey && threads.some((record) => record.key === selectedThreadKey)) return
    setSelectedThreadKey(visibleThreads[0]?.key || null)
  }, [threads, visibleThreads, selectedThreadKey])

  const selected = threads.find((record) => record.key === selectedThreadKey) || null
  const selectedProject = selectedProjectKey === "all" ? null : projects.find((record) => record.key === selectedProjectKey) || null
  const taskDrawerEyebrow = selectedProject?.project.name
    || selected?.task.project?.name
    || (selectedMachineID !== "all" ? runtimes.find((runtime) => runtime.machine.id === selectedMachineID)?.machine.name : undefined)
    || "All projects"
  const profiles = useMemo(() => machines.map(profileForMachine), [machines])
  const activeProfileID = selected?.runtime.machine.id || (selectedMachineID !== "all" ? selectedMachineID : activeMachineID) || profiles[0]?.id || ""
  const onlineCount = runtimes.filter((runtime) => runtime.state === "online").length
  const shownRuntimes = selectedMachineID === "all" ? runtimes : runtimes.filter((runtime) => runtime.machine.id === selectedMachineID)
  const shownHarnesses = shownRuntimes.flatMap((runtime) => (runtime.snapshot?.agents ?? []).map((agent) => ({ runtime, agent })))
  const statusCounts = {
    all: projectScopedThreads.length,
    working: projectScopedThreads.filter((record) => taskState(record.task) === "working").length,
    attention: projectScopedThreads.filter((record) => ["attention", "stopped"].includes(taskState(record.task))).length,
    done: projectScopedThreads.filter((record) => taskState(record.task) === "done").length
  }

  function selectMachine(id: string) {
    setSelectedThreadKey(null)
    setSelectedMachineID(id)
    setSelectedProjectKey("all")
    setTaskFilter("all")
    setTaskDrawerOpen(true)
    setMobileDetailOpen(false)
  }

  function selectProject(key: string) {
    setSelectedThreadKey(null)
    setSelectedProjectKey(key)
    if (key !== "all") {
      const record = projects.find((candidate) => candidate.key === key)
      if (record) setSelectedMachineID(record.runtime.machine.id)
    }
    setTaskFilter("all")
    setTaskDrawerOpen(true)
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

  function beginTaskPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 900) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = taskPaneWidth
    const move = (pointer: PointerEvent) => {
      const next = Math.max(260, Math.min(480, startWidth + pointer.clientX - startX))
      setTaskPaneWidth(next)
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      setTaskPaneWidth((value) => {
        localStorage.setItem(TASK_PANE_WIDTH_KEY, String(value))
        return value
      })
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up, { once: true })
  }

  function updateTask(machineID: string, task: MachineTask) {
    setRuntimes((current) => current.map((runtime) => runtime.machine.id === machineID
      ? {
          ...runtime,
          tasks: [task, ...runtime.tasks.filter((candidate) => candidate.id !== task.id)].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        }
      : runtime))
  }

  function upsertCreated(runtime: Runtime, task: MachineTask) {
    refreshGeneration.current += 1
    updateTask(runtime.machine.id, task)
    setSelectedMachineID(runtime.machine.id)
    setSelectedProjectKey(`${runtime.machine.id}:${task.projectId}`)
    setTaskFilter("all")
    setSelectedThreadKey(`${runtime.machine.id}:${task.id}`)
    setTaskDrawerOpen(false)
    setMobileDetailOpen(true)
    onActiveMachineID(runtime.machine.id)
    setRevision((value) => value + 1)
  }

  useEffect(() => {
    if (selected) onActiveMachineID(selected.runtime.machine.id)
  }, [selected?.runtime.machine.id])

  if (mode === "classic") {
    return <div className="tdw-classic-host"><button type="button" className="tdw-return" onClick={() => setMode("workspace")}>← Back to TaskDesk</button>{legacyView}</div>
  }

  if (mode === "sessions") {
    return (
      <div className="tdw-advanced-host">
        <div className="tdw-advanced-bar"><button type="button" className="tdw-button secondary" onClick={() => setMode("workspace")}>← Tasks</button><div><strong>Advanced: Native Sessions</strong><span>Exact harness sessions for diagnostics and recovery.</span></div></div>
        <UniversalWorkspace profiles={profiles} activeProfileID={activeProfileID} onPersistProfiles={() => undefined} legacyView={legacyView} />
      </div>
    )
  }

  const shellStyle = { "--tdw-thread-width": `${taskPaneWidth}px` } as CSSProperties

  return (
    <div className={`tdw-shell${workspaceCollapsed ? " workspace-collapsed" : ""}${taskDrawerOpen ? " task-drawer-open" : ""}`} style={shellStyle}>
      <header className="tdw-topbar">
        <div className="tdw-brand"><span className="tdw-logo">T</span><div><strong>TaskDesk</strong><small>One project. One conversation. Any coding agent.</small></div></div>
        <div className="tdw-context-path" aria-label="Current workspace context">
          <span>{selectedProject?.project.name || (selectedMachineID === "all" ? "All projects" : runtimes.find((runtime) => runtime.machine.id === selectedMachineID)?.machine.name || "Machine")}</span><b>/</b><strong>Tasks</strong>
          {selected ? <><b>/</b><em>{taskTitle(selected.task)}</em></> : null}
        </div>
        <div className="tdw-top-actions">
          <span className="tdw-machine-health"><i className={onlineCount > 0 ? "online" : "offline"} />{onlineCount}/{machines.length} machines</span>
          <button type="button" className={`tdw-button secondary tdw-tasks-toggle${taskDrawerOpen ? " active" : ""}`} onClick={() => setTaskDrawerOpen((value) => !value)} aria-expanded={taskDrawerOpen}><ChatIcon size={15} /> Tasks <span>{visibleThreads.length}</span></button>
          <button type="button" className="tdw-button secondary tdw-machines-button" onClick={onManageMachines}><ServerIcon size={15} /> Machines</button>
          <button type="button" className="tdw-icon-button" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings"><SettingsIcon size={16} /></button>
          <button type="button" className="tdw-icon-button" onClick={() => setRevision((value) => value + 1)} title="Refresh" aria-label="Refresh" disabled={refreshing}><RefreshIcon size={16} /></button>
          <button type="button" className="tdw-button primary" onClick={() => setNewThreadOpen(true)}><PlusIcon size={15} /> New Task</button>
          <div className="tdw-more-wrap" ref={moreRef}>
            <button type="button" className="tdw-icon-button" onClick={() => setMoreOpen((value) => !value)} aria-label="More" title="More"><MoreVerticalIcon size={18} /></button>
            {moreOpen ? <div className="tdw-more-menu"><button type="button" className="tdw-mobile-only-menu" onClick={() => { setMoreOpen(false); onManageMachines() }}>Machines</button><button type="button" onClick={() => { setMoreOpen(false); setSettingsOpen(true) }}>Settings</button><button type="button" onClick={() => { setMoreOpen(false); setMode("sessions") }}>Advanced: Native Sessions</button><button type="button" onClick={() => { setMoreOpen(false); setMode("classic") }}>Classic Harness Remote</button></div> : null}
          </div>
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
                  : `${runtime.snapshot?.agents.filter(harnessReady).length || 0}/${runtime.snapshot?.agents.length || 0} harnesses ready`
                return <button type="button" className={`tdw-side-row${selectedMachineID === runtime.machine.id ? " active" : ""}`} onClick={() => selectMachine(runtime.machine.id)} key={runtime.machine.id} title={runtime.state === "offline" && runtime.error ? `${machineName}: ${runtime.error}` : machineName}><span className={`tdw-presence-dot ${runtime.state}`} /><span><strong>{machineName}</strong><small>{summary}</small></span></button>
              })}
            </div>
          </div>

          <div className={`tdw-workspace-section tdw-project-section${collapsedSections.has("projects") ? " section-collapsed" : ""}`}>
            <button type="button" className="tdw-workspace-section-header" onClick={() => toggleWorkspaceSection("projects")} aria-expanded={!collapsedSections.has("projects")}>
              <span className="tdw-workspace-label">Projects</span><span className="tdw-section-chevron">⌄</span>
            </button>
            <div className="tdw-workspace-section-body">
              <button type="button" className={`tdw-project-row${selectedProjectKey === "all" ? " active" : ""}`} onClick={() => selectProject("all")} title="All projects"><span className="tdw-project-icon"><ChatIcon size={15} /></span><span><strong>All projects</strong><small>Across the selected machine scope</small></span><b>{projectScopedThreads.length}</b></button>
              <div className="tdw-project-list">
                {visibleProjects.map((record) => <button type="button" className={`tdw-project-row${selectedProjectKey === record.key ? " active" : ""}`} onClick={() => selectProject(record.key)} key={record.key} title={record.project.name}><span className="tdw-project-icon"><FolderIcon size={15} /></span><span><strong>{record.project.name}</strong><small>{record.runtime.snapshot?.machine.name || record.runtime.machine.name}</small></span><b>{record.count}</b></button>)}
              </div>
            </div>
          </div>

          <div className={`tdw-workspace-section tdw-harness-section${collapsedSections.has("harnesses") ? " section-collapsed" : ""}`}>
            <button type="button" className="tdw-workspace-section-header" onClick={() => toggleWorkspaceSection("harnesses")} aria-expanded={!collapsedSections.has("harnesses")}>
              <span className="tdw-workspace-label">Harnesses</span><span className="tdw-section-chevron">⌄</span>
            </button>
            <div className="tdw-workspace-section-body">
              {shownHarnesses.length ? shownHarnesses.map(({ runtime, agent }) => <div className="tdw-harness-row" key={`${runtime.machine.id}:${agent.id}`} title={`${agent.label} · ${harnessStateLabel(agent)}`}><span className={`tdw-presence-dot ${agent.state}`} /><span><strong>{agent.label}</strong><small>{harnessStateLabel(agent)}{agent.state === "configured" ? " · starts on use" : ""}{agent.processID ? ` · PID ${agent.processID}` : ""}</small></span></div>) : <div className="tdw-side-empty">No harnesses detected</div>}
            </div>
          </div>

          <div className={`tdw-workspace-section tdw-filter-section${collapsedSections.has("filters") ? " section-collapsed" : ""}`}>
            <button type="button" className="tdw-workspace-section-header" onClick={() => toggleWorkspaceSection("filters")} aria-expanded={!collapsedSections.has("filters")}>
              <span className="tdw-workspace-label">Task filters</span><span className="tdw-section-chevron">⌄</span>
            </button>
            <div className="tdw-workspace-section-body">
              {(["all", "working", "attention", "done"] as TaskFilter[]).map((filter) => <button type="button" className={`tdw-filter-row${taskFilter === filter ? " active" : ""}`} key={filter} onClick={() => { setTaskFilter(filter); setTaskDrawerOpen(true) }}><span className={`tdw-filter-dot ${filter}`} /><span>{filter === "all" ? "All" : filter === "working" ? "Working" : filter === "attention" ? "Needs attention" : "Done"}</span><b>{statusCounts[filter]}</b></button>)}
            </div>
          </div>
        </aside>

        {taskDrawerOpen ? <button type="button" className="tdw-task-drawer-scrim" aria-label="Close task list" onClick={() => setTaskDrawerOpen(false)} /> : null}

        <section className="tdw-thread-column">
          <div className="tdw-column-heading tdw-task-drawer-heading"><div><span>{taskDrawerEyebrow}</span><h2>Tasks <strong className="tdw-task-drawer-count">{visibleThreads.length}</strong></h2></div><button type="button" className="tdw-sidebar-collapse tdw-task-drawer-close" onClick={() => setTaskDrawerOpen(false)} aria-label="Close task list" title="Close task list">×</button></div>
          <div className="tdw-thread-search"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tasks and conversations..." /></div>
          <div className="tdw-thread-list">
            {!loaded && threads.length === 0 ? <div className="tdw-empty"><LoadingIcon size={22} /><strong>Loading your workspace...</strong></div> : visibleThreads.length === 0 ? <div className="tdw-empty"><ChatIcon size={22} /><strong>No Tasks in this view</strong><span>Change the filters or start a new Task.</span><button type="button" className="tdw-button primary" onClick={() => setNewThreadOpen(true)}><PlusIcon size={14} /> New Task</button></div> : visibleThreads.map((record) => {
              const state = taskState(record.task)
              const agent = agentForTask(record)
              return <button type="button" className={`tdw-thread-card${selectedThreadKey === record.key ? " selected" : ""}`} onClick={() => { setSelectedThreadKey(record.key); setTaskDrawerOpen(false); setMobileDetailOpen(true) }} key={record.key}><span className={`tdw-thread-state ${state}`} /><span className="tdw-thread-card-main"><span className="tdw-thread-title"><strong>{taskTitle(record.task)}</strong><time>{formatRelative(record.task.updatedAt || record.task.createdAt)}</time></span><span className="tdw-thread-project">{record.task.project?.name || record.task.projectId}</span><span className="tdw-thread-meta">{agent?.label || taskAgentID(record.task)} · {modelLabel(record.task)}</span><span className={`tdw-thread-status ${state}`}>{taskStateLabel(record.task)}</span></span></button>
            })}
          </div>
          <div className="tdw-pane-resizer" role="separator" aria-orientation="vertical" aria-label="Resize Task list" onPointerDown={beginTaskPaneResize} />
        </section>

        <main className={`tdw-main${mobileDetailOpen ? " mobile-open" : ""}`}>
          {selected ? <button type="button" className="tdw-mobile-back" onClick={() => setMobileDetailOpen(false)} aria-label="Back to Tasks">← Tasks</button> : null}
          {selected ? (
            <WorkThreadDetail
              key={selected.key}
              task={selected.task}
              baseConfig={selected.runtime.machine.config}
              agents={selected.runtime.agents}
              machineName={selected.runtime.snapshot?.machine.name || selected.runtime.machine.name}
              onTaskUpdate={(task) => updateTask(selected.runtime.machine.id, task)}
              onWorkspaceRefresh={() => setRevision((value) => value + 1)}
            />
          ) : (
            <div className="tdw-welcome"><div className="tdw-welcome-mark"><ChatIcon size={30} /></div><span>TaskDesk 3.0</span><h1>One task. One continuing conversation.</h1><p>Open a Task and keep talking to the coding agent until the result is right. Native Sessions and Runs stay underneath unless you need diagnostics.</p><button type="button" className="tdw-button primary" onClick={() => setTaskDrawerOpen(true)}><ChatIcon size={15} /> Show Tasks</button></div>
          )}
        </main>
      </div>

      {newThreadOpen ? <NewTaskModal runtimes={runtimes} initialMachineID={selected?.runtime.machine.id || (selectedMachineID !== "all" ? selectedMachineID : activeMachineID)} initialProjectKey={selectedProjectKey} onClose={() => setNewThreadOpen(false)} onCreated={upsertCreated} /> : null}
      {settingsOpen ? <TaskDeskSettingsModal onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  )
}