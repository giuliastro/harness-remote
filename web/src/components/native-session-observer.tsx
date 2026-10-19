import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { api } from "../api"
import { isMachineTransportFailure } from "../machine-request-error"
import type { ConversationController } from "../conversation-controller"
import type { NativeSessionSurfaceTarget } from "../native-session-discovery"
import { canCreateNativeSession } from "../native-session-create"
import { resolveNativeSessionTargetModel } from "../native-session-model"
import { openCodeAssistantProvesTurnCompleted } from "../native-session-opencode-reconciliation"
import { routeCurrentNativeSessionAgents } from "../native-session-route-capabilities"
import {
  continueNativeSessionOnRoute,
  type NativeSessionRouteContinueInput,
  type NativeSessionRouteMachine
} from "../native-session-routing"
import {
  applyDiscoveredNativeSessionModel,
  nativeSessionIsWorking,
  registerNativeSessionV3Adapter
} from "../native-session-v3-adapter"
import type { ConversationRuntime, ConversationTurn } from "../conversation-runtime"
import {
  clearSessionIndexLiveError,
  clearSessionIndexLiveState,
  liveSessionIndexError,
  liveSessionIndexStatus,
  sessionIndexInvalidationRevision,
  subscribeSessionIndexInvalidation
} from "../session-index-live-state"
import type { AgentModelScope } from "../taskClient"
import type { CommandInfo, MachineAgentHost, MessageEnvelope } from "../types"
import { LoadingIcon } from "../Icons"
import { CrossMachineContinuePanel } from "./cross-machine-continue-panel"
import { NativeSessionLineagePanel } from "./native-session-lineage-panel"
import { NativeSessionOutcomePanel } from "./native-session-outcome-panel"
import { WorkThreadConversation } from "./work-thread-conversation"
import "../native-session-observer.css"

type Props = {
  target: NativeSessionSurfaceTarget
  routes?: NativeSessionRouteMachine[]
  onOpenSession?: (target: NativeSessionSurfaceTarget) => void
  onSessionRefresh?: () => void
  onStateChange?: (state: NativeSessionVisualState) => void
  /** False while the owning machine is still bootstrapping or is in reconnect grace. Reads remain visible. */
  interactionEnabled?: boolean
  /** A Session-scoped request discovered a transport outage before the machine poll did. */
  onConnectionIssue?: () => void
  /** Bumped whenever the user explicitly opens this Session surface; retires the "getting started" label. */
  surfaceViewRevision?: number
}
export type NativeSessionVisualState = "working" | "attention" | "stopped" | "ready"

function visualState(conversation: ConversationRuntime, attention = false): NativeSessionVisualState {
  if (attention || conversation.status === "failed") return "attention"
  if (conversation.status === "cancelled") return "stopped"
  if (nativeSessionIsWorking(conversation.status)) return "working"
  return "ready"
}

export { nativeSessionIsWorking }

function replaceCurrentTurn(
  conversation: ConversationRuntime,
  update: (turn: ConversationTurn) => ConversationTurn
): { currentTurn: ConversationTurn | null; turns: ConversationTurn[] } {
  const current = conversation.currentTurn
  if (!current) return { currentTurn: null, turns: conversation.turns }
  const next = update(current)
  return {
    currentTurn: next,
    turns: conversation.turns.map((turn) => turn.id && current.id && turn.id === current.id ? next : turn)
  }
}

/**
 * Live OpenCode lifecycle is the fastest authority for retry/error presentation. It is intentionally
 * an overlay rather than controller state: the durable transcript still owns final answer history,
 * while a later busy/retry edge can retract a terminal-looking provider failure immediately.
 */
