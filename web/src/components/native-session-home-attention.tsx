import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react"
import { discoverAgentNativeSessionPage, nativeSessionSurfaceTarget, type NativeSessionSurfaceTarget } from "../native-session-discovery"
import { loadNativeSessionAttentionIndex, type NativeSessionAttentionIndex, type NativeSessionAttentionIndexItem } from "../native-session-attention-index"
import { startNativeSessionAttentionLiveRefresh, type NativeSessionAttentionLiveTarget } from "../native-session-attention-live"
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
  return item.attention.kind === "authorization" ? 0 : 1
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

  const refreshAttentionTarget = useCallback(async (candidate: NativeSessionAttentionLiveTarget, generation: number) => {
    const target = targetsRef.current.get(candidate.key)
    if (!target) return
    const result = await loadNativeSessionAttentionIndex(target.baseConfig, target.agent)
    if (generationRef.current !== generation) return
    const latest = targetsRef.current.get(candidate.key)
    if (!latest) return
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

  const incomplete = Object.values(scopes).some((scope) => !scope.index.complete)

  // The base rail already reports generic status/error attention. Add explicit pending question /
  // permission Sessions so the mobile badge still carries global attention when the rail is hidden.
  // In normal harness behavior these sets are disjoint: a blocked permission keeps the native
  // Session working/waiting rather than changing its discovery status to a generic attention error.
  useEffect(() => {
    props.onAttentionCountChange?.(baseAttentionCount + inbox.length)
  }, [baseAttentionCount, inbox.length, props.onAttentionCountChange])

  const rememberAndOpen = useCallback((target: NativeSessionSurfaceTarget) => {
    setKnownTargets((current) => ({ ...current, [target.key]: target }))
    props.onOpen(target)
  }, [props.onOpen])

  async function openInboxEntry(entry: InboxEntry) {
    const key = sessionKey(entry.target, entry.item.sessionID)
    if (props.selectedKey === key || openingKey) return
    setOpeningKey(key)
    setOpenError(null)
    try {
      let cursor: string | undefined
      const seen = new Set<string>()
      for (;;) {
        const page = await discoverAgentNativeSessionPage(entry.target.baseConfig, entry.target.agent, cursor)
        const record = page.records.find((candidate) => candidate.session.id === entry.item.sessionID)
        if (record) {
          rememberAndOpen(nativeSessionSurfaceTarget(entry.target.machineID, entry.target.baseConfig, record))
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
  }

  return (
    <>
      {inbox.length || incomplete ? (
        <section className="hr-native-attention-inbox" aria-label="Attention Inbox" aria-live="polite">
          <div className="hr-native-attention-heading">
            <span><strong>Attention</strong><small>{inbox.length} pending</small></span>
            {incomplete ? <em title="One or more attention endpoints could not be refreshed.">Some status may be stale</em> : null}
          </div>
          {inbox.length ? (
            <div className="hr-native-attention-list">
              {inbox.map((entry) => {
                const key = sessionKey(entry.target, entry.item.sessionID)
                const selected = props.selectedKey === key
                const known = knownTargets[key]
                const authorization = entry.item.attention.kind === "authorization"
                const permission = entry.item.permissions[0]
                return (
                  <button
                    type="button"
                    className={`hr-native-attention-row ${authorization ? "authorization" : "recoverable"}${selected ? " selected" : ""}`}
                    key={`${entry.target.key}:${entry.item.sessionID}`}
                    onClick={() => void openInboxEntry(entry)}
                    disabled={openingKey === key}
                    aria-current={selected ? "page" : undefined}
                    aria-label={`${authorization ? "Authorization required" : "Needs attention"}: ${known?.title || entry.item.sessionID}, ${entry.target.agent.label}, ${entry.target.machineName}`}
                  >
                    <span className="hr-native-attention-copy">
                      <strong>{authorization ? "Authorization required" : "Needs attention"}</strong>
                      <small>{entrySummary(entry.item)}</small>
                      {authorization ? <em>If you do nothing, this request stays blocked.</em> : null}
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
