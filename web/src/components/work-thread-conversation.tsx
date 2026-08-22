import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import { mergeLatestMessagePage, prependOlderMessagePage } from "../message-pages"
import type { SavedServerProfile } from "../serverProfiles"
import {
  taskClient,
  type MachineTask,
  type MachineTaskRun
} from "../taskClient"
import { startTaskDeskSessionLiveRefresh } from "../taskdesk-session-live-refresh"
import type {
  BackendKind,
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
  const [elapsed, setElapsed] = useState(() => Number.isFinite(start) ? Math.max(0, Math.floor((Date.now() - start) / 1_000)) : 0)

  useEffect(() => {
    const tick = () => setElapsed(Number.isFinite(start) ? Math.max(0, Math.floor((Date.now() - start) / 1_000)) : 0)
    tick()
    const timer = window.setInterval(tick, 1_000)
    return () => window.clearInterval(timer)
  }, [startedAt])

  return elapsed
}

function ConversationStatePill({
  working,
  attention,
  workingLabel,
  startedAt
}: {
  working: boolean
  attention: boolean
  workingLabel: string
  startedAt?: string
}) {
  const elapsed = useElapsedSeconds(working && !attention ? startedAt : undefined)
  const state = attention ? "attention" : working ? "working" : "ready"
  const text = attention
    ? "Needs attention"
    : working
      ? `${workingLabel}${elapsed >= 2 ? ` · ${elapsed}s` : ""}`
      : "Ready"
  return <span className={`tdw-conversation-state ${state}`}><i aria-hidden="true" /><span>{text}</span></span>
}

