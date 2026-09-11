import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react"
import { notifyDesktopAttention, subscribeDesktopAttentionActivation } from "../desktopBridge"
import { subscribeAndroidAttentionActivation } from "../native-session-attention-android"
import { discoverAgentNativeSessionPage, nativeSessionSurfaceTarget, type NativeSessionSurfaceTarget } from "../native-session-discovery"
import { loadNativeSessionAttentionIndex, type NativeSessionAttentionIndex, type NativeSessionAttentionIndexItem } from "../native-session-attention-index"
import { startNativeSessionAttentionLiveRefresh, type NativeSessionAttentionLiveTarget } from "../native-session-attention-live"
import { desktopAttentionNotification } from "../native-session-attention-notification-presentation"
import {
  EMPTY_NATIVE_SESSION_ATTENTION_NOTIFICATION_STATE,
  reconcileNativeSessionAttentionNotifications,
  type NativeSessionAttentionNotificationState
} from "../native-session-attention-notifications"
import type { MachineAgentHost, ServerConfig } from "../types"
import { NativeSessionHome as NativeSessionHomeBase } from "./native-session-home-base"
import "../native-session-attention-inbox.css"

export { appendCursorPage, refreshCursorPage, sessionTreeRows } from "./native-session-home-base"
export type { CursorPageState } from "./native-session-home-base"

type Props = ComponentProps<typeof NativeSessionHomeBase>

type AttentionTarget = NativeSessionAttentionLiveTarget & {
  machineID: string
  machineName: string
}

type AttentionScope = {
  target: AttentionTarget
  index: NativeSessionAttentionIndex
}

type InboxEntry = {
  target: AttentionTarget
  item: NativeSessionAttentionIndexItem
  complete: boolean
}

export type AttentionInboxCounts = {
  authorization: number
  recoverable: number
  rejected: number
  total: number
}

const ATTENTION_FALLBACK_MS = 30_000

function supportsAttention(agent: MachineAgentHost): boolean {
  return agent.state === "available"
    && (agent.capabilities.questions === true || agent.capabilities.permissions === true)
}

function targetKey(machineID: string, agentID: string): string {
  return `${machineID}\u0000${agentID}`
}

function sessionKey(target: AttentionTarget, sessionID: string): string {
  return `${target.machineID}:${target.agent.id}:${sessionID}`
}

