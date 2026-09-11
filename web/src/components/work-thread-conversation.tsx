import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import type { AttachmentPart } from "../attachments"
import { createCoalescedTailRefresh } from "../coalesced-tail-refresh"
import type { ConversationController } from "../conversation-controller"
import { conversationTurnSessionID, conversationTurns, type ConversationRuntime, type ConversationTurn } from "../conversation-runtime"
import { mergeLatestMessagePage, prependOlderMessagePage } from "../message-pages"
import type { NativeSessionRouteContinueInput, NativeSessionRouteMachine } from "../native-session-routing"
import type { SavedServerProfile } from "../serverProfiles"
import { taskClient, type AgentModelScope } from "../taskClient"
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
  buildConversationTimeline,
  CONVERSATION_EVENT_ROLE,
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
const REPLY_SETTLE_RECONCILE_MS = 1_500
const REPLY_SETTLE_IDLE_GRACE_MS = 20_000
const IDLE_RECONCILE_MS = 30_000
const DRAFT_STORAGE_PREFIX = "harness-remote.taskdesk.draft."
// A synchronous localStorage write per keystroke is a measurable input cost on Android WebView and
// on long conversations. The draft is still flushed before the conversation is left.
const DRAFT_PERSIST_DEBOUNCE_MS = 400
const NATIVE_ROUTE_MODEL_SCOPE: AgentModelScope = {}

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

type OptimisticPrompt = {
  text: string
  priorTurnID: string | null
  attachments: AttachmentPart[]
}

type Props = {
  conversation: ConversationRuntime
  baseConfig: ServerConfig
  agents: MachineAgentHost[]
  onConversationUpdate: (conversation: ConversationRuntime) => void
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
  controller: ConversationController
  /** A background native recovery read must rehydrate the mounted transcript, not only runtime state. */
  transcriptRefreshToken?: number
  /** Backend mutations/catalog reads pause while the owning machine is reconnecting. */
  interactionEnabled?: boolean
  /** Surface a Session-scoped transport failure to the machine runtime immediately. */
  onConnectionIssue?: () => void
  routing?: {
    currentMachineID: string
    machines: NativeSessionRouteMachine[]
    onContinue: (input: NativeSessionRouteContinueInput) => Promise<void>
  }
}

function isTransportFailure(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason)
  return /cannot reach|timed out|network|connection|failed to fetch/i.test(message)
}

