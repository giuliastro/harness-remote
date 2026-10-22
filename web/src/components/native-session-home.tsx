import { useEffect, useMemo, useSyncExternalStore, type ComponentProps } from "react"
import { NativeSessionHome as NativeSessionHomeWithAttention } from "./native-session-home-attention"
import { nativeSessionConfig } from "../native-session-discovery"
import {
  sessionIndexInvalidationRevision,
  subscribeSessionIndexInvalidation
} from "../session-index-live-state"
import { subscribeTaskDeskLiveEvents } from "../taskdesk-live-events"
import type { MachineAgentHost } from "../types"

type Props = ComponentProps<typeof NativeSessionHomeWithAttention>

export function needsRailLifecycleStream(agent: MachineAgentHost): boolean {
  return agent.state === "available"
    && agent.capabilities?.sessions !== false
    && agent.capabilities?.questions !== true
    && agent.capabilities?.permissions !== true
}

/**
 * Session lifecycle is not part of `/v1/machine`, so a live edge must invalidate the Session read
 * directly rather than smuggling client-only state into the daemon snapshot. Cloning only the
 * source wrappers preserves the real machine payload while making the existing discovery effect
 * observe the lifecycle revision. Manual refreshToken semantics remain untouched.
 *
 * Every harness needs one persistent agent-routed stream to own rail lifecycle, because the daemon's
 * unscoped stream carries only its primary harness. Limiting this to OpenCode left each non-primary
 * harness without questions/permissions (OMP, PI, Claude) with no lifecycle edge at all: a turn that
 * ended while another Session was open stayed "working" in the rail until the next poll, or until
 * the user opened it again. The Attention layer already owns such a routed stream when a harness
 * advertises questions/permissions, so this wrapper opens only the fallback needed by an available
 * agent without those capabilities. That preserves one lifecycle owner per routed agent without
 * per-Session observers, polling, or waking a lazy configured host just because the rail is visible.
 * ACP token chunks never invalidate the rail (see session-index-live-state.ts), so these streams cost
 * one index read per lifecycle edge, not per chunk. The selected detail stream remains
 * presentation/transcript-only.
 */
export function NativeSessionHome(props: Props) {
  const liveRevision = useSyncExternalStore(
    subscribeSessionIndexInvalidation,
    sessionIndexInvalidationRevision,
    sessionIndexInvalidationRevision
  )
  const liveSources = useMemo(
    () => props.sources.map((source) => ({ ...source })),
    [props.sources, liveRevision]
  )

  const routedStreamSignature = props.sources.map(({ machine, snapshot, state }) => [
    machine.id,
    machine.config.host,
    machine.config.port,
    machine.config.username,
    machine.config.password,
    state,
    snapshot?.machine.id || "",
    state === "online"
      ? snapshot?.agents
        .filter(needsRailLifecycleStream)
        .map((agent) => `${agent.id}:${agent.backend}:${agent.transport}:${agent.state}`)
        .join(",") || ""
      : ""
  ].join("\u0000")).join("\u0001")

  useEffect(() => {
    const subscriptions = props.sources.flatMap(({ machine, snapshot, state }) => {
      if (!snapshot || state !== "online") return []
      return snapshot.agents
        .filter(needsRailLifecycleStream)
        .map((agent) => subscribeTaskDeskLiveEvents({
          config: nativeSessionConfig(machine.config, agent),
          trackSessionIndex: true,
          // Lifecycle normalization/cache happens inside the shared transport. The rail discovery
          // reacts through useSyncExternalStore above; it does not need another per-event callback.
          onEvent: () => undefined
        }))
    })
    return () => {
      for (const subscription of subscriptions) subscription.close()
    }
    // Endpoint + agent routing semantics, not source array identity: machine refreshes rebuild
    // wrappers even when routing is unchanged. Reopening the SSE stream on each render loses edges.
  }, [routedStreamSignature])

  return <NativeSessionHomeWithAttention {...props} sources={liveSources} />
}