function withOpenCodeLiveLifecycle(
  conversation: ConversationRuntime,
  status: { type: string; message?: string } | undefined,
  errorMessage: string | undefined
): ConversationRuntime {
  if (errorMessage) {
    const error = { message: errorMessage }
    const turns = replaceCurrentTurn(conversation, (turn) => ({ ...turn, status: "failed", error }))
    return {
      ...conversation,
      ...turns,
      status: "failed",
      activityDetail: null,
      error
    }
  }

  if (status?.type === "busy" || status?.type === "retry") {
    const turns = replaceCurrentTurn(conversation, (turn) => ({
      ...turn,
      status: "running",
      error: null,
      finishedAt: undefined
    }))
    return {
      ...conversation,
      ...turns,
      status: "running",
      activityDetail: status.type === "retry" ? status.message?.trim() || "OpenCode is retrying the provider request." : null,
      error: null,
      finishedAt: null
    }
  }

  return conversation.activityDetail ? { ...conversation, activityDetail: null } : conversation
}

/** Durable success for the newest native user turn can retire an older live session.error bridge. */
function latestOpenCodeTurnHasDurableCompletion(messages: MessageEnvelope[]): boolean {
  let latestUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].info.role === "user") {
      latestUserIndex = index
      break
    }
  }
  if (latestUserIndex < 0) return false

  let latestAssistant: MessageEnvelope | null = null
  for (let index = latestUserIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.info.role === "user") break
    if (message.info.role === "assistant") latestAssistant = message
  }
  return Boolean(latestAssistant && openCodeAssistantProvesTurnCompleted(latestAssistant))
}

/**
 * The daemon owns one current model catalog per machine + harness. A historical native Session may
 * contribute its current/per-turn model to the timeline, but never widens selectable membership.
 */
const NATIVE_SESSION_MODEL_SCOPE: AgentModelScope = {}

// The same breakpoint the stylesheets use for the phone layout, where every row keeps its own line.
const COMPACT_LAYOUT_QUERY = "(max-width: 780px), (pointer: coarse) and (min-width: 600px) and (max-height: 640px)"

function subscribeCompactLayout(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {}
  const media = window.matchMedia(COMPACT_LAYOUT_QUERY)
  media.addEventListener("change", onChange)
  return () => media.removeEventListener("change", onChange)
}

function compactLayoutMatches(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.(COMPACT_LAYOUT_QUERY).matches === true
}

function targetForInitialRuntime(target: NativeSessionSurfaceTarget): NativeSessionSurfaceTarget {
  // OpenCode's Session list model is provider/default metadata rather than reliable per-turn truth,
  // and Codex's list can likewise expose the adapter default while the rollout carries the model
  // actually used by the latest turn. Treat those list values as provisional: mount immediately
  // without them, then let native message/rollout metadata refine the already-visible controller.
  // OMP/PI branch metadata and Claude ACP config are already authoritative on their normal paths.
  return target.backend === "opencode" || target.backend === "codex"
    ? { ...target, model: null }
    : target
}

/**
 * Thin Session-first adapter around the mature HR3 conversation controller.
 *
 * Opening a Session is always a read operation. The exact v3 WorkThreadConversation therefore owns
 * transcript paging and rendering immediately, even when an ACP writer has not been acquired yet.
 * Writer acquisition is deferred to the first mutation by native-session-v3-adapter, so the user
 * never has to unlock the transcript with an extra Continue step. Nothing is persisted as a Task or Run.
 */
