import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import type { AttachmentPart } from "../attachments"
import { createCoalescedTailRefresh } from "../coalesced-tail-refresh"
import { taskConversationController, type ConversationController } from "../conversation-controller"
import { mergeLatestMessagePage, prependOlderMessagePage } from "../message-pages"
import type { SavedServerProfile } from "../serverProfiles"
import {
  taskClient,
  type AgentModelScope,
  type MachineTask,
  type MachineTaskRun
} from "../taskClient"
import { startTaskDeskSessionLiveRefresh } from "../taskdesk-session-live-refresh"
import type {
  BackendKind,
  CommandInfo,
  MachineAgentHost,
  MessageEnvelope,
  ModelOption,
  ModelSelection,
  PermissionRequest,
  QuestionRequest,
  ServerConfig
} from "../types"
import {
  buildWorkThreadTimeline,
  CONVERSATION_EVENT_ROLE,
  runSessionID,
  workThreadRuns,
  type WorkThreadMessage,
  type WorkThreadAgentMeta
} from "../work-thread-timeline"
import { ModelPicker, modelOptionKey } from "./model-picker"
import { TaskDeskConversation } from "./taskdesk-conversation"
import { TaskDeskMessageContent } from "./taskdesk-message-content"
import { WorkThreadAttention } from "./work-thread-attention"

const INITIAL_PAGE_SIZE = 200
const OLDER_PAGE_SIZE = 500
const ACTIVE_RECONCILE_MS = 5_000
const IDLE_RECONCILE_MS = 30_000
const DRAFT_STORAGE_PREFIX = "harness-remote.taskdesk.draft."
// A synchronous localStorage write per keystroke is a measurable input cost on Android WebView and
// on long conversations. The draft is still flushed before the conversation is left.
const DRAFT_PERSIST_DEBOUNCE_MS = 400

const HARNESS_ICON_FILES: Record<string, string> = {
  codex: "codex.svg",
  claude: "claude.svg",
  opencode: "opencode.svg",
  omp: "omp.svg",
  pi: "pi.svg"
}

type SessionTarget = {
  sessionID: string
  agentID: string
  directory: string
  config: ServerConfig
}

type SessionFeed = {
  messages: MessageEnvelope[]
  before?: string
  hasMore: boolean
}

type Props = {
  task: MachineTask
  baseConfig: ServerConfig
  agents: MachineAgentHost[]
  onTaskUpdate: (task: MachineTask) => void
  onWorkspaceRefresh?: () => void
  onAttentionChange?: (needsAttention: boolean) => void
  commands?: CommandInfo[]
  /**
   * Which catalog identity this conversation's model picker should ask for. Defaults to the Work
   * Thread, which is what a Task-backed conversation means. A native-Session surface passes the
   * daemon's real catalog scope instead of a synthetic thread id, so it does not have to rewrite
   * this shared client for every other consumer.
   */
  modelScope?: AgentModelScope
  /**
   * Native Session model authority arrives from transcript metadata after this controller mounts.
   * Until then an empty choice means the harness default; do not present the catalog's first model
   * as if it were the Session's persisted selection.
   */
  deferModelFallback?: boolean
  /** Explicit I/O boundary. Native Sessions provide a Session-scoped controller. */
  controller?: ConversationController
}

function supportedBackend(value: string, fallback: BackendKind): BackendKind {
  return value === "opencode" || value === "omp" || value === "pi" || value === "claude" || value === "codex"
    ? value
    : fallback
}

function configForAgent(base: ServerConfig, agents: MachineAgentHost[], agentID: string): ServerConfig {
  const agent = agents.find((candidate) => candidate.id === agentID)
  return {
    ...base,
    backend: supportedBackend(agent?.backend || agentID, base.backend),
    agentId: agentID
  }
}

function agentForRun(task: MachineTask, run: MachineTaskRun | null | undefined): string {
  return run?.agentId || task.agentId
}

function agentMap(agents: MachineAgentHost[]): WorkThreadAgentMeta {
  return Object.fromEntries(agents.map((agent) => [agent.id, { label: agent.label, backend: agent.backend }]))
}

function agentLabel(agents: MachineAgentHost[], agentID: string): string {
  return agents.find((agent) => agent.id === agentID)?.label || agentID || "Coding agent"
}

function harnessIconUrl(backend: string | undefined): string | undefined {
  if (!backend) return undefined
  const file = HARNESS_ICON_FILES[backend.toLowerCase()]
  return file ? `${import.meta.env.BASE_URL}harness-icons/${file}` : undefined
}

