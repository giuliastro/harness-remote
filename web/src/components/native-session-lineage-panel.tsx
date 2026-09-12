import { useEffect, useMemo, useState } from "react"
import { api } from "../api"
import type { NativeSessionSurfaceTarget } from "../native-session-discovery"
import { nativeSessionLineage, type NativeSessionLineageEntry } from "../native-session-lineage"
import type { NativeSessionRouteMachine } from "../native-session-routing"
import type { ServerConfig } from "../types"

type Props = {
  target: NativeSessionSurfaceTarget
  routes: NativeSessionRouteMachine[]
  interactionEnabled: boolean
  onConnectionIssue?: () => void
}

function machineConfig(config: ServerConfig): ServerConfig {
  return { ...config, agentId: undefined }
}

function transportFailure(reason: unknown): boolean {
  return /cannot reach|timed out|network|connection|failed to fetch/i.test(reason instanceof Error ? reason.message : String(reason))
}

function formatTime(value: string): string {
  const time = Date.parse(value)
  return Number.isFinite(time)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(time)
    : value
}

/**
 * Durable, read-only handoff lineage for one real native Session.
 *
 * The daemon stores the edge on both machines, so this survives navigation/restart without importing
 * either provider transcript. The surface intentionally never displays the other machine's path and
 * never treats source permission metadata as target authority.
 */
export function NativeSessionLineagePanel({ target, routes, interactionEnabled, onConnectionIssue }: Props) {
  const [entries, setEntries] = useState<NativeSessionLineageEntry[]>([])

  useEffect(() => {
    let disposed = false
    setEntries([])
    if (!interactionEnabled) return () => { disposed = true }

    void api.listNativeSessionLinks(machineConfig(target.config), target.ref)
      .then(({ links }) => {
        if (!disposed) setEntries(nativeSessionLineage(target.ref, links))
      })
      .catch((reason) => {
        if (!disposed && transportFailure(reason)) onConnectionIssue?.()
        // Lineage is enrichment. An older daemon or unavailable optional endpoint must never make an
        // otherwise readable native Session fail to open.
      })

    return () => { disposed = true }
  }, [target.key, target.machineID, target.agentID, target.sessionID, target.config.host, target.config.port, interactionEnabled, onConnectionIssue])

  const routeByMachine = useMemo(
    () => new Map(routes.map((route) => [route.machineID, route])),
    [routes]
  )

  if (!entries.length) return null

  const identityLabel = (entry: NativeSessionLineageEntry) => {
    const machine = routeByMachine.get(entry.other.machineID)
    const agent = machine?.agents.find((candidate) => candidate.id === entry.other.agentID)
    return `${agent?.label || entry.other.agentID} · ${machine?.label || entry.other.machineID}`
  }

  return (
    <section className="hr-native-lineage" aria-label="Session handoff lineage">
      <header>
        <strong>Handoff lineage</strong>
        <span>Native Sessions stay separate; only the explicit handoff edge and bounded control context are shared.</span>
      </header>
      <div className="hr-native-lineage-list">
        {entries.map((entry) => (
          <article
            key={`${entry.direction}:${entry.other.machineID}:${entry.other.agentID}:${entry.other.sessionID}:${entry.createdAt}`}
            className={`hr-native-lineage-entry ${entry.direction}`}
          >
            <div className="hr-native-lineage-identity">
              <span>{entry.direction === "incoming" ? "Handoff source" : "Handoff target"}</span>
              <strong>{identityLabel(entry)}</strong>
              <small>Session {entry.other.sessionID} · {formatTime(entry.createdAt)}</small>
            </div>
            <div className="hr-native-lineage-boundary" aria-label="Handoff boundary state">
              <span className={entry.contextCarried ? "carried" : "neutral"}>
                {entry.contextCarried ? "Task context carried" : "No portable task context recorded"}
              </span>
              <span className="invalidated">Source authority invalidated</span>
              <span className="fresh">Target authorization is evaluated independently</span>
              <span className="neutral">Attachments not transferred</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
