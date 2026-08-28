import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import type { ConversationController } from "../conversation-controller"
import type { NativeSessionSurfaceTarget } from "../native-session-discovery"
import { resolveNativeSessionTargetModel } from "../native-session-model"
import {
  applyDiscoveredNativeSessionModel,
  nativeSessionIsWorking,
  registerNativeSessionV3Adapter
} from "../native-session-v3-adapter"
import type { ConversationRuntime } from "../conversation-runtime"
import type { AgentModelScope } from "../taskClient"
import type { CommandInfo, MachineAgentHost } from "../types"
import { LoadingIcon } from "../Icons"
import { WorkThreadConversation } from "./work-thread-conversation"
import "../native-session-observer.css"

type Props = {
  target: NativeSessionSurfaceTarget
  onSessionRefresh?: () => void
  onStateChange?: (state: NativeSessionVisualState) => void
}
export type NativeSessionVisualState = "working" | "attention" | "stopped" | "ready"

function visualState(conversation: ConversationRuntime, attention = false): NativeSessionVisualState {
  if (attention || conversation.status === "failed") return "attention"
  if (conversation.status === "cancelled") return "stopped"
  if (nativeSessionIsWorking(conversation.status)) return "working"
  return "ready"
}


export { nativeSessionIsWorking }

/**
 * The daemon owns one model catalog per machine + harness, which is what its capability contract
 * reports as `cacheScope: "machine"`. A native Session therefore asks for exactly that catalog and
 * must not invent a Work Thread identity the daemon has never heard of. Keeping this constant module
 * scoped also keeps the object identity stable across renders.
 */
const NATIVE_SESSION_MODEL_SCOPE: AgentModelScope = {}

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
export function NativeSessionObserver({ target, onStateChange }: Props) {
  const [conversation, setConversation] = useState<ConversationRuntime | null>(null)
  const [controller, setController] = useState<ConversationController | null>(null)
  const [attachmentsSupported, setAttachmentsSupported] = useState(false)
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const conversationRef = useRef<ConversationRuntime | null>(null)
  const attentionRef = useRef(false)
  const onStateChangeRef = useRef(onStateChange)
  onStateChangeRef.current = onStateChange

  const handleConversationUpdate = useCallback((next: ConversationRuntime) => {
    conversationRef.current = next
    setConversation(next)
    onStateChangeRef.current?.(visualState(next, attentionRef.current))
  }, [])

  const handleAttentionChange = useCallback((attention: boolean) => {
    attentionRef.current = attention
    const current = conversationRef.current
    if (current) onStateChangeRef.current?.(visualState(current, attention))
  }, [])

  useEffect(() => {
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
  }, [target.key, target.config.host, target.config.port, target.config.agentId])

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

  useEffect(() => {
    let disposed = false
    let registration: ReturnType<typeof registerNativeSessionV3Adapter> | undefined
    const initialTarget = targetForInitialRuntime(target)

    setConversation(null)
    setController(null)
    conversationRef.current = null
    attentionRef.current = false

    // Mount the mature controller on the Session itself, before any model enrichment. Gating the
    // whole transcript on a network read left this surface stuck on "Loading Session into the v3
    // controller..." whenever that read was slow, which is exactly what a busy daemon produces.
    registration = registerNativeSessionV3Adapter(initialTarget, handleConversationUpdate)
    setController(registration.controller)
    handleConversationUpdate(registration.conversation)

    // Recovering the last requested native model is enrichment. It refines the already usable
    // Session and must never be able to fail it. OpenCode/Codex deliberately started with no model
    // above so a list-level default cannot block this authoritative per-turn result.
    void resolveNativeSessionTargetModel(target).then((resolved) => {
      if (disposed || resolved.model === initialTarget.model) return
      applyDiscoveredNativeSessionModel(initialTarget, resolved.model)
    })

    return () => {
      disposed = true
      registration?.dispose()
    }
  }, [target.key, handleConversationUpdate])

  if (!conversation || !controller) {
    return <div className="tdw-detail-loading"><LoadingIcon size={20} /> Loading Session into the v3 controller...</div>
  }

  return (
    <div className="hr-native-session-observer writable">
      <WorkThreadConversation
        key={target.key}
        conversation={conversation}
        baseConfig={target.config}
        agents={[agent]}
        modelScope={NATIVE_SESSION_MODEL_SCOPE}
        deferModelFallback
        controller={controller}
        onConversationUpdate={handleConversationUpdate}
        onAttentionChange={handleAttentionChange}
        commands={commands}
      />
    </div>
  )
}