function isActive(task: MachineTask): boolean {
  return task.status === "starting" || task.status === "running"
}

function modelKey(model?: ModelSelection | null): string {
  return model ? modelOptionKey(model as ModelOption) : ""
}

function lastModelForAgent(task: MachineTask, agentID: string): ModelSelection | null {
  const runs = workThreadRuns(task)
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]
    if (agentForRun(task, run) !== agentID || !run.model) continue
    return run.model
  }
  return task.agentId === agentID ? task.model ?? null : null
}

function sessionTargets(task: MachineTask, baseConfig: ServerConfig, agents: MachineAgentHost[]): SessionTarget[] {
  const bySession = new Map<string, SessionTarget>()
  for (const run of workThreadRuns(task)) {
    const session = runSessionID(run)
    if (!session || bySession.has(session)) continue
    const agentID = agentForRun(task, run)
    bySession.set(session, {
      sessionID: session,
      agentID,
      directory: run.directory || task.workspace.path,
      config: configForAgent(baseConfig, agents, agentID)
    })
  }
  return [...bySession.values()]
}

function taskConversationSignature(task: MachineTask): string {
  const runs = workThreadRuns(task).map((run) => [
    run.id || "",
    run.sequence || 0,
    run.agentId || "",
    runSessionID(run) || "",
    run.status || "",
    run.prompt || "",
    run.outcome || "",
    (run as MachineTaskRun & { error?: { message?: string } | string }).error instanceof Object
      ? (run as MachineTaskRun & { error?: { message?: string } }).error?.message || ""
      : String((run as MachineTaskRun & { error?: string }).error || ""),
    run.startedAt || "",
    run.finishedAt || ""
  ])
  return JSON.stringify([
    task.id,
    task.status,
    task.error?.message || "",
    task.finishedAt || "",
    runs
  ])
}

function sameRequests(left: Array<{ id: string }>, right: Array<{ id: string }>): boolean {
  return left.length === right.length && left.every((item, index) => item.id === right[index]?.id)
}

function useElapsedSeconds(startedAt?: string): number {
  const start = Date.parse(startedAt || "")
  const running = Number.isFinite(start)
  const [elapsed, setElapsed] = useState(() => running ? Math.max(0, Math.floor((Date.now() - start) / 1_000)) : 0)

  useEffect(() => {
    if (!running) {
      // No running Run means no clock. Keeping a 1s interval alive here woke the whole conversation
      // toolbar every second while the agent was idle.
      setElapsed(0)
      return
    }
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1_000)))
    tick()
    const timer = window.setInterval(tick, 1_000)
    return () => window.clearInterval(timer)
  }, [startedAt, running, start])

  return elapsed
}

/**
 * The pill used to know only working / questions-pending / ready, so a failed or cancelled
 * Conversation reported "Ready" here while its own card in the list said "Needs attention" or
 * "Stopped". The detail view was the one hiding the problem, and for a cancelled Conversation the
 * interruption was not visible anywhere — the opposite of the fidelity rule in #197.
 */
function conversationOutcome(status: string): { state: "attention" | "stopped"; text: string } | null {
  if (status === "failed") return { state: "attention", text: "Needs attention" }
  if (status === "cancelled") return { state: "stopped", text: "Stopped" }
  return null
}

function ConversationStatePill({
  working,
  attention,
  workingLabel,
  startedAt,
  status,
  detail
}: {
  working: boolean
  attention: boolean
  workingLabel: string
  startedAt?: string
  status: string
  detail?: string
}) {
  const elapsed = useElapsedSeconds(working && !attention ? startedAt : undefined)
  const outcome = working || attention ? null : conversationOutcome(status)
  const state = attention ? "attention" : working ? "working" : outcome?.state || "ready"
  const text = attention
    ? "Needs attention"
    : working
      ? `${workingLabel}${elapsed >= 2 ? ` · ${elapsed}s` : ""}`
      : outcome?.text || "Ready"
  return <span className={`tdw-conversation-state ${state}`} title={outcome && detail ? detail : undefined}><i aria-hidden="true" /><span>{text}</span></span>
}