function assistantMessageHasSignal(message: WorkThreadMessage): boolean {
  if (message.info.role !== "assistant") return false
  // An error-only assistant envelope has no text/reasoning/tool part, but it is still meaningful
  // output and must remain visible. Only a truly empty neutral envelope is presentation noise while
  // the shared getting-started indicator owns the wait.
  if (message.info.error) return true
  return message.parts.some((part) => {
    if (part.type === "tool") return true
    if (part.type === "reasoning") return Boolean(part.text?.trim() || part.time?.start)
    return part.type === "text" && Boolean(part.text?.trim())
  })
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

function agentForTurn(conversation: ConversationRuntime, turn: ConversationTurn | null | undefined): string {
  return turn?.agentId || conversation.agentId
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

function isActive(conversation: ConversationRuntime): boolean {
  return conversation.status === "starting" || conversation.status === "running"
}

function modelKey(model?: ModelSelection | null): string {
  return model ? modelOptionKey(model as ModelOption) : ""
}

function lastModelForAgent(conversation: ConversationRuntime, agentID: string): ModelSelection | null {
  const turns = conversationTurns(conversation)
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (agentForTurn(conversation, turn) !== agentID || !turn.model) continue
    return turn.model
  }
  return conversation.agentId === agentID ? conversation.model ?? null : null
}

function sessionTargets(conversation: ConversationRuntime, baseConfig: ServerConfig, agents: MachineAgentHost[]): SessionTarget[] {
  const bySession = new Map<string, SessionTarget>()
  for (const turn of conversationTurns(conversation)) {
    const session = conversationTurnSessionID(turn)
    if (!session || bySession.has(session)) continue
    const agentID = agentForTurn(conversation, turn)
    bySession.set(session, {
      sessionID: session,
      agentID,
      directory: turn.directory || conversation.directory,
      config: configForAgent(baseConfig, agents, agentID)
    })
  }
  return [...bySession.values()]
}

function runtimeSignature(conversation: ConversationRuntime): string {
  const turns = conversationTurns(conversation).map((turn) => [
    turn.id || "",
    turn.sequence || 0,
    turn.agentId || "",
    conversationTurnSessionID(turn) || "",
    turn.status || "",
    turn.prompt || "",
    turn.outcome || "",
    typeof turn.error === "object" ? turn.error?.message || "" : String(turn.error || ""),
    turn.startedAt || "",
    turn.finishedAt || ""
  ])
  return JSON.stringify([
    conversation.id,
    conversation.status,
    conversation.error?.message || "",
    conversation.finishedAt || "",
    turns
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
      // No running turn means no clock. Keeping a 1s interval alive here woke the whole conversation
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

const WorkThreadBubble = memo(function WorkThreadBubble({
  message,
  activity
}: {
  message: WorkThreadMessage
  activity?: string
}) {
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
  conversation,
  baseConfig,
  agents,
  onConversationUpdate,
  onAttentionChange,
  commands = [],
  modelScope,
  deferModelFallback = false,
  controller,
  transcriptRefreshToken = 0,
  interactionEnabled = true,
  onConnectionIssue,
  routing
}: Props) {
  const draftStorageKey = `${DRAFT_STORAGE_PREFIX}${conversation.id}`
  const initialAgentID = agentForTurn(conversation, conversation.currentTurn)
  const initialModelKey = modelKey(lastModelForAgent(conversation, initialAgentID))
  const [feeds, setFeeds] = useState<Record<string, SessionFeed>>({})
  const feedsRef = useRef<Record<string, SessionFeed>>({})
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [draft, setDraft] = useState(() => localStorage.getItem(draftStorageKey) || "")
  const [attachments, setAttachments] = useState<AttachmentPart[]>([])
  const [sending, setSending] = useState(false)
  // Explicit presentation phase for the reply that has been requested but has not produced any
  // meaningful assistant activity yet. Do not derive this only from transport/runtime state:
  // OpenCode can acknowledge quickly and publish an empty assistant envelope before React commits
  // the transient `sending` frame. The user must still see the same pending row as every harness.
  const [replyPending, setReplyPending] = useState(false)
  // The prompt that has been sent but is not yet in the transcript, with the turn that was current
  // when it was sent. See `visibleTimeline`.
  const [pendingPrompt, setPendingPrompt] = useState<OptimisticPrompt | null>(null)
  const [uncertainDelivery, setUncertainDelivery] = useState<OptimisticPrompt | null>(null)
  // A prompt can be accepted before the final native assistant envelope is readable. Keep the exact
  // accepted turn in a short settle state so an early idle edge or a missed mobile SSE event cannot
  // make the mounted Session stop reconciling before its reply is actually visible.
  const [awaitingReplyTurnID, setAwaitingReplyTurnID] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [questions, setQuestions] = useState<QuestionRequest[]>([])
  const [permissions, setPermissions] = useState<PermissionRequest[]>([])
  const [targetAgentID, setTargetAgentID] = useState(initialAgentID)
  const [targetMachineID, setTargetMachineID] = useState(routing?.currentMachineID || "")
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
  const observedConversationModelKeyRef = useRef(initialModelKey)
  const modelSelectionTouchedRef = useRef(false)
  const sendInFlightRef = useRef(false)
  const stopInFlightRef = useRef(false)
  const tailRefreshRef = useRef(createCoalescedTailRefresh())
  const attentionInFlightRef = useRef(false)
  const reconcileInFlightRef = useRef(false)
  const conversationRef = useRef(conversation)
  const agentsRef = useRef(agents)
  const onConversationUpdateRef = useRef(onConversationUpdate)
  const onAttentionChangeRef = useRef(onAttentionChange)
  const onConnectionIssueRef = useRef(onConnectionIssue)
  const priorInteractionEnabledRef = useRef(interactionEnabled)
  const uncertainDeliveryRef = useRef(uncertainDelivery)

  conversationRef.current = conversation
  agentsRef.current = agents
  onConversationUpdateRef.current = onConversationUpdate
  onAttentionChangeRef.current = onAttentionChange
  onConnectionIssueRef.current = onConnectionIssue
  uncertainDeliveryRef.current = uncertainDelivery

  const targets = useMemo(() => sessionTargets(conversation, baseConfig, agents), [conversation.id, conversation.turns, conversation.currentTurn, conversation.directory, baseConfig, agents])
  const targetSignature = targets.map((target) => `${target.sessionID}:${target.agentID}:${target.directory}`).join("|")
  const agentsSignature = agents.map((agent) => `${agent.id}:${agent.label}:${agent.backend}`).join("|")
  const agentsByID = useMemo(() => agentMap(agents), [agentsSignature])
  const currentAgentID = agentForTurn(conversation, conversation.currentTurn)
  const currentConversationModelKey = modelKey(lastModelForAgent(conversation, currentAgentID))
  const currentAgent = agents.find((agent) => agent.id === currentAgentID)
  const currentSessionID = conversationTurnSessionID(conversation.currentTurn)
  const currentTarget = currentSessionID ? targets.find((target) => target.sessionID === currentSessionID) : undefined
  const selectedRouteMachine = routing?.machines.find((machine) => machine.machineID === targetMachineID)
  const destinationAgents = routing ? (selectedRouteMachine?.agents || []) : agents
  const destinationConfig = selectedRouteMachine?.config || baseConfig
  const routeChanged = Boolean(routing && targetAgentID !== currentAgentID)
  const routeAgentLabel = agentLabel(destinationAgents, targetAgentID)
  const routingSignature = routing
    ? routing.machines.map((machine) => `${machine.machineID}:${machine.agents.map((agent) => `${agent.id}:${agent.backend}`).join(",")}`).join("|")
    : ""
  const working = isActive(conversation)
  // A truly empty native Session has no persisted model to protect yet. In that one state, and for
  // a routed handoff that will create a fresh Session, a verified catalog default is safer than a
  // synthetic "Harness default" choice that some adapters cannot actually execute.
  const conversationHasUserPrompt = Boolean(conversation.initialPrompt?.trim())
    || conversationTurns(conversation).some((turn) => Boolean(turn.prompt?.trim()))
  // JSON.stringify over every turn is far too expensive to repeat on each keystroke. The conversation object
  // identity only changes when the workspace actually reloads or updates the conversation.
  const conversationSignature = useMemo(() => runtimeSignature(conversation), [conversation])

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
    setTranscriptError(null)
    setModelError(null)
    setQuestions([])
    setPermissions([])
    setAttachments([])
    setPendingPrompt(null)
    setAwaitingReplyTurnID(null)
    setReplyPending(false)
    setTargetMachineID(routing?.currentMachineID || "")
    setTargetAgentID(currentAgentID)
    setTargetModelKey(currentConversationModelKey)
    observedConversationModelKeyRef.current = currentConversationModelKey
    modelSelectionTouchedRef.current = false
    sendInFlightRef.current = false
    stopInFlightRef.current = false
    attentionInFlightRef.current = false
    reconcileInFlightRef.current = false
  }, [conversation.id, routing?.currentMachineID])

  useEffect(() => {
    if (currentAgentID !== targetAgentIDRef.current && conversation.currentTurn?.id) {
      const nextModelKey = modelKey(conversation.currentTurn.model ?? lastModelForAgent(conversation, currentAgentID))
      setTargetAgentID(currentAgentID)
      setTargetModelKey(nextModelKey)
      observedConversationModelKeyRef.current = nextModelKey
      modelSelectionTouchedRef.current = false
    }
  }, [currentAgentID, conversation.currentTurn?.id])

  // Native Session enrichment is intentionally asynchronous so transcript rendering never waits for
  // model discovery. If the catalog wins that race it may temporarily choose its default. Follow a
  // later verified model from the Session runtime unless the user has already touched the picker;
  // this keeps the control on the Session's real last model without clobbering an explicit choice.
  useEffect(() => {
    const previous = observedConversationModelKeyRef.current
    observedConversationModelKeyRef.current = currentConversationModelKey
    if (!currentConversationModelKey || currentConversationModelKey === previous) return
    if (currentAgentID !== targetAgentIDRef.current || modelSelectionTouchedRef.current) return
    setTargetModelKey(currentConversationModelKey)
  }, [currentAgentID, currentConversationModelKey])

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
    if (!interactionEnabled) {
      if (Object.keys(feedsRef.current).length === 0) setLoading(true)
      return
    }
    setTranscriptError(null)
    if (Object.keys(feedsRef.current).length === 0) setLoading(true)
    let firstFailure: string | null = null
    void Promise.all(missing.map(async (target) => {
      try {
        const feed = await loadInitialTarget(target)
        if (cancelled || loadGeneration.current !== generation) return
        setFeeds((current) => current[target.sessionID] ? current : { ...current, [target.sessionID]: feed })
      } catch (reason) {
        if (isTransportFailure(reason)) onConnectionIssueRef.current?.()
        firstFailure ??= reason instanceof Error ? reason.message : String(reason)
        // Durable Session history can outlive a live transport. Persisted turn outcome/error is the safe
        // fallback; do not invent a transcript association when the Session cannot be read.
      }
    })).finally(() => {
      if (!cancelled && loadGeneration.current === generation) {
        setTranscriptError(firstFailure)
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [targetSignature, loadInitialTarget, interactionEnabled])

  const messagesBySession = useMemo(
    () => Object.fromEntries(Object.entries(feeds).map(([session, feed]) => [session, feed.messages])),
    [feeds]
  )
  const timeline = useMemo(
    () => buildConversationTimeline(conversation, messagesBySession, agentsByID),
    [conversationSignature, messagesBySession, agentsByID]
  )

  /**
   * What the user just sent, shown from the moment they send it.
   *
   * Sending used to clear the composer and then show nothing until the continuation came back with a
   * turn, at which point the message appeared - and appeared again, remounted, once that turn carried
   * a real id and the timeline's key for its row changed from the run's index to that id. On screen
   * that reads as the message flashing in, being removed and being redrawn. The optimistic row
   * closes the gap: same bubble, same place, keyed once. It stands down the moment the real row
   * exists - either because the text is in the transcript or because a new turn is in the Session runtime, which
   * is what that row is built from - so the two are never on screen together.
   */
  const settledPrompt = pendingPrompt
    && (Boolean(conversation.currentTurn?.id && conversation.currentTurn.id !== pendingPrompt.priorTurnID)
      || timeline.some((message) => message.info.role === "user"
        && message.parts.some((part) => part.type === "text" && part.text?.trim() === pendingPrompt.text)))

  const visibleTimeline = useMemo(() => {
    if (!pendingPrompt || settledPrompt) return timeline
    const id = `work-thread:${conversation.id}:pending-user`
    return [...timeline, {
      info: { id, role: "user", sessionID: `work-thread:${conversation.id}`, time: { created: Date.now() } },
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
  }, [timeline, pendingPrompt, settledPrompt, conversation.id])

  useEffect(() => {
    if (settledPrompt) setPendingPrompt(null)
  }, [settledPrompt])

  const uncertainDeliverySettled = Boolean(
    uncertainDelivery
    && conversation.currentTurn?.id
    && conversation.currentTurn.id !== uncertainDelivery.priorTurnID
    && conversation.currentTurn.prompt?.trim() === uncertainDelivery.text
  )
  const visibleDraft = uncertainDeliverySettled && draft.trim() === uncertainDelivery?.text ? "" : draft

  useEffect(() => {
    if (!uncertainDelivery || !uncertainDeliverySettled || !conversation.currentTurn?.id) return
    const recovered = uncertainDelivery

    // Transcript identity wins over the transport catch. On mobile the native tail may prove
    // acceptance before fetch surfaces its connection-reset error; deriving visibleDraft above keeps
    // that late catch from resurrecting an already-delivered prompt in the composer for one render.
    setUncertainDelivery(null)
    setAwaitingReplyTurnID(conversation.currentTurn.id)
    setError(null)
    setDraft((current) => {
      if (current.trim() !== recovered.text) return current
      persistDraft(draftStorageKey, "")
      return ""
    })
    setAttachments((current) => current === recovered.attachments ? [] : current)
  }, [uncertainDelivery, uncertainDeliverySettled, conversation.currentTurn?.id, draftStorageKey, persistDraft])

  // Once Send has been accepted, the awaited turn id is the only safe identity for reply state.
  // React can render one more frame with the previous conversation.currentTurn while the native
  // controller has already returned the new turn. Looking at that previous turn is especially bad for
  // OpenCode because it normally has a completed assistant reply, which falsely ends the pending UI.
  const replyTurnID = awaitingReplyTurnID || conversation.currentTurn?.id || null
  const currentTurnHasAssistantSignal = useMemo(() => {
    if (!replyTurnID) return false
    return timeline.some((message) =>
      message.taskdesk?.runId === replyTurnID && assistantMessageHasSignal(message)
    )
  }, [timeline, replyTurnID])

  const replySettling = Boolean(
    awaitingReplyTurnID
    && !currentTurnHasAssistantSignal
    && conversation.status !== "failed"
    && conversation.status !== "cancelled"
  )

  useEffect(() => {
    if (!replyPending) return
    if (
      (awaitingReplyTurnID && currentTurnHasAssistantSignal)
      || conversation.status === "failed"
      || conversation.status === "cancelled"
    ) {
      setReplyPending(false)
    }
  }, [replyPending, awaitingReplyTurnID, currentTurnHasAssistantSignal, conversation.status])

  useEffect(() => {
    if (!awaitingReplyTurnID) return
    if (
      currentTurnHasAssistantSignal
      || conversation.status === "failed"
      || conversation.status === "cancelled"
    ) {
      setAwaitingReplyTurnID(null)
      return
    }
    // Do not clear merely because conversation.currentTurn is temporarily the previous render. The
    // accepted turn id is durable local state and bridges that parent-update gap. A genuinely
    // long-running turn keeps reconciliation indefinitely; once idle, the bounded grace still
    // prevents a stale waiter from surviving forever.
    if (working) return
    const expected = awaitingReplyTurnID
    const timer = window.setTimeout(() => {
      setAwaitingReplyTurnID((current) => current === expected ? null : current)
      setReplyPending(false)
    }, REPLY_SETTLE_IDLE_GRACE_MS)
    return () => window.clearTimeout(timer)
  }, [awaitingReplyTurnID, conversation.status, currentTurnHasAssistantSignal, working])

  const hasMore = Object.values(feeds).some((feed) => feed.hasMore && feed.before)

  const refreshCurrentTail = useCallback(async (sourceConversation?: ConversationRuntime) => {
    const currentConversation = sourceConversation ?? conversationRef.current
    const turn = currentConversation.currentTurn
    const session = conversationTurnSessionID(turn)
    if (!session) return
    const currentAgents = agentsRef.current
    const agentID = agentForTurn(currentConversation, turn)
    const target: SessionTarget = {
      sessionID: session,
      agentID,
      directory: turn?.directory || currentConversation.directory,
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
      } catch (reason) {
        if (isTransportFailure(reason)) onConnectionIssueRef.current?.()
        // Live refresh is opportunistic. The existing transcript remains visible and the slow
        // reconciliation path will retry without clearing or replacing it.
      }
    })
  }, [baseConfig, controller])

  useEffect(() => {
    if (!interactionEnabled || !transcriptRefreshToken) return
    void refreshCurrentTail()
  }, [interactionEnabled, refreshCurrentTail, transcriptRefreshToken])

  const refreshAttention = useCallback(async (sourceConversation?: ConversationRuntime) => {
    if (attentionInFlightRef.current) return
    const currentConversation = sourceConversation ?? conversationRef.current
    const turn = currentConversation.currentTurn
    const session = conversationTurnSessionID(turn)
    if (!session) {
      setQuestions((current) => current.length ? [] : current)
      setPermissions((current) => current.length ? [] : current)
      return
    }
    const currentAgents = agentsRef.current
    const agentID = agentForTurn(currentConversation, turn)
    const config = configForAgent(baseConfig, currentAgents, agentID)
    const directory = turn?.directory || currentConversation.directory
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
    const prior = conversationRef.current
    // Transcript durability and lifecycle status are independent OpenCode streams. Start the
    // selected tail read before status enrichment so a stalled /session/status cannot hide a
    // response that is already persisted in /session/:id/message.
    const tailRefresh = refreshCurrentTail(prior)
    const attentionRefresh = refreshAttention(prior)
    try {
      const next = await controller.refreshConversation(baseConfig, prior.id)
      if (runtimeSignature(next) !== runtimeSignature(prior) || next.title !== prior.title) {
        onConversationUpdateRef.current(next)
        conversationRef.current = next
      }
    } catch (reason) {
      if (isTransportFailure(reason)) onConnectionIssueRef.current?.()
      // A transient reconcile failure must never clear a valid conversation.
    } finally {
      await Promise.allSettled([tailRefresh, attentionRefresh])
      reconcileInFlightRef.current = false
    }
  }, [baseConfig, controller, refreshCurrentTail, refreshAttention])

  useEffect(() => {
    if (!interactionEnabled) return
    void refreshAttention()
    const delay = replySettling ? REPLY_SETTLE_RECONCILE_MS : working ? ACTIVE_RECONCILE_MS : IDLE_RECONCILE_MS
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void reconcile()
    }, delay)
    return () => window.clearInterval(timer)
  }, [working, replySettling, reconcile, refreshAttention, interactionEnabled])

  useEffect(() => {
    const wasEnabled = priorInteractionEnabledRef.current
    priorInteractionEnabledRef.current = interactionEnabled
    if (!wasEnabled && interactionEnabled) {
      if (!uncertainDeliveryRef.current) setError(null)
      void reconcile()
    }
  }, [interactionEnabled, reconcile])

  useEffect(() => {
    if (!currentTarget) return
    const currentAgents = agentsRef.current
    const profile: SavedServerProfile = {
      id: `thread:${conversation.id}:${currentTarget.agentID}`,
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
    // These scalar values identify the native stream. Do not depend on the changing conversation object or
    // callback identities: doing so reopened the OpenCode stream on every reconcile tick.
  }, [conversation.id, currentTarget?.sessionID, currentTarget?.agentID, currentTarget?.directory, refreshCurrentTail, reconcile, refreshAttention])

  useEffect(() => {
    const current = ++modelGeneration.current
    if (!interactionEnabled) {
      // Do not let a catalog from the last healthy connection make the first reconnect render look
      // writable. Preserve the selected key as preference only; membership is re-verified before the
      // composer is enabled again.
      setModels([])
      setModelsLoading(false)
      setModelError(null)
      return
    }
    if (!targetAgentID || (routing && !selectedRouteMachine)) {
      setModels([])
      setTargetModelKey("")
      setModelError(null)
      return
    }
    setModels([])
    setModelsLoading(true)
    setModelError(null)
    // Native and routed pickers both use the selected harness's current catalog. Historical Session
    // state remains timeline/runtime metadata and cannot reintroduce removed selectable models.
    const scope = routing ? NATIVE_ROUTE_MODEL_SCOPE : (modelScope ?? {})
    const catalogConfig = configForAgent(destinationConfig, destinationAgents, targetAgentID)
    void taskClient.listAgentModels(catalogConfig, targetAgentID, scope).then((catalog) => {
      if (modelGeneration.current !== current) return
      setModels(catalog.models)
      const prior = !routing || targetMachineID === routing.currentMachineID
        ? lastModelForAgent(conversationRef.current, targetAgentID)
        : null
      const priorKey = modelKey(prior)
      const latestConversation = conversationRef.current
      const latestHasUserPrompt = Boolean(latestConversation.initialPrompt?.trim())
        || conversationTurns(latestConversation).some((turn) => Boolean(turn.prompt?.trim()))
      const mayUseCatalogDefault = !deferModelFallback || routeChanged || !latestHasUserPrompt
      const fallback = mayUseCatalogDefault
        ? catalog.models.find((model) => model.isDefault) || catalog.models[0]
        : undefined
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
        if (isTransportFailure(reason)) onConnectionIssueRef.current?.()
      }
    }).finally(() => {
      if (modelGeneration.current === current) setModelsLoading(false)
    })
  }, [targetAgentID, targetMachineID, conversation.id, conversation.directory, destinationConfig, modelScopeKey, deferModelFallback, routingSignature, interactionEnabled])

  // Transcript discovery can prove that a Session is not new after the catalog has already returned.
  // Do not re-read the catalog just for that transition: drop only the untouched provisional default
  // and leave explicit user choices and verified native model metadata alone.
  useEffect(() => {
    if (!deferModelFallback || routeChanged || !conversationHasUserPrompt || currentConversationModelKey) return
    if (modelSelectionTouchedRef.current) return
    setTargetModelKey("")
  }, [deferModelFallback, routeChanged, conversationHasUserPrompt, currentConversationModelKey])

  // Only a model verified by the current live catalog is sent explicitly. A null selection is
  // intentional: the controller distinguishes it from an omitted field, which means reuse the
  // previous turn's model. Null therefore asks the harness for its current native default and cannot
  // resurrect a persisted provider model that has since been removed.
  const selectedModel = models.find((model) => modelKey(model) === targetModelKey)
  const selectedModelAgent = destinationAgents.find((agent) => agent.id === targetAgentID)
  const modelSelectionRequired = selectedModelAgent?.capabilities?.models === true
  // Existing native Sessions are allowed to keep their harness-owned current model when that exact
  // value cannot be reconstructed. What is not allowed is sending before the live catalog itself has
  // finished loading: a brand-new Codex/PI Session has no safe implicit model at that point.
  const modelCatalogReady = !modelSelectionRequired || (!modelsLoading && models.length > 0)
  const modelBootstrapBlocked = modelSelectionRequired && !modelCatalogReady

  async function loadOlder() {
    if (loadingOlder || !interactionEnabled) return
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
    if (
      (!text && !promptAttachments.length)
      || sending
      || working
      || replySettling
      || sendInFlightRef.current
      || !interactionEnabled
      || modelBootstrapBlocked
    ) return
    sendInFlightRef.current = true
    setSending(true)
    setReplyPending(true)
    setError(null)
    setDraft("")
    const optimisticPrompt: OptimisticPrompt = {
      text,
      priorTurnID: conversationRef.current.currentTurn?.id ?? null,
      attachments: promptAttachments
    }
    setPendingPrompt(optimisticPrompt)
    setUncertainDelivery(null)
    try {
      const latest = await controller.refreshConversation(baseConfig, conversation.id)
      if (isActive(latest)) {
        onConversationUpdateRef.current(latest)
        throw new Error(`${agentLabel(agentsRef.current, agentForTurn(latest, latest.currentTurn))} is still working. Stop it or wait for the reply before sending another message.`)
      }
      const selectedModelValue = selectedModel
        ? { providerID: selectedModel.providerID, modelID: selectedModel.modelID, variant: selectedModel.variant }
        : null
      if (routeChanged && routing) {
        if (slashCommand) throw new Error("Slash commands stay scoped to the open Session. Send a normal prompt to continue on another harness.")
        await routing.onContinue({
          machineID: targetMachineID,
          agentID: targetAgentID,
          prompt: text,
          attachments: promptAttachments,
          model: selectedModelValue
        })
        localStorage.removeItem(draftStorageKey)
        setAttachments([])
        setPendingPrompt(null)
        setReplyPending(false)
        modelSelectionTouchedRef.current = false
      } else {
        const next = await controller.continueConversation(baseConfig, conversation.id, {
          prompt: text,
          attachments: promptAttachments,
          command: slashCommand,
          agentId: targetAgentID,
          model: selectedModelValue
        })
        localStorage.removeItem(draftStorageKey)
        setAttachments([])
        onConversationUpdateRef.current(next)
        conversationRef.current = next
        setAwaitingReplyTurnID(next.currentTurn?.id ?? null)
        modelSelectionTouchedRef.current = false
        await refreshCurrentTail(next)
        void refreshAttention(next)
      }
    } catch (reason) {
      const transportFailure = isTransportFailure(reason)
      if (transportFailure) {
        onConnectionIssueRef.current?.()
        setUncertainDelivery(optimisticPrompt)
      } else {
        setUncertainDelivery(null)
      }
      // The prompt goes back to the composer, so it must also stop standing in for a turn that was
      // never accepted. If transport made acceptance ambiguous, the transcript reconciliation above
      // clears this restored draft only after the exact native turn becomes authoritative.
      setPendingPrompt(null)
      setReplyPending(false)
      setDraft((current) => text ? (current ? `${text}\n${current}` : text) : current)
      setAttachments(promptAttachments)
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      sendInFlightRef.current = false
      setSending(false)
    }
  }

  async function stop() {
    if (stopping || !working || stopInFlightRef.current || !interactionEnabled) return
    stopInFlightRef.current = true
    setStopping(true)
    setReplyPending(false)
    setError(null)
    try {
      const next = await controller.stopConversation(baseConfig, conversation.id)
      onConversationUpdateRef.current(next)
      conversationRef.current = next
      await Promise.all([refreshCurrentTail(next), refreshAttention(next)])
    } catch (reason) {
      if (isTransportFailure(reason)) onConnectionIssueRef.current?.()
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      stopInFlightRef.current = false
      setStopping(false)
    }
  }

  const currentLabel = agentLabel(agents, currentAgentID)
  const attachmentAgent = destinationAgents.find((agent) => agent.id === targetAgentID)
  const attachmentsSupported = !routeChanged && attachmentAgent?.capabilities?.attachments === true
  const routeBlockedByAttachments = routeChanged && attachments.length > 0
  const hasAttention = questions.length > 0 || permissions.length > 0
  const preparingReply = replyPending || sending || ((working || replySettling) && !currentTurnHasAssistantSignal)
  const pendingAgentLabel = (replyPending || sending) ? agentLabel(destinationAgents, targetAgentID) : currentLabel
  // The pending bubble is the reply that is coming, so it wears the identity of the agent that is
  // about to answer rather than the one that answered last.
  const pendingAgentBackend = ((replyPending || sending) ? destinationAgents.find((agent) => agent.id === targetAgentID) : currentAgent)?.backend
  // Preparation is rendered by the exact same generic pending bubble for every harness. OpenCode can
  // publish an empty assistant envelope early, but that transport detail must not replace the shared
  // waiting UX. The real assistant bubble takes over only once it contains reasoning/text/tool activity.
  const liveTurnID = (working || replySettling) && !hasAttention && currentTurnHasAssistantSignal
    ? replyTurnID || undefined
    : undefined
  const presentedTimeline = useMemo(() => {
    const turnID = replyTurnID
    if (!preparingReply || !turnID) return visibleTimeline
    return visibleTimeline.filter((message) =>
      !(message.info.role === "assistant"
        && message.taskdesk?.runId === turnID
        && !assistantMessageHasSignal(message))
    )
  }, [visibleTimeline, preparingReply, replyTurnID])

  const waitingLabel = hasAttention
    ? "Waiting for your input"
    : preparingReply
      ? `${pendingAgentLabel} is getting started`
      : `${currentLabel} is working`
  const conversationStateLabel = modelBootstrapBlocked
    ? modelsLoading ? "Loading models" : "Waiting for model catalog"
    : waitingLabel

  /**
   * Exactly one row, on exactly one bubble.
   *
   * A turn id is on every row the turn produced, the synthetic user message included, so matching on
   * the id alone put the status row inside the user's own bubble as well as the reply's. The status
   * of a turn belongs to the reply, so the role is part of the match - and `liveTurnID` is already
   * mutually exclusive with the pending bubble, which is the only other place this row can appear.
   */
  const activityForMessage = (message: WorkThreadMessage): string | undefined =>
    liveTurnID && message.info.role === "assistant" && message.taskdesk?.runId === liveTurnID
      ? waitingLabel
      : undefined

  useEffect(() => {
    onAttentionChangeRef.current?.(hasAttention)
  }, [hasAttention])

  return (
    <div className="tdw-work-thread-conversation">
      <div className="tdw-conversation-toolbar">
        <div className={`tdw-agent-control${routing ? " routed" : ""}`}>
          <label>
            <span>{routing ? "Harness" : "Continue with"}</span>
            <select value={targetAgentID} disabled={!interactionEnabled || working || replyPending || sending || modelBootstrapBlocked || destinationAgents.length === 0} onChange={(event) => {
              modelGeneration.current += 1
              modelSelectionTouchedRef.current = false
              setModels([])
              setModelError(null)
              setTargetModelKey("")
              setTargetAgentID(event.target.value)
            }}>
              {destinationAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.label}</option>)}
            </select>
          </label>
          <label className="tdw-model-control">
            <span>Model</span>
            <ModelPicker compact models={models} value={targetModelKey} onChange={(value) => {
              modelSelectionTouchedRef.current = true
              setTargetModelKey(value)
            }} disabled={!interactionEnabled || working || replyPending || sending || modelsLoading || !targetAgentID} loading={modelsLoading} placeholder={modelBootstrapBlocked ? (modelError ? "Model unavailable" : "Loading models…") : deferModelFallback ? "Harness default" : undefined} unavailableHint={modelError || undefined} />
            {modelError ? <small className="tdw-field-note" title={modelError}>Model catalog unavailable. Sending is paused until a model can be verified.</small> : null}
          </label>
        </div>
        <ConversationStatePill working={working || replyPending || sending || replySettling || modelBootstrapBlocked} attention={hasAttention} workingLabel={conversationStateLabel} startedAt={sending ? undefined : conversation.currentTurn?.startedAt} status={conversation.status} detail={conversation.error?.message || undefined} />
      </div>

      {routeChanged ? (
        <div className={`tdw-route-preview${sending ? " active" : ""}`} role="status" aria-live="polite">
          <span>{sending ? "Creating linked Session…" : "Next message will continue in"}</span>
          <strong>{routeAgentLabel}</strong>
          <small>{routeBlockedByAttachments
            ? "Remove the attached images before continuing on another harness."
            : sending
              ? "A new native Session on this machine is linked before this prompt is delivered."
              : "The current Session stays here. Nothing changes until you send."}</small>
        </div>
      ) : null}

      {!interactionEnabled ? (
        <div className="tdw-connection-notice" role="status" aria-live="polite">
          Reconnecting to machine… The Session stays open and controls resume automatically.
        </div>
      ) : null}

      <WorkThreadAttention
        config={currentTarget?.config || configForAgent(baseConfig, agents, currentAgentID)}
        directory={currentTarget?.directory || conversation.directory}
        questions={questions}
        permissions={permissions}
        onResolved={async () => { await refreshAttention(); await reconcile() }}
      />

      {error ? <div className="tdw-chat-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>×</button></div> : null}

      <TaskDeskConversation
        messages={presentedTimeline}
        agentLabel={pendingAgentLabel}
        agentBackend={pendingAgentBackend}
        loading={loading}
        ready={!loading}
        waiting={working || replySettling}
        workingLabel={waitingLabel}
        showWaitingIndicator={false}
        hasMore={hasMore}
        loadingOlder={loadingOlder}
        onLoadOlder={loadOlder}
        draft={visibleDraft}
        onDraftChange={setDraft}
        commands={commands}
        attachments={attachments}
        attachmentsSupported={attachmentsSupported}
        onAttachmentsChange={setAttachments}
        onAttachmentError={setError}
        onSend={send}
        sending={preparingReply}
        sendDisabled={!interactionEnabled || working || replySettling || hasAttention || routeBlockedByAttachments || modelBootstrapBlocked}
        composerDisabled={!interactionEnabled || modelBootstrapBlocked}
        onStop={working && interactionEnabled ? stop : undefined}
        stopping={stopping}
        placeholder={`Message ${agentLabel(destinationAgents, targetAgentID)}…`}
        emptyText="Start the conversation. You can continue with another coding agent at any time."
        transcriptError={transcriptError || undefined}
        footerHint={hasAttention
          ? "Your input is required before the agent can continue"
          : modelBootstrapBlocked
            ? modelsLoading ? "Loading available models…" : "A verified model is required before sending"
            : working
              ? "The agent is working on your last message"
              : replySettling
                ? "Waiting for the completed reply to become available…"
                : undefined}
        renderMessage={(message) => {
          const activity = activityForMessage(message as WorkThreadMessage)
          return (
            <WorkThreadBubble
              key={message.info.id}
              message={message as WorkThreadMessage}
              activity={activity}
            />
          )
        }}
      />
    </div>
  )
}