export function NativeSessionObserver({
  target,
  routes = [],
  onOpenSession,
  onSessionRefresh,
  onStateChange,
  interactionEnabled = true,
  onConnectionIssue,
  surfaceViewRevision = 0
}: Props) {
  const [conversation, setConversation] = useState<ConversationRuntime | null>(null)
  const [controller, setController] = useState<ConversationController | null>(null)
  const [transcriptRefreshToken, setTranscriptRefreshToken] = useState(0)
  const [attachmentsSupported, setAttachmentsSupported] = useState(false)
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const durableLifecycleRef = useRef<{ targetKey: string; status: string } | null>(null)
  const [attention, setAttention] = useState(false)
  const onStateChangeRef = useRef(onStateChange)
  onStateChangeRef.current = onStateChange
  const compactLayout = useSyncExternalStore(subscribeCompactLayout, compactLayoutMatches, () => false)

  const lifecycleRevision = useSyncExternalStore(
    subscribeSessionIndexInvalidation,
    sessionIndexInvalidationRevision,
    sessionIndexInvalidationRevision
  )
  const liveStatus = useMemo(
    () => target.backend === "opencode" ? liveSessionIndexStatus(target.config, target.sessionID) : undefined,
    [target.backend, target.config, target.sessionID, lifecycleRevision]
  )
  const liveError = useMemo(
    () => target.backend === "opencode" ? liveSessionIndexError(target.config, target.sessionID) : undefined,
    [target.backend, target.config, target.sessionID, lifecycleRevision]
  )
  const presentedConversation = useMemo(
    () => conversation && target.backend === "opencode"
      ? withOpenCodeLiveLifecycle(conversation, liveStatus, liveError)
      : conversation,
    [conversation, target.backend, liveStatus, liveError]
  )

  const handleConversationUpdate = useCallback((next: ConversationRuntime) => {
    setConversation(next)
  }, [])

  const handleAttentionChange = useCallback((attention: boolean) => {
    setAttention(attention)
  }, [])

  const handleTranscriptRefresh = useCallback(() => {
    setTranscriptRefreshToken((current) => current + 1)
  }, [])

  useEffect(() => {
    // Publish the same lifecycle-aware state that the conversation renders. Raw controller updates
    // can still be idle while a newer streamed busy/retry edge is keeping this Session working.
    if (presentedConversation) onStateChangeRef.current?.(visualState(presentedConversation, attention))
  }, [presentedConversation, attention])

  useEffect(() => {
    if (!conversation) return
    const previous = durableLifecycleRef.current
    durableLifecycleRef.current = { targetKey: target.key, status: conversation.status }
    if (target.backend !== "opencode" || !previous || previous.targetKey !== target.key) return

    const wasWorking = nativeSessionIsWorking(previous.status)
    const isWorking = nativeSessionIsWorking(conversation.status)
    if (!wasWorking && isWorking) {
      // A newly accepted native turn belongs to the new request. A terminal-looking event cached for
      // the previous turn must not poison this turn before OpenCode publishes its next busy edge.
      clearSessionIndexLiveError(target.config, target.sessionID)
      return
    }
    if (wasWorking && !isWorking) {
      // The Session-scoped controller has now reconciled durable terminal state from transcript/status.
      // Retire the short-lived event bridge so an earlier busy/retry/error cannot keep the mounted UI
      // on Working/Attention after the authoritative reply is already visible.
      clearSessionIndexLiveState(target.config, target.sessionID)
    }
  }, [conversation, target.key, target.backend, target.config, target.sessionID])

  useEffect(() => {
    if (target.backend !== "opencode" || !liveError || !interactionEnabled) return
    let disposed = false
    // A Session can finish while another Session is selected and the final lifecycle edge can be lost.
    // On remount, verify the durable tail once before trusting the older live error indefinitely. This
    // is error-only recovery, not polling: ordinary idle/pre-Send OpenCode still performs no status or
    // transcript probe here. A terminal assistant error does not satisfy the completion predicate.
    void api.loadMessagePage(target.config, target.sessionID, target.directory, undefined, 80, true)
      .then((page) => {
        if (!disposed && latestOpenCodeTurnHasDurableCompletion(page.messages)) {
          clearSessionIndexLiveState(target.config, target.sessionID)
        }
      })
      .catch((reason) => {
        if (!disposed && isMachineTransportFailure(reason)) {
          onConnectionIssue?.()
        }
      })
    return () => { disposed = true }
  }, [
    target.key,
    target.backend,
    target.sessionID,
    target.directory,
    target.config.host,
    target.config.port,
    target.config.username,
    target.config.password,
    target.config.agentId,
    liveError,
    interactionEnabled,
    onConnectionIssue
  ])

  useEffect(() => {
    if (!interactionEnabled) return
    let disposed = false
    setAttachmentsSupported(false)
    setCommands([])
    void api.capabilities(target.config)
      .then(async (capabilities) => {
        if (disposed) return
        setAttachmentsSupported(capabilities.attachments === true)
        if (target.commandsSupported === true || capabilities.commands === true) {
          try {
            const available = await api.listCommands(target.config, target.sessionID)
            if (!disposed) setCommands(available)
          } catch {
            if (!disposed) setCommands([])
          }
        }
      })
      .catch(() => {
        if (!disposed) {
          setAttachmentsSupported(false)
          setCommands([])
        }
      })
    return () => { disposed = true }
  }, [target.key, target.config.host, target.config.port, target.config.agentId, interactionEnabled])

  const agent = useMemo<MachineAgentHost>(() => ({
    id: target.agentID,
    label: target.agentLabel,
    backend: target.backend,
    transport: target.transport,
    managed: true,
    state: "available",
    capabilities: {
      sessions: true,
      prompt: true,
      abort: target.canStop,
      models: target.modelsSupported,
      attachments: attachmentsSupported,
      commands: commands.length > 0
    }
  }), [target.agentID, target.agentLabel, target.backend, target.transport, target.canStop, target.modelsSupported, attachmentsSupported, commands.length])

  const routableRoutes = useMemo<NativeSessionRouteMachine[]>(() => routes.flatMap((machine) => {
    const available = machine.agents.filter((candidate) => canCreateNativeSession(candidate))
    if (machine.machineID !== target.machineID) {
      return available.length ? [{ ...machine, agents: available }] : []
    }
    // The machine snapshot advertises `profile.capabilities`, a static table that cannot know
    // whether this harness accepts images: that answer only exists after the ACP handshake, which
    // is what `/v1/capabilities` reports and what `agent` above already carries. Taking `available`
    // verbatim dropped the one field the snapshot has no way to fill, so the composer read
    // `attachments: undefined` for an OMP that advertises `promptCapabilities.image` and hid the
    // picker on every harness.
    const current = routeCurrentNativeSessionAgents(available, target.agentID, agent, attachmentsSupported)
    return [{ ...machine, agents: current }]
  }), [routes, target.machineID, target.agentID, agent, attachmentsSupported])

  // Keep the mature composer scoped to same-machine harness switching. Cross-machine continuation
  // has a separate explicit panel until that newer state machine has enough product-smoke coverage
  // to be safely folded into the composer without destabilizing ordinary Session sends.
  const sameMachineRoutes = useMemo(
    () => routableRoutes.filter((machine) => machine.machineID === target.machineID),
    [routableRoutes, target.machineID]
  )
  const crossMachineRoutes = useMemo(
    () => routableRoutes.filter((machine) => machine.machineID !== target.machineID),
    [routableRoutes, target.machineID]
  )

  const handleRoutedContinue = useCallback(async (input: NativeSessionRouteContinueInput) => {
    if (!interactionEnabled) throw new Error("The machine is reconnecting. Continue will be available when the connection is healthy again.")
    const machine = sameMachineRoutes.find((candidate) => candidate.machineID === input.machineID)
    const targetAgent = machine?.agents.find((candidate) => candidate.id === input.agentID)
    if (!machine || !targetAgent) throw new Error("That harness is no longer available on this machine.")
    const next = await continueNativeSessionOnRoute({
      source: target,
      targetMachine: machine,
      targetAgent,
      prompt: input.prompt,
      attachments: input.attachments,
      model: input.model
    })
    onSessionRefresh?.()
    onOpenSession?.(next)
  }, [sameMachineRoutes, target, onSessionRefresh, onOpenSession, interactionEnabled])

  useEffect(() => {
    let registration: ReturnType<typeof registerNativeSessionV3Adapter> | undefined
    const initialTarget = targetForInitialRuntime(target)

    setConversation(null)
    setController(null)
    durableLifecycleRef.current = null
    setAttention(false)

    // Mount the mature controller on the Session itself, before any model enrichment. Gating the
    // whole transcript on a network read left this surface stuck on "Loading Session into the v3
    // controller..." whenever that read was slow, which is exactly what a busy daemon produces.
    registration = registerNativeSessionV3Adapter(initialTarget, handleConversationUpdate, handleTranscriptRefresh)
    setController(registration.controller)
    handleConversationUpdate(registration.conversation)

    return () => {
      registration?.dispose()
    }
  }, [target.key, handleConversationUpdate, handleTranscriptRefresh])

  useEffect(() => {
    if (!interactionEnabled) return
    let disposed = false
    const initialTarget = targetForInitialRuntime(target)
    // Recovering the last requested native model is enrichment. It refines the already usable
    // Session and must never be able to fail it. When a mobile machine is reconnecting this read is
    // deliberately paused; toggling interactionEnabled back to true resumes it automatically.
    void resolveNativeSessionTargetModel(target)
      .then((resolved) => {
        if (disposed || resolved.model === initialTarget.model) return
        applyDiscoveredNativeSessionModel(initialTarget, resolved.model)
      })
      .catch((reason) => {
        if (!disposed && isMachineTransportFailure(reason)) {
          onConnectionIssue?.()
        }
      })
    return () => { disposed = true }
  }, [target.key, interactionEnabled, onConnectionIssue])

  if (!presentedConversation || !controller) {
    return <div className="tdw-detail-loading"><LoadingIcon size={20} /> Loading Session into the v3 controller...</div>
  }

  // On a wide pane the outcome is a chip in the harness/model row, with its detail as a popover, so
  // it stops costing the transcript a full row. A phone keeps it as its own collapsible row.
  const outcomePanel = (
    <NativeSessionOutcomePanel
      target={target}
      conversation={presentedConversation}
      working={nativeSessionIsWorking(presentedConversation.status)}
      interactionEnabled={interactionEnabled}
      onConnectionIssue={onConnectionIssue}
      compact={!compactLayout}
    />
  )

  return (
    <div className="hr-native-session-observer writable">
      <NativeSessionLineagePanel
        target={target}
        routes={routableRoutes}
        interactionEnabled={interactionEnabled}
        onConnectionIssue={onConnectionIssue}
      />

      {compactLayout ? outcomePanel : null}

      {onOpenSession && crossMachineRoutes.length ? (
        <CrossMachineContinuePanel
          source={target}
          routes={crossMachineRoutes}
          interactionEnabled={interactionEnabled}
          onOpenSession={onOpenSession}
          onSessionRefresh={onSessionRefresh}
          onConnectionIssue={onConnectionIssue}
        />
      ) : null}

      {presentedConversation.activityDetail ? (
        <div className="tdw-connection-notice" role="status" aria-live="polite">
          <strong>OpenCode is retrying.</strong> {presentedConversation.activityDetail}
        </div>
      ) : null}

      <WorkThreadConversation
        key={target.key}
        conversation={presentedConversation}
        baseConfig={target.config}
        agents={[agent]}
        modelScope={NATIVE_SESSION_MODEL_SCOPE}
        deferModelFallback
        controller={controller}
        transcriptRefreshToken={transcriptRefreshToken}
        surfaceViewRevision={surfaceViewRevision}
        onConversationUpdate={handleConversationUpdate}
        onAttentionChange={handleAttentionChange}
        commands={commands}
        interactionEnabled={interactionEnabled}
        onConnectionIssue={onConnectionIssue}
        toolbarAccessory={compactLayout ? undefined : outcomePanel}
        routing={onOpenSession && sameMachineRoutes.length ? {
          currentMachineID: target.machineID,
          machines: sameMachineRoutes,
          onContinue: handleRoutedContinue
        } : undefined}
      />
    </div>
  )
}