const WorkThreadBubble = memo(function WorkThreadBubble({ message, activity }: { message: WorkThreadMessage; activity?: string }) {
  const meta = message.taskdesk
  if (message.info.role === CONVERSATION_EVENT_ROLE) {
    return (
      <div className="tdw-conversation-event">
        <span>{message.parts.find((part) => part.type === "text")?.text || "Conversation event"}</span>
      </div>
    )
  }
  const isUser = message.info.role === "user"
  const label = isUser ? "You" : meta?.agentLabel || "Coding agent"
  const icon = !isUser ? harnessIconUrl(meta?.agentBackend) : undefined
  return (
    <article className={`uw-message ${isUser ? "uw-message-user" : "uw-message-agent"}`}>
      <div className={`uw-avatar ${isUser ? "uw-avatar-user" : "uw-avatar-agent"}`} aria-hidden="true">
        {isUser ? "You" : icon ? <img src={icon} alt="" /> : label.slice(0, 2).toUpperCase()}
      </div>
      <div className="uw-message-body">
        {/* One identity row per reply, and the live state is *in* it: the same avatar and the same
            line the reply will carry when it is finished, reading "<agent> is working" while it is
            not. A separate status row under this one would be a second name for the same turn. */}
        <header>
          <strong className={activity ? "uw-message-working" : undefined} {...(activity ? { role: "status", "aria-live": "polite" as const } : {})}>{activity || label}</strong>
          <time>{message.info.time.created ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(message.info.time.created) : ""}</time>
        </header>
        <TaskDeskMessageContent message={message} />
      </div>
    </article>
  )
})

