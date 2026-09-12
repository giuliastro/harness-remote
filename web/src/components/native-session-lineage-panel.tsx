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

function projectStateLabel(entry: NativeSessionLineageEntry): string | null {
  const state = entry.portableState
  if (!state) return null
  if (state.project.decision === "automatic") return "Project: exact workspace"
  if (state.project.reason === "workspace_diverged") return "Project: workspace differs — review accepted"
  return "Project: continuity unverified — review accepted"
}

function evidenceLabel(entry: NativeSessionLineageEntry): string | null {
  const evidence = entry.portableState?.project.evidence
  if (!evidence) return null
  return `Evidence: repo ${evidence.repository}, history ${evidence.history}, branch ${evidence.branch}, HEAD ${evidence.head}`
}

/**
 * Durable, read-only handoff lineage for one real native Session.
 *
 * The daemon stores the edge on both machines, so this survives navigation/restart without importing
 * either provider transcript. The surface intentionally never displays the other machine's path and
 * never treats source permission metadata as target authority. Structured portable state is displayed
 * only after the lineage projector validates the daemon payload against the v1 portable-state contract.
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
        <span>Durable task and Project evidence can be recovered here; native transcripts and authority stay separate.</span>
      </header>
      <div className="hr-native-lineage-list">
        {entries.map((entry) => {
          const projectLabel = projectStateLabel(entry)
          const evidence = evidenceLabel(entry)
          return (
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
                {entry.portableState ? (
                  <>
                    <span className="carried">Task: {entry.portableState.task.title}</span>
                    {projectLabel ? <span className={entry.portableState.project.decision === "automatic" ? "fresh" : "invalidated"}>{projectLabel}</span> : null}
                    {evidence ? <span className="neutral">{evidence}</span> : null}
                  </>
                ) : (
                  <span className={entry.contextCarried ? "carried" : "neutral"}>
                    {entry.contextCarried ? "Bounded task context carried" : "No portable task context recorded"}
                  </span>
                )}
                <span className="invalidated">Source authority invalidated</span>
                <span className="fresh">Target authorization is evaluated independently</span>
                <span className="neutral">Attachments not transferred</span>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