const WorkThreadBubble = memo(function WorkThreadBubble({ message }: { message: WorkThreadMessage }) {
  const meta = message.taskdesk
  if (message.info.role === "taskdesk") {
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
        <header>
          <strong>{label}</strong>
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
  onAttentionChange
}: Props) {
  const draftStorageKey = `${DRAFT_STORAGE_PREFIX}${task.id}`
  const [feeds, setFeeds] = useState<Record<string, SessionFeed>>({})
  const feedsRef = useRef<Record<string, SessionFeed>>({})
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [draft, setDraft] = useState(() => localStorage.getItem(draftStorageKey) || "")
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [questions, setQuestions] = useState<QuestionRequest[]>([])
  const [permissions, setPermissions] = useState<PermissionRequest[]>([])
  const [targetAgentID, setTargetAgentID] = useState(agentForRun(task, task.run))
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [targetModelKey, setTargetModelKey] = useState(modelKey(lastModelForAgent(task, agentForRun(task, task.run))))
  const loadGeneration = useRef(0)
  const modelGeneration = useRef(0)
  const targetAgentIDRef = useRef(targetAgentID)
  const sendInFlightRef = useRef(false)
  const stopInFlightRef = useRef(false)
  const tailInFlightRef = useRef(false)
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
  const currentAgent = agents.find((agent) => agent.id === currentAgentID)
  const currentSessionID = runSessionID(task.run)
  const currentTarget = currentSessionID ? targets.find((target) => target.sessionID === currentSessionID) : undefined
  const working = isActive(task)
  const conversationSignature = taskConversationSignature(task)

  useEffect(() => { feedsRef.current = feeds }, [feeds])
  useEffect(() => { targetAgentIDRef.current = targetAgentID }, [targetAgentID])
  useEffect(() => {
    if (draft) localStorage.setItem(draftStorageKey, draft)
    else localStorage.removeItem(draftStorageKey)
  }, [draft, draftStorageKey])

  useEffect(() => {
    setFeeds({})
    feedsRef.current = {}
    setLoading(true)
    setError(null)
    setQuestions([])
    setPermissions([])
    setTargetAgentID(currentAgentID)
    setTargetModelKey(modelKey(lastModelForAgent(task, currentAgentID)))
    sendInFlightRef.current = false
    stopInFlightRef.current = false
    tailInFlightRef.current = false
    attentionInFlightRef.current = false
    reconcileInFlightRef.current = false
  }, [task.id])

  useEffect(() => {
    if (currentAgentID !== targetAgentIDRef.current && task.run?.id) {
      setTargetAgentID(currentAgentID)
      setTargetModelKey(modelKey(task.run.model ?? lastModelForAgent(task, currentAgentID)))
    }
  }, [currentAgentID, task.run?.id])

  const loadInitialTarget = useCallback(async (target: SessionTarget): Promise<SessionFeed> => {
    const page = await api.loadMessagePage(target.config, target.sessionID, target.directory, undefined, INITIAL_PAGE_SIZE, false)
    return { messages: page.messages, before: page.before, hasMore: page.hasMore }
  }, [])

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
    if (tailInFlightRef.current) return
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
    tailInFlightRef.current = true
    try {
      const page = await api.loadMessagePage(target.config, session, target.directory, undefined, INITIAL_PAGE_SIZE, false)
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
    } finally {
      tailInFlightRef.current = false
    }
  }, [baseConfig])

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
      let next = await taskClient.getWorkThread(baseConfig, prior.id)
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
            next = await taskClient.getWorkThread(baseConfig, next.id)
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
  }, [baseConfig, refreshCurrentTail, refreshAttention])

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
      return
    }
    setModelsLoading(true)
    setError(null)
    void taskClient.listAgentModels(baseConfig, targetAgentID).then((catalog) => {
      if (modelGeneration.current !== current) return
      setModels(catalog.models)
      const prior = lastModelForAgent(taskRef.current, targetAgentID)
      const priorKey = modelKey(prior)
      const chosen = catalog.models.find((model) => modelKey(model) === priorKey)
        || catalog.models.find((model) => model.isDefault)
        || catalog.models[0]
      setTargetModelKey(chosen ? modelKey(chosen) : priorKey)
    }).catch((reason) => {
      if (modelGeneration.current === current) {
        setModels([])
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    }).finally(() => {
      if (modelGeneration.current === current) setModelsLoading(false)
    })
  }, [targetAgentID, task.id, baseConfig])

  const selectedModel = models.find((model) => modelKey(model) === targetModelKey) ?? lastModelForAgent(task, targetAgentID)

  async function loadOlder() {
    if (loadingOlder) return
    const olderTargets = targets.filter((target) => feedsRef.current[target.sessionID]?.hasMore && feedsRef.current[target.sessionID]?.before)
    if (olderTargets.length === 0) return
    setLoadingOlder(true)
    try {
      await Promise.all(olderTargets.map(async (target) => {
        const current = feedsRef.current[target.sessionID]
        if (!current?.before) return
        const page = await api.loadMessagePage(target.config, target.sessionID, target.directory, current.before, OLDER_PAGE_SIZE, false)
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
    if (!text || sending || working || sendInFlightRef.current) return
    sendInFlightRef.current = true
    setSending(true)
    setError(null)
    setDraft("")
    try {
      const latest = await taskClient.getWorkThread(baseConfig, task.id)
      if (isActive(latest)) {
        onTaskUpdateRef.current(latest)
        throw new Error(`${agentLabel(agentsRef.current, agentForRun(latest, latest.run))} is still working. Stop it or wait for the reply before sending another message.`)
      }
      const next = await taskClient.continueTask(baseConfig, task.id, {
        prompt: text,
        agentId: targetAgentID,
        ...(selectedModel ? { model: { providerID: selectedModel.providerID, modelID: selectedModel.modelID, variant: selectedModel.variant } } : {})
      })
      localStorage.removeItem(draftStorageKey)
      onTaskUpdateRef.current(next)
      taskRef.current = next
      await refreshCurrentTail(next)
      void refreshAttention(next)
    } catch (reason) {
      setDraft((current) => current ? `${text}\n${current}` : text)
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
      const next = await taskClient.cancelWorkThread(baseConfig, task.id)
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
  const hasAttention = questions.length > 0 || permissions.length > 0
  const preparingReply = sending || (working && !currentRunHasAssistantSignal)
  const pendingAgentLabel = sending ? agentLabel(agents, targetAgentID) : currentLabel
  const waitingLabel = hasAttention
    ? "Waiting for your input"
    : preparingReply
      ? `${pendingAgentLabel} is getting started`
      : `${currentLabel} is working`

  useEffect(() => {
    onAttentionChangeRef.current?.(hasAttention)
  }, [hasAttention])

  return (
    <div className="tdw-work-thread-conversation">
      <div className="tdw-conversation-toolbar">
        <div className="tdw-agent-control">
          <label>
            <span>Continue with</span>
            <select value={targetAgentID} disabled={working || sending} onChange={(event) => setTargetAgentID(event.target.value)}>
              {agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.label}</option>)}
            </select>
          </label>
          <label className="tdw-model-control">
            <span>Model</span>
            <ModelPicker compact models={models} value={targetModelKey} onChange={setTargetModelKey} disabled={working || sending} loading={modelsLoading} />
          </label>
        </div>
        <ConversationStatePill working={working || sending} attention={hasAttention} workingLabel={waitingLabel} startedAt={sending ? undefined : task.run?.startedAt} />
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
        messages={timeline}
        agentLabel={currentLabel}
        agentBackend={currentAgent?.backend}
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
        onSend={send}
        sending={preparingReply}
        sendDisabled={working || hasAttention}
        onStop={working ? stop : undefined}
        stopping={stopping}
        placeholder={`Message ${agentLabel(agents, targetAgentID)}…`}
        emptyText="Start the conversation. You can continue with another coding agent at any time."
        footerHint={hasAttention ? "Your input is required before the agent can continue" : working ? "The agent is working on your last message" : undefined}
        renderMessage={(message) => <WorkThreadBubble key={message.info.id} message={message as WorkThreadMessage} />}
      />
    </div>
  )
}