export function WorkThreadConversation({
  task,
  baseConfig,
  agents,
  onTaskUpdate,
  onWorkspaceRefresh,
  onAttentionChange,
  commands = [],
  modelScope,
  deferModelFallback = false,
  controller = taskConversationController
}: Props) {
  const draftStorageKey = `${DRAFT_STORAGE_PREFIX}${task.id}`
  const initialAgentID = agentForRun(task, task.run)
  const initialModelKey = modelKey(lastModelForAgent(task, initialAgentID))
  const [feeds, setFeeds] = useState<Record<string, SessionFeed>>({})
  const feedsRef = useRef<Record<string, SessionFeed>>({})
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [draft, setDraft] = useState(() => localStorage.getItem(draftStorageKey) || "")
  const [attachments, setAttachments] = useState<AttachmentPart[]>([])
  const [sending, setSending] = useState(false)
  // The prompt that has been sent but is not yet in the transcript, with the Run that was current
  // when it was sent. See `visibleTimeline`.
  const [pendingPrompt, setPendingPrompt] = useState<{ text: string; priorRunID: string | null; attachments: AttachmentPart[] } | null>(null)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [questions, setQuestions] = useState<QuestionRequest[]>([])
  const [permissions, setPermissions] = useState<PermissionRequest[]>([])
  const [targetAgentID, setTargetAgentID] = useState(initialAgentID)
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [targetModelKey, setTargetModelKey] = useState(initialModelKey)
  // The catalog effect must depend on the scope's value, not a caller's object identity: a fresh
  // object per render would restart model discovery on every render.
  const modelScopeKey = modelScope ? `${modelScope.workThreadId ?? ""}|${modelScope.projectId ?? ""}` : ""
  const loadGeneration = useRef(0)
  const modelGeneration = useRef(0)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const targetAgentIDRef = useRef(targetAgentID)
  const observedTaskModelKeyRef = useRef(initialModelKey)
  const modelSelectionTouchedRef = useRef(false)
  const sendInFlightRef = useRef(false)
  const stopInFlightRef = useRef(false)
  const tailRefreshRef = useRef(createCoalescedTailRefresh())
  const attentionInFlightRef = useRef(false)
  const reconcileInFlightRef = useRef(false)
  const taskRef = useRef(task)
  const agentsRef = useRef(agents)
  const onTaskUpdateRef = useRef(onTaskUpdate)
  const onWorkspaceRefreshRef = useRef(onWorkspaceRefresh)
  const onAttentionChangeRef = useRef(onAttentionChange)

  taskRef.current = task
  agentsRef.current = agents
  onTaskUpdateRef.current = onTaskUpdate
  onWorkspaceRefreshRef.current = onWorkspaceRefresh
  onAttentionChangeRef.current = onAttentionChange

  const targets = useMemo(() => sessionTargets(task, baseConfig, agents), [task.id, task.runs, task.run, task.workspace.path, baseConfig, agents])
  const targetSignature = targets.map((target) => `${target.sessionID}:${target.agentID}:${target.directory}`).join("|")
  const agentsSignature = agents.map((agent) => `${agent.id}:${agent.label}:${agent.backend}`).join("|")
  const agentsByID = useMemo(() => agentMap(agents), [agentsSignature])
  const currentAgentID = agentForRun(task, task.run)
  const currentTaskModelKey = modelKey(lastModelForAgent(task, currentAgentID))
  const currentAgent = agents.find((agent) => agent.id === currentAgentID)
  const currentSessionID = runSessionID(task.run)
  const currentTarget = currentSessionID ? targets.find((target) => target.sessionID === currentSessionID) : undefined
  const working = isActive(task)
  // JSON.stringify over every Run is far too expensive to repeat on each keystroke. The Task object
  // identity only changes when the workspace actually reloads or updates the conversation.
  const conversationSignature = useMemo(() => taskConversationSignature(task), [task])

  const persistDraft = useCallback((key: string, value: string) => {
    try {
      if (value) localStorage.setItem(key, value)
      else localStorage.removeItem(key)
    } catch {
      // A private-mode or storage-full browser still keeps the in-memory draft.
    }
  }, [])

  useEffect(() => { feedsRef.current = feeds }, [feeds])
  useEffect(() => { targetAgentIDRef.current = targetAgentID }, [targetAgentID])
  useEffect(() => {
    const timer = window.setTimeout(() => persistDraft(draftStorageKey, draftRef.current), DRAFT_PERSIST_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [draft, draftStorageKey, persistDraft])

  // Leaving the conversation must not lose a draft that the debounce has not written yet.
  useEffect(() => () => persistDraft(draftStorageKey, draftRef.current), [draftStorageKey, persistDraft])

  useEffect(() => {
    setFeeds({})
    feedsRef.current = {}
    setLoading(true)
    setError(null)
    setModelError(null)
    setQuestions([])
    setPermissions([])
    setAttachments([])
    setPendingPrompt(null)
    setTargetAgentID(currentAgentID)
    setTargetModelKey(currentTaskModelKey)
    observedTaskModelKeyRef.current = currentTaskModelKey
    modelSelectionTouchedRef.current = false
    sendInFlightRef.current = false
    stopInFlightRef.current = false
    attentionInFlightRef.current = false
    reconcileInFlightRef.current = false
  }, [task.id])

  useEffect(() => {
    if (currentAgentID !== targetAgentIDRef.current && task.run?.id) {
      const nextModelKey = modelKey(task.run.model ?? lastModelForAgent(task, currentAgentID))
      setTargetAgentID(currentAgentID)
      setTargetModelKey(nextModelKey)
      observedTaskModelKeyRef.current = nextModelKey
      modelSelectionTouchedRef.current = false
    }
  }, [currentAgentID, task.run?.id])

  // Native Session enrichment is intentionally asynchronous so transcript rendering never waits for
  // model discovery. If the catalog wins that race it may temporarily choose its default. Follow a
  // later verified model from the Task projection unless the user has already touched the picker;
  // this keeps the control on the Session's real last model without clobbering an explicit choice.
  useEffect(() => {
    const previous = observedTaskModelKeyRef.current
    observedTaskModelKeyRef.current = currentTaskModelKey
    if (!currentTaskModelKey || currentTaskModelKey === previous) return
    if (currentAgentID !== targetAgentIDRef.current || modelSelectionTouchedRef.current) return
    setTargetModelKey(currentTaskModelKey)
  }, [currentAgentID, currentTaskModelKey])

  const loadInitialTarget = useCallback(async (target: SessionTarget): Promise<SessionFeed> => {
    const page = await controller.loadMessagePage(target.config, target.sessionID, target.directory, undefined, INITIAL_PAGE_SIZE, false)
    return { messages: page.messages, before: page.before, hasMore: page.hasMore }
  }, [controller])

  useEffect(() => {
    const generation = ++loadGeneration.current
    let cancelled = false
    const missing = targets.filter((target) => !feedsRef.current[target.sessionID])
    if (missing.length === 0) {
      setLoading(false)
      return
    }
    if (Object.keys(feedsRef.current).length === 0) setLoading(true)
    void Promise.all(missing.map(async (target) => {
      try {
        const feed = await loadInitialTarget(target)
        if (cancelled || loadGeneration.current !== generation) return
        setFeeds((current) => current[target.sessionID] ? current : { ...current, [target.sessionID]: feed })
      } catch {
        // Durable Task history can outlive a native Session. Persisted Run outcome/error is the safe
        // fallback; do not invent a transcript association when the Session cannot be read.
      }
    })).finally(() => {
      if (!cancelled && loadGeneration.current === generation) setLoading(false)
    })
    return () => { cancelled = true }
  }, [targetSignature, loadInitialTarget])

  const messagesBySession = useMemo(
    () => Object.fromEntries(Object.entries(feeds).map(([session, feed]) => [session, feed.messages])),
    [feeds]
  )
  const timeline = useMemo(
    () => buildWorkThreadTimeline(task, messagesBySession, agentsByID),
    [conversationSignature, messagesBySession, agentsByID]
  )

  /**
   * What the user just sent, shown from the moment they send it.
   *
   * Sending used to clear the composer and then show nothing until `continueTask` came back with a
   * Run, at which point the message appeared - and appeared again, remounted, once that Run carried
   * a real id and the timeline's key for its row changed from the run's index to that id. On screen
   * that reads as the message flashing in, being removed and being redrawn. The optimistic row
   * closes the gap: same bubble, same place, keyed once. It stands down the moment the real row
   * exists - either because the text is in the transcript or because a new Run is on the Task, which
   * is what that row is built from - so the two are never on screen together.
   */
  const settledPrompt = pendingPrompt
    && (Boolean(task.run?.id && task.run.id !== pendingPrompt.priorRunID)
      || timeline.some((message) => message.info.role === "user"
        && message.parts.some((part) => part.type === "text" && part.text?.trim() === pendingPrompt.text)))

  const visibleTimeline = useMemo(() => {
    if (!pendingPrompt || settledPrompt) return timeline
    const id = `work-thread:${task.id}:pending-user`
    return [...timeline, {
      info: { id, role: "user", sessionID: `work-thread:${task.id}`, time: { created: Date.now() } },
      parts: [
        ...(pendingPrompt.text ? [{ id: `${id}:text`, messageID: id, type: "text", text: pendingPrompt.text }] : []),
        ...pendingPrompt.attachments.map((attachment, index) => ({
          ...attachment,
          id: `${id}:attachment:${index}`,
          messageID: id
        }))
      ],
      taskdesk: { kind: "synthetic-user" as const }
    } as WorkThreadMessage]
  }, [timeline, pendingPrompt, settledPrompt, task.id])

  useEffect(() => {
    if (settledPrompt) setPendingPrompt(null)
  }, [settledPrompt])

  const currentRunHasAssistantSignal = useMemo(() => {
    const runID = task.run?.id
    if (!runID) return false
    return timeline.some((message) => message.info.role === "assistant"
      && message.taskdesk?.runId === runID
      && message.parts.some((part) => {
        if (part.type === "tool") return true
        if (part.type === "reasoning") return Boolean(part.text?.trim() || part.time?.start)
        return part.type === "text" && Boolean(part.text?.trim())
      }))
  }, [timeline, task.run?.id])
  const hasMore = Object.values(feeds).some((feed) => feed.hasMore && feed.before)

  const refreshCurrentTail = useCallback(async (sourceTask?: MachineTask) => {
    const currentTask = sourceTask ?? taskRef.current
    const run = currentTask.run
    const session = runSessionID(run)
    if (!session) return
    const currentAgents = agentsRef.current
    const agentID = agentForRun(currentTask, run)
    const target: SessionTarget = {
      sessionID: session,
      agentID,
      directory: run?.directory || currentTask.workspace.path,
      config: configForAgent(baseConfig, currentAgents, agentID)
    }
    await tailRefreshRef.current(async () => {
      try {
        const page = await controller.loadMessagePage(target.config, session, target.directory, undefined, INITIAL_PAGE_SIZE, false)
        setFeeds((current) => {
          const existing = current[session]
          if (!existing) return { ...current, [session]: { messages: page.messages, before: page.before, hasMore: page.hasMore } }
          const messages = mergeLatestMessagePage(existing.messages, page.messages)
          const hasMore = existing.hasMore || page.hasMore
          const before = existing.before || page.before
          if (messages === existing.messages && hasMore === existing.hasMore && before === existing.before) return current
          return { ...current, [session]: { ...existing, messages, hasMore, before } }
        })
      } catch {
        // Live refresh is opportunistic. The existing transcript remains visible and the slow
        // reconciliation path will retry without clearing or replacing it.
      }
    })
  }, [baseConfig, controller])

  const refreshAttention = useCallback(async (sourceTask?: MachineTask) => {
    if (attentionInFlightRef.current) return
    const currentTask = sourceTask ?? taskRef.current
    const run = currentTask.run
    const session = runSessionID(run)
    if (!session) {
      setQuestions((current) => current.length ? [] : current)
      setPermissions((current) => current.length ? [] : current)
      return
    }
    const currentAgents = agentsRef.current
    const agentID = agentForRun(currentTask, run)
    const config = configForAgent(baseConfig, currentAgents, agentID)
    const directory = run?.directory || currentTask.workspace.path
    attentionInFlightRef.current = true
    try {
      const [nextQuestions, nextPermissions] = await Promise.all([
        api.loadQuestions(config, directory).catch(() => []),
        api.loadPermissions(config, directory).catch(() => [])
      ])
      const scopedQuestions = nextQuestions.filter((request) => request.sessionID === session)
      const scopedPermissions = nextPermissions.filter((request) => request.sessionID === session)
      setQuestions((current) => sameRequests(current, scopedQuestions) ? current : scopedQuestions)
      setPermissions((current) => sameRequests(current, scopedPermissions) ? current : scopedPermissions)
    } finally {
      attentionInFlightRef.current = false
    }
  }, [baseConfig])

  const reconcile = useCallback(async () => {
    if (reconcileInFlightRef.current) return
    reconcileInFlightRef.current = true
    try {
      const prior = taskRef.current
      let next = await controller.getWorkThread(baseConfig, prior.id)
      if (taskConversationSignature(next) !== taskConversationSignature(prior)
        || next.title !== prior.title
        || next.checkpoints?.length !== prior.checkpoints?.length) {
        onTaskUpdateRef.current(next)
        taskRef.current = next
      }
      await Promise.all([refreshCurrentTail(next), refreshAttention(next)])
      const hasRunCheckpoint = Boolean(next.run?.id && next.checkpoints?.some((checkpoint) => checkpoint.kind === "after-run" && checkpoint.runId === next.run?.id))
      if (next.workspace.mode === "worktree" && !isActive(next) && next.run?.id && next.run.finishedAt && !hasRunCheckpoint) {
        try {
          const created = await taskClient.createCheckpoint(baseConfig, next.id, {
            label: `After ${agentLabel(agentsRef.current, agentForRun(next, next.run))}`,
            kind: "after-run",
            runId: next.run.id
          })
          if (created) {
            next = await controller.getWorkThread(baseConfig, next.id)
            onTaskUpdateRef.current(next)
            taskRef.current = next
            onWorkspaceRefreshRef.current?.()
          }
        } catch {
          // Checkpoints are useful orchestration metadata, never a chat blocker.
        }
      }
    } catch {
      // A transient reconcile failure must never clear a valid conversation.
    } finally {
      reconcileInFlightRef.current = false
    }
  }, [baseConfig, controller, refreshCurrentTail, refreshAttention])

  useEffect(() => {
    void refreshAttention()
    const delay = working ? ACTIVE_RECONCILE_MS : IDLE_RECONCILE_MS
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void reconcile()
    }, delay)
    return () => window.clearInterval(timer)
  }, [working, reconcile, refreshAttention])

  useEffect(() => {
    if (!currentTarget) return
    const currentAgents = agentsRef.current
    const profile: SavedServerProfile = {
      id: `thread:${task.id}:${currentTarget.agentID}`,
      name: agentLabel(currentAgents, currentTarget.agentID),
      config: currentTarget.config
    }
    const subscription = startTaskDeskSessionLiveRefresh({
      targets: [{ key: profile.id, profile, config: currentTarget.config }],
      getSelected: () => ({ targetKey: profile.id, sessionID: currentTarget.sessionID }),
      onMessage: () => void refreshCurrentTail(),
      onIndex: () => void reconcile(),
      onDetail: () => void refreshAttention()
    })
    return () => subscription.close()
    // These scalar values identify the native stream. Do not depend on the changing Task object or
    // callback identities: doing so reopened the OpenCode stream on every reconcile tick.
  }, [task.id, currentTarget?.sessionID, currentTarget?.agentID, currentTarget?.directory, refreshCurrentTail, reconcile, refreshAttention])

  useEffect(() => {
    const current = ++modelGeneration.current
    if (!targetAgentID) {
      setModels([])
      setTargetModelKey("")
      setModelError(null)
      return
    }
    // A model from the previously selected harness must never remain selectable while this catalog
    // is warming. Conversation history stays usable independently of model discovery.
    setModels([])
    setModelsLoading(true)
    setModelError(null)
    void taskClient.listAgentModels(baseConfig, targetAgentID, modelScope ?? { workThreadId: task.id }).then((catalog) => {
      if (modelGeneration.current !== current) return
      setModels(catalog.models)
      const prior = lastModelForAgent(taskRef.current, targetAgentID)
      const priorKey = modelKey(prior)
      const fallback = deferModelFallback
        ? undefined
        : catalog.models.find((model) => model.isDefault) || catalog.models[0]
      const chosen = catalog.models.find((model) => modelKey(model) === priorKey) || fallback
      setTargetModelKey((currentKey) => {
        if (modelSelectionTouchedRef.current && catalog.models.some((model) => modelKey(model) === currentKey)) return currentKey
        return chosen ? modelKey(chosen) : ""
      })
    }).catch((reason) => {
      if (modelGeneration.current === current) {
        setModels([])
        setTargetModelKey("")
        setModelError(reason instanceof Error ? reason.message : String(reason))
      }
    }).finally(() => {
      if (modelGeneration.current === current) setModelsLoading(false)
    })
  }, [targetAgentID, task.id, task.workspace.path, baseConfig, modelScopeKey, deferModelFallback])

  // Only a model verified by the current live catalog is sent explicitly. A null selection is
  // intentional: the controller distinguishes it from an omitted field, which means reuse the
  // previous Run's model. Null therefore asks the harness for its current native default and cannot
  // resurrect a persisted provider model that has since been removed.
  const selectedModel = models.find((model) => modelKey(model) === targetModelKey)

  async function loadOlder() {
    if (loadingOlder) return
    const olderTargets = targets.filter((target) => feedsRef.current[target.sessionID]?.hasMore && feedsRef.current[target.sessionID]?.before)
    if (olderTargets.length === 0) return
    setLoadingOlder(true)
    try {
      await Promise.all(olderTargets.map(async (target) => {
        const current = feedsRef.current[target.sessionID]
        if (!current?.before) return
        const page = await controller.loadMessagePage(target.config, target.sessionID, target.directory, current.before, OLDER_PAGE_SIZE, false)
        setFeeds((feedsNow) => {
          const feed = feedsNow[target.sessionID] ?? current
          const messages = prependOlderMessagePage(feed.messages, page.messages)
          if (messages === feed.messages && page.before === feed.before && page.hasMore === feed.hasMore) return feedsNow
          return {
            ...feedsNow,
            [target.sessionID]: { messages, before: page.before, hasMore: page.hasMore }
          }
        })
      }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoadingOlder(false)
    }
  }

  async function send() {
    const text = draft.trim()
    const promptAttachments = attachments
    const slashMatch = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text)
    const matchedCommand = slashMatch
      ? commands.find((command) => command.name.toLowerCase() === slashMatch[1].toLowerCase())
      : undefined
    const slashCommand = slashMatch && matchedCommand
      ? { name: matchedCommand.name, arguments: (slashMatch[2] || "").trim() }
      : undefined
    if ((!text && !promptAttachments.length) || sending || working || sendInFlightRef.current) return
    sendInFlightRef.current = true
    setSending(true)
    setError(null)
    setDraft("")
    setPendingPrompt({ text, priorRunID: taskRef.current.run?.id ?? null, attachments: promptAttachments })
    try {
      const latest = await controller.getWorkThread(baseConfig, task.id)
      if (isActive(latest)) {
        onTaskUpdateRef.current(latest)
        throw new Error(`${agentLabel(agentsRef.current, agentForRun(latest, latest.run))} is still working. Stop it or wait for the reply before sending another message.`)
      }
      const next = await controller.continueTask(baseConfig, task.id, {
        prompt: text,
        attachments: promptAttachments,
        command: slashCommand,
        agentId: targetAgentID,
        model: selectedModel ? { providerID: selectedModel.providerID, modelID: selectedModel.modelID, variant: selectedModel.variant } : null
      })
      localStorage.removeItem(draftStorageKey)
      setAttachments([])
      onTaskUpdateRef.current(next)
      taskRef.current = next
      modelSelectionTouchedRef.current = false
      await refreshCurrentTail(next)
      void refreshAttention(next)
    } catch (reason) {
      // The prompt goes back to the composer, so it must also stop standing in for a turn that was
      // never accepted.
      setPendingPrompt(null)
      setDraft((current) => text ? (current ? `${text}\n${current}` : text) : current)
      setAttachments(promptAttachments)
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      sendInFlightRef.current = false
      setSending(false)
    }
  }

  async function stop() {
    if (stopping || !working || stopInFlightRef.current) return
    stopInFlightRef.current = true
    setStopping(true)
    setError(null)
    try {
      const next = await controller.cancelWorkThread(baseConfig, task.id)
      onTaskUpdateRef.current(next)
      taskRef.current = next
      await Promise.all([refreshCurrentTail(next), refreshAttention(next)])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      stopInFlightRef.current = false
      setStopping(false)
    }
  }

  const currentLabel = agentLabel(agents, currentAgentID)
  const attachmentAgent = agents.find((agent) => agent.id === targetAgentID)
  const attachmentsSupported = attachmentAgent?.capabilities?.attachments === true
  const hasAttention = questions.length > 0 || permissions.length > 0
  const preparingReply = sending || (working && !currentRunHasAssistantSignal)
  const pendingAgentLabel = sending ? agentLabel(agents, targetAgentID) : currentLabel
  // The pending bubble is the reply that is coming, so it wears the identity of the agent that is
  // about to answer rather than the one that answered last.
  const pendingAgentBackend = (sending ? agents.find((agent) => agent.id === targetAgentID) : currentAgent)?.backend
  // Only the turn that is actually running carries the live status row, and only once its bubble is
  // on screen - before that the pending bubble is showing the very same row.
  const liveRunID = working && !hasAttention && currentRunHasAssistantSignal ? task.run?.id : undefined

  const waitingLabel = hasAttention
    ? "Waiting for your input"
    : preparingReply
      ? `${pendingAgentLabel} is getting started`
      : `${currentLabel} is working`

  /**
   * Exactly one row, on exactly one bubble.
   *
   * A Run's id is on every row the Run produced, the synthetic user message included, so matching on
   * the id alone put the status row inside the user's own bubble as well as the reply's. The status
   * of a turn belongs to the reply, so the role is part of the match - and `liveRunID` is already
   * mutually exclusive with the pending bubble, which is the only other place this row can appear.
   */
  const activityForMessage = (message: WorkThreadMessage): string | undefined =>
    liveRunID && message.info.role === "assistant" && message.taskdesk?.runId === liveRunID
      ? waitingLabel
      : undefined

  useEffect(() => {
    onAttentionChangeRef.current?.(hasAttention)
  }, [hasAttention])

  return (
    <div className="tdw-work-thread-conversation">
      <div className="tdw-conversation-toolbar">
        <div className="tdw-agent-control">
          <label>
            <span>Continue with</span>
            <select value={targetAgentID} disabled={working || sending} onChange={(event) => {
              modelSelectionTouchedRef.current = false
              setTargetAgentID(event.target.value)
            }}>
              {agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.label}</option>)}
            </select>
          </label>
          <label className="tdw-model-control">
            <span>Model</span>
            <ModelPicker compact models={models} value={targetModelKey} onChange={(value) => {
              modelSelectionTouchedRef.current = true
              setTargetModelKey(value)
            }} disabled={working || sending} loading={modelsLoading} placeholder={deferModelFallback ? "Harness default" : undefined} unavailableHint={modelError || undefined} />
            {modelError ? <small className="tdw-field-note" title={modelError}>Model catalog unavailable. Continue uses the harness default.</small> : null}
          </label>
        </div>
        <ConversationStatePill working={working || sending} attention={hasAttention} workingLabel={waitingLabel} startedAt={sending ? undefined : task.run?.startedAt} status={task.status} detail={task.error?.message || undefined} />
      </div>

      <WorkThreadAttention
        config={currentTarget?.config || configForAgent(baseConfig, agents, currentAgentID)}
        directory={currentTarget?.directory || task.workspace.path}
        questions={questions}
        permissions={permissions}
        onResolved={async () => { await refreshAttention(); await reconcile() }}
      />

      {error ? <div className="tdw-chat-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>×</button></div> : null}

      <TaskDeskConversation
        messages={visibleTimeline}
        agentLabel={pendingAgentLabel}
        agentBackend={pendingAgentBackend}
        loading={loading}
        ready={!loading}
        waiting={working}
        workingLabel={waitingLabel}
        showWaitingIndicator={false}
        hasMore={hasMore}
        loadingOlder={loadingOlder}
        onLoadOlder={loadOlder}
        draft={draft}
        onDraftChange={setDraft}
        commands={commands}
        attachments={attachments}
        attachmentsSupported={attachmentsSupported}
        onAttachmentsChange={setAttachments}
        onAttachmentError={setError}
        onSend={send}
        sending={preparingReply}
        sendDisabled={working || hasAttention}
        onStop={working ? stop : undefined}
        stopping={stopping}
        placeholder={`Message ${agentLabel(agents, targetAgentID)}…`}
        emptyText="Start the conversation. You can continue with another coding agent at any time."
        footerHint={hasAttention ? "Your input is required before the agent can continue" : working ? "The agent is working on your last message" : undefined}
        renderMessage={(message) => (
          <WorkThreadBubble
            key={message.info.id}
            message={message as WorkThreadMessage}
            activity={activityForMessage(message as WorkThreadMessage)}
          />
        )}
      />
    </div>
  )
}