import { useEffect, useMemo, useRef, useState } from "react"
import { App as CapacitorApp } from "@capacitor/app"
import type { PluginListenerHandle } from "@capacitor/core"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { api, isValidServerConfig } from "./api"
import { ACTIVE_BACKEND_STORAGE_KEY, BACKEND_STORAGE_KEYS, LEGACY_STORAGE_KEY } from "./storageKeys"
import {
  createFetchOpenCodeEventSubscription,
  createNativeOpenCodeEventSubscription,
  eventType,
  isNativeEventTransport,
  type EventStreamStatus
} from "./opencode-events"
import { createTranslator, languageOptions, normalizeLanguage, type LanguageCode } from "./i18n"
import type { AgentOption, CommandInfo, DiffFile, FileEntry, FileStatusEntry, MessageEnvelope, ModelOption, ModelSelection, PathInfo, ProjectDashboard, ServerConfig, Session, SessionStatus, SessionView, TodoItem } from "./types"
import {
  SettingsIcon,
  FolderIcon,
  ChatIcon,
  HelpIcon,
  PlusIcon,
  PlayIcon,
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

const LANGUAGE_STORAGE_KEY = "opencode.remote.language"
const MODEL_STORAGE_KEY = "opencode.remote.model"
const AGENT_STORAGE_KEY = "opencode.remote.agent"
const THEME_STORAGE_KEY = "opencode.remote.theme"
const NEW_SESSION_DIRECTORY_STORAGE_KEY = "opencode.remote.newSessionDirectory"

function defaultConfig(backend: ServerConfig["backend"]): ServerConfig {
  return {
    backend,
    host: "",
    port: backend === "omp" ? 4097 : 4096,
    username: backend === "omp" ? "omp" : "opencode",
    password: ""
  }
}

function parseStoredConfig(value: string | null, backend: ServerConfig["backend"]): ServerConfig | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<ServerConfig>
    const storedBackend = parsed.backend === "omp" || parsed.backend === "opencode" ? parsed.backend : backend
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
  const backend = storedBackend === "omp" || storedBackend === "opencode" ? storedBackend : legacy?.backend ?? "opencode"
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

function hasMatchingUserMessage(messages: MessageEnvelope[], optimistic: MessageEnvelope): boolean {
  const text = extractText(optimistic)
  return messages.some((message) => (
    message.info.sessionID === optimistic.info.sessionID &&
    message.info.role === "user" &&
    extractText(message) === text
  ))
}

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
  const [connectedVersion, setConnectedVersion] = useState<string>("")
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [commandFilter, setCommandFilter] = useState<"all" | "skill">("all")
  const [agentOptions, setAgentOptions] = useState<AgentOption[]>([])
  const [agentLoadError, setAgentLoadError] = useState<string | null>(null)
  const [selectedAgentID, setSelectedAgentID] = useState<string>(() => localStorage.getItem(AGENT_STORAGE_KEY) || "build")
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([])
  const [modelLoadError, setModelLoadError] = useState<string | null>(null)
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(() => localStorage.getItem(MODEL_STORAGE_KEY))
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
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLDivElement | null>(null)
  const completionAudioRef = useRef<HTMLAudioElement | null>(null)
  const completionShouldPlayRef = useRef(false)
  const wasAwaitingAssistantReplyRef = useRef(false)
  const wasRunningRef = useRef(false)
  const awaitingAssistantBaselineRef = useRef("")
  const loadSelectedRequestRef = useRef(0)
  const backgroundFailureCountRef = useRef(0)
  const initialSessionLoadRef = useRef(true)
  const latestMessageTimesRef = useRef(new Map<string, { sessionUpdated: number; activityTime: number }>())
  const selectedSessionRef = useRef<SessionView | null>(null)

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
  const activeModel = activeModelOption ? { providerID: activeModelOption.providerID, modelID: activeModelOption.modelID, variant: activeModelOption.variant } : selectedModel ?? undefined
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
      .map((message) => ({ ...message, text: extractText(message) }))
      .filter((message) => message.text)
  }, [messages, optimisticUserMessages])


  const assistantResponseSignature = useMemo(() => {
    return renderedMessages
      .filter((message) => message.info.role !== "user")
      .map((message) => `${message.info.id}:${message.text.length}`)
      .join("|")
  }, [renderedMessages])

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
  const showTypingBubble = Boolean(selectedSession) && isWaitingForOpenCodeReply
  const activeSessions = sessions.filter((session) => ["busy", "retry"].includes(session.status)).length
  const changedSessions = sessions.filter(
    (session) => session.files > 0 || session.additions > 0 || session.deletions > 0
  ).length
  const totalDiffAdditions = diffFiles.reduce((sum, file) => sum + file.additions, 0)
  const totalDiffDeletions = diffFiles.reduce((sum, file) => sum + file.deletions, 0)
  const assistantDisplayName = config.backend === "omp" ? "Oh My Pi" : t('detail.opencode')
  const showModelChip = modelOptions.length > 1 || Boolean(activeModelOption) || primaryAgentOptions.length > 0

  async function openSession(sessionID: string, directory: string) {
    setSelectedID(sessionID)
    setMessages([])
    loadedMessagesRef.current = []
    setOptimisticUserMessages([])
    setTodos([])
    setDiffFiles([])
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
    if (!isValidServerConfig(config)) return
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
    if (!isValidServerConfig(config)) return
    try {
      const list = await api.listModels(config, directory, config.backend === "omp" ? sessionID : undefined)
      setModelOptions(list)
      setModelLoadError(null)
      const sessionModel = selectedSession && selectedSession.id === sessionID ? selectedSession.model : undefined
      const sessionOption = sessionModel ? list.find((option) => sameModel(option, sessionModel)) : null
      if (sessionOption) {
        const nextKey = modelKey(sessionOption)
        setSelectedModelKey(nextKey)
        localStorage.setItem(MODEL_STORAGE_KEY, nextKey)
        return
      }
      const saved = modelFromKey(selectedModelKey)
      if (saved && list.some((option) => sameModel(option, saved))) return
      const fallback = list.find((option) => option.isDefault) ?? list[0]
      if (fallback) {
        const nextKey = modelKey(fallback)
        setSelectedModelKey(nextKey)
        localStorage.setItem(MODEL_STORAGE_KEY, nextKey)
      }
    } catch (err) {
      setModelLoadError((err as Error).message)
    }
  }

  async function loadSessionActivityTimes(items: Session[]): Promise<Map<string, number>> {
    if (config.backend === "omp") {
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
    localStorage.setItem(MODEL_STORAGE_KEY, nextKey)
  }

  function changeAgent(nextAgentID: string) {
    setSelectedAgentID(nextAgentID)
    localStorage.setItem(AGENT_STORAGE_KEY, nextAgentID)
  }

  async function loadSelected(sessionID: string, directory: string, refreshHistory = false) {
    const requestID = ++loadSelectedRequestRef.current
    const [msg, todo, diff] = await Promise.all([
      api.loadMessages(config, sessionID, directory, refreshHistory),
      api.loadTodo(config, sessionID, directory),
      api.loadDiff(config, sessionID, directory).catch(() => [])
    ])
    if (requestID !== loadSelectedRequestRef.current) return
    const current = loadedMessagesRef.current
    if (
      !messagesHaveSameContent(current, msg) &&
      assistantPayloadLength(current) <= assistantPayloadLength(msg)
    ) {
      shouldAutoScrollRef.current = messagesExtendContent(current, msg) && isChatNearBottom()
      loadedMessagesRef.current = msg
      setMessages(msg)
    }
    setOptimisticUserMessages((current) => current.filter((message) => !hasMatchingUserMessage(msg, message)))
    setTodos(todo)
    setDiffFiles(diff)
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

  function isChatNearBottom(): boolean {
    const container = messagesRef.current
    if (container && container.scrollHeight > container.clientHeight + 1) {
      return container.scrollHeight - container.scrollTop - container.clientHeight <= 48
    }
    const page = document.documentElement
    return page.scrollHeight - window.scrollY - window.innerHeight <= 48
  }

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
      loadedMessagesRef.current = []
      setView("detail")
      await loadSelected(created.id, created.directory)
      await loadModels(created.id, created.directory)
      await refreshSessions(false, createdView)
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
    loadAgents().catch(() => undefined)
    if (config.backend !== "omp") loadModels().catch(() => undefined)
    const timer = setInterval(() => {
      refreshSessions(true).catch(() => undefined)
      if (selectedSession) {
        loadSelected(selectedSession.id, selectedSession.directory).catch(() => undefined)
      }
    }, 3500)
    return () => clearInterval(timer)
  }, [config.backend, config.host, config.port, config.username, config.password, selectedSession?.id, selectedNewSessionDirectory])

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
      if (type.startsWith("session.") || type.startsWith("message.") || type.startsWith("todo.")) {
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
    if (view !== "detail" || !selectedSession) return
    scrollMessagesToBottom("auto")
  }, [view, selectedSession?.id])

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
            </select>
          </label>

          <label htmlFor="host">
            {t('settings.host')}
            <input
              id="host"
              value={draftConfig.host}
              onChange={(event) => setDraftConfig({ ...draftConfig, host: event.target.value })}
              placeholder={t('settings.hostPlaceholder')}
              aria-describedby="host-hint"
            />
          </label>
          <p className="field-hint" id="host-hint">{t('settings.hostHint')}</p>
          
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
            <div className="inline-actions">
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
                    <span className={`pill ${session.status}`}>{session.status}</span>
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
                  </div>
                  <div className="inline-actions">
                    <button
                      onClick={(event) => {
                        event.stopPropagation()
                        openSession(session.id, session.directory).catch(() => undefined)
                      }}
                      className="btn-primary"
                    >
                      <PlayIcon size={16} />
                      {t('sessions.open')}
                    </button>
                    {config.backend !== "omp" && (
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
                          {t('session.renameTitle')}
                        </button>
                        <button
                          className="btn-danger"
                          onClick={(event) => {
                            event.stopPropagation()
                            setSessionToDelete(session)
                          }}
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
                        {config.backend !== "omp" && (
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
                  <strong>{config.backend === "omp" ? activeModelOption?.modelName ?? t('detail.modelLoading') : `${agentLabel(activeAgent ?? { id: activeAgentID, name: activeAgentID, mode: "primary" })} · ${activeModelOption?.modelName ?? t('detail.modelLoading')}`}</strong>
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

          <div className="messages-wrap">
            <div className="messages" ref={messagesRef}>
            {loadingSessionID === selectedID ? (
              <div className="empty-state compact">
                <LoadingIcon size={32} />
                <p>{t('detail.loading')}</p>
              </div>
            ) : renderedMessages.length === 0 && !showTypingBubble ? (
              <div className="empty-state compact">
                <ChatIcon size={40} className="icon-empty-state" />
                <p>{t('detail.emptyTitle')}</p>
                <p className="subtle">{t('detail.emptyHint')}</p>
              </div>
            ) : (
              <>
                {renderedMessages.map((message) => (
                  <article key={message.info.id} className={`message ${message.info.role} fade-in`}>
                    <header>
                      <strong>
                        {message.info.role === "user" ? t('detail.you') : assistantDisplayName}
                      </strong>
                      <small>{formatTime(message.info.time.created)}</small>
                    </header>
                    <div className="message-content">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {normalizeMessageMarkdown(message.text)}
                      </ReactMarkdown>
                    </div>
                  </article>
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
                  if (!isWorking) {
                    send().catch(() => undefined)
                  }
                }
              }}
              disabled={!selectedSession || isWorking}
            />
            <button 
              onClick={isWorking ? abortSession : send}
              disabled={!selectedSession}
              className={isWorking ? "btn-danger" : "btn-primary"}
            >
              {isWorking ? (
                <>
                  <StopCircleIcon size={18} />
                  {t('detail.waiting')}
                </>
              ) : (
                <>
                  <SendIcon size={18} />
                  {t('detail.send')}
                </>
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
                {config.backend !== "omp" && (primaryAgentOptions.length > 0 ? (
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
              <h3>{config.backend === "omp" ? "Oh My Pi bridge" : "OpenCode server"}</h3>
              <p>
                This page keeps setup brief. Full, versioned backend guides live in the Harness Remote repository so new
                backends do not make the app help unwieldy.
              </p>
              <div className="code-blocks">
                {config.backend === "omp" ? (
                  <>
                    <h4>OMP bridge (macOS / Linux)</h4>
                    <pre>npx --yes ./bridge --host 0.0.0.0 --port 4097 --username omp --password your-password --root "$PWD"</pre>
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
                  href={`https://github.com/giuliastro/harness-remote#${config.backend === "omp" ? "oh-my-pi-bridge-setup" : "opencode-server-setup"}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open the complete {config.backend === "omp" ? "OMP bridge" : "OpenCode server"} guide in the repository
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