function shortSessionID(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-5)}`
}

function permissionReason(item: NativeSessionAttentionIndexItem): string | undefined {
  const metadata = item.permissions[0]?.metadata
  if (!metadata) return undefined
  for (const key of ["reason", "description", "message"]) {
    const value = metadata[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function entrySummary(item: NativeSessionAttentionIndexItem): string {
  const permission = item.permissions[0]
  if (permission) {
    const reason = permissionReason(item)
    const scope = permission.patterns?.[0]
    return [permission.permission, reason, scope].filter(Boolean).join(" · ") || "Permission requested"
  }
  const question = item.questions[0]?.questions?.[0]
  return question?.question || question?.header || "The coding agent is waiting for your input."
}

function attentionRank(item: NativeSessionAttentionIndexItem): number {
  switch (item.attention.kind) {
    case "authorization": return 0
    case "rejected": return 1
    case "recoverable": return 2
    default: return 3
  }
}

function attentionPresentation(item: NativeSessionAttentionIndexItem): {
  className: "authorization" | "recoverable" | "rejected"
  label: string
  consequence?: string
} {
  if (item.attention.kind === "authorization") {
    return {
      className: "authorization",
      label: "Authorization required",
      consequence: "If you do nothing, this request stays blocked."
    }
  }
  if (item.attention.kind === "rejected") {
    return {
      className: "rejected",
      label: "Request rejected",
      consequence: "This request was rejected and will not proceed automatically."
    }
  }
  return {
    className: "recoverable",
    label: item.attention.reason === "question" ? "Needs input" : "Needs attention"
  }
}

export function attentionInboxCounts(items: NativeSessionAttentionIndexItem[]): AttentionInboxCounts {
  return items.reduce<AttentionInboxCounts>((counts, item) => {
    if (item.attention.kind === "authorization") counts.authorization += 1
    else if (item.attention.kind === "recoverable") counts.recoverable += 1
    else if (item.attention.kind === "rejected") counts.rejected += 1
    counts.total += 1
    return counts
  }, { authorization: 0, recoverable: 0, rejected: 0, total: 0 })
}

/**
 * Compose the mature Session browser with the global attention read model without changing its
 * pagination, ordering or writer semantics. Attention has its own tiny refresh loop and event path;
 * native Session history is touched only when the user explicitly asks to open an Inbox item.
 */
export function NativeSessionHome(props: Props) {
  const [scopes, setScopes] = useState<Record<string, AttentionScope>>({})
  const [knownTargets, setKnownTargets] = useState<Record<string, NativeSessionSurfaceTarget>>({})
  const [openingKey, setOpeningKey] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [baseAttentionCount, setBaseAttentionCount] = useState(0)
  const generationRef = useRef(0)
  const notificationStateRef = useRef<NativeSessionAttentionNotificationState>({
    scopes: { ...EMPTY_NATIVE_SESSION_ATTENTION_NOTIFICATION_STATE.scopes }
  })

  const attentionTargets = useMemo<AttentionTarget[]>(() => props.sources.flatMap(({ machine, snapshot, state }) => {
    if (!snapshot || state !== "online") return []
    return snapshot.agents
      .filter(supportsAttention)
      .map((agent) => ({
        key: targetKey(machine.id, agent.id),
        baseConfig: machine.config as ServerConfig,
        agent,
        machineID: snapshot.machine.id,
        machineName: snapshot.machine.name || machine.name
      }))
  }), [props.sources])

  const targetSignature = attentionTargets.map((target) => [
    target.key,
    target.machineID,
    target.baseConfig.host,
    target.baseConfig.port,
    target.baseConfig.username,
    target.baseConfig.password,
    target.agent.processID ?? "",
    target.agent.state,
    target.agent.capabilities.questions === true ? "q" : "",
    target.agent.capabilities.permissions === true ? "p" : ""
  ].join(":" )).join("|")

  const targetsRef = useRef<Map<string, AttentionTarget>>(new Map())
  targetsRef.current = new Map(attentionTargets.map((target) => [target.key, target]))

  const rememberAndOpen = useCallback((target: NativeSessionSurfaceTarget) => {
    setKnownTargets((current) => ({ ...current, [target.key]: target }))
    props.onOpen(target)
  }, [props.onOpen])

  const openAttentionSession = useCallback(async (target: AttentionTarget, sessionID: string) => {
    const key = sessionKey(target, sessionID)
    if (props.selectedKey === key || openingKey) return
    setOpeningKey(key)
    setOpenError(null)
    try {
      let cursor: string | undefined
      const seen = new Set<string>()
      for (;;) {
        const page = await discoverAgentNativeSessionPage(target.baseConfig, target.agent, cursor)
        const record = page.records.find((candidate) => candidate.session.id === sessionID)
        if (record) {
          rememberAndOpen(nativeSessionSurfaceTarget(target.machineID, target.baseConfig, record))
          return
        }
        if (!page.nextCursor || seen.has(page.nextCursor)) break
        seen.add(page.nextCursor)
        cursor = page.nextCursor
      }
      throw new Error("This Session is no longer available in the native history.")
    } catch (reason) {
      setOpenError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setOpeningKey(null)
    }
  }, [openingKey, props.selectedKey, rememberAndOpen])

  const activateAttention = useCallback((activation: { machineID: string; agentID: string; sessionID: string }) => {
    const target = [...targetsRef.current.values()].find((candidate) =>
      candidate.machineID === activation.machineID && candidate.agent.id === activation.agentID
    )
    if (!target) {
      setOpenError("The machine or harness for this notification is not currently available.")
      return
    }
    void openAttentionSession(target, activation.sessionID)
  }, [openAttentionSession])

  const refreshAttentionTarget = useCallback(async (candidate: NativeSessionAttentionLiveTarget, generation: number) => {
    const target = targetsRef.current.get(candidate.key)
    if (!target) return
    const result = await loadNativeSessionAttentionIndex(target.baseConfig, target.agent)
    if (generationRef.current !== generation) return
    const latest = targetsRef.current.get(candidate.key)
    if (!latest) return

    const notificationResult = reconcileNativeSessionAttentionNotifications(notificationStateRef.current, [{
      machineID: latest.machineID,
      machineName: latest.machineName,
      agentID: latest.agent.id,
      agentLabel: latest.agent.label,
      index: result
    }])
    notificationStateRef.current = notificationResult.state
    for (const notification of notificationResult.notifications) {
      notifyDesktopAttention(desktopAttentionNotification(notification))
    }

    setScopes((current) => {
      const previous = current[candidate.key]
      // A partial refresh must not make a previously known authorization disappear. Keep the last
      // complete item set while exposing the new incomplete/error metadata until a full read lands.
      const index = !result.complete && previous
        ? { ...result, items: previous.index.items }
        : result
      return { ...current, [candidate.key]: { target: latest, index } }
    })
  }, [])

  useEffect(() => subscribeDesktopAttentionActivation(activateAttention), [activateAttention])
  useEffect(() => subscribeAndroidAttentionActivation(activateAttention), [activateAttention])

  useEffect(() => {
    const generation = ++generationRef.current
    const activeKeys = new Set(attentionTargets.map((target) => target.key))
    setScopes((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => activeKeys.has(key))
    ))

    const refreshAll = () => {
      for (const target of targetsRef.current.values()) void refreshAttentionTarget(target, generation)
    }

    refreshAll()
    const live = startNativeSessionAttentionLiveRefresh({
      targets: attentionTargets,
      onRefresh: (target) => void refreshAttentionTarget(target, generation)
    })
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshAll()
    }, ATTENTION_FALLBACK_MS)
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshAll()
    }
    const onPageShow = () => refreshAll()
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("pageshow", onPageShow)

    return () => {
      live.close()
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("pageshow", onPageShow)
    }
  }, [refreshAttentionTarget, targetSignature])

  const inbox = useMemo<InboxEntry[]>(() => Object.values(scopes)
    .flatMap((scope) => scope.index.items.map((item) => ({
      target: scope.target,
      item,
      complete: scope.index.complete
    })))
    .sort((left, right) =>
      attentionRank(left.item) - attentionRank(right.item)
      || left.target.machineName.localeCompare(right.target.machineName)
      || left.target.agent.label.localeCompare(right.target.agent.label)
      || left.item.sessionID.localeCompare(right.item.sessionID)
    ), [scopes])

  const counts = useMemo(() => attentionInboxCounts(inbox.map((entry) => entry.item)), [inbox])
  const incomplete = Object.values(scopes).some((scope) => !scope.index.complete)

  // The base rail already reports generic status/error attention. Add explicit pending question /
  // permission Sessions so the mobile badge still carries global attention when the rail is hidden.
  // In normal harness behavior these sets are disjoint: a blocked permission keeps the native
  // Session working/waiting rather than changing its discovery status to a generic attention error.
  useEffect(() => {
    props.onAttentionCountChange?.(baseAttentionCount + counts.total)
  }, [baseAttentionCount, counts.total, props.onAttentionCountChange])

  return (
    <>
      {inbox.length || incomplete ? (
        <section className="hr-native-attention-inbox" aria-label="Attention Inbox" aria-live="polite">
          <div className="hr-native-attention-heading">
            <span className="hr-native-attention-title"><strong>Attention</strong><small>{counts.total} pending</small></span>
            <span className="hr-native-attention-counts" aria-label="Attention summary">
              {counts.authorization ? <small className="authorization" title="Authorization required">{counts.authorization} auth</small> : null}
              {counts.recoverable ? <small className="recoverable" title="Needs input or recoverable attention">{counts.recoverable} input</small> : null}
              {counts.rejected ? <small className="rejected" title="Rejected or fail-closed">{counts.rejected} rejected</small> : null}
              {incomplete ? <em title="One or more attention endpoints could not be refreshed.">Some status may be stale</em> : null}
            </span>
          </div>
          {inbox.length ? (
            <div className="hr-native-attention-list">
              {inbox.map((entry) => {
                const key = sessionKey(entry.target, entry.item.sessionID)
                const selected = props.selectedKey === key
                const known = knownTargets[key]
                const presentation = attentionPresentation(entry.item)
                const permission = entry.item.permissions[0]
                return (
                  <button
                    type="button"
                    className={`hr-native-attention-row ${presentation.className}${selected ? " selected" : ""}`}
                    key={`${entry.target.key}:${entry.item.sessionID}`}
                    onClick={() => void openAttentionSession(entry.target, entry.item.sessionID)}
                    disabled={openingKey === key}
                    aria-current={selected ? "page" : undefined}
                    aria-label={`${presentation.label}: ${known?.title || entry.item.sessionID}, ${entry.target.agent.label}, ${entry.target.machineName}`}
                  >
                    <span className="hr-native-attention-copy">
                      <strong>{presentation.label}</strong>
                      <small>{entrySummary(entry.item)}</small>
                      {presentation.consequence ? <em>{presentation.consequence}</em> : null}
                    </span>
                    <span className="hr-native-attention-identity">
                      <strong>{known?.title || `Session ${shortSessionID(entry.item.sessionID)}`}</strong>
                      <small>{entry.target.machineName} · {entry.target.agent.label}</small>
                      {known?.directory ? <code title={known.directory}>{known.directory}</code> : permission?.patterns?.length ? <code title={permission.patterns.join(", ")}>{permission.patterns[0]}</code> : null}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : null}
          {openError ? <div className="hr-native-attention-error" role="alert">{openError}</div> : null}
        </section>
      ) : null}
      <NativeSessionHomeBase {...props} onAttentionCountChange={setBaseAttentionCount} onOpen={rememberAndOpen} />
    </>
  )
}
