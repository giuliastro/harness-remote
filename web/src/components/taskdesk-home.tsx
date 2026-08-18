import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { discoverMachine, selectableMachineAgents } from "../machineClient"
import { taskClient, type MachineTask } from "../taskClient"
import { agentLabel, modelLabel, normalizeTaskStatus, sortTasksByActivity, taskStatusLabel, taskTitle } from "../taskdeskHomeModel"
import type { MachineSnapshot, ServerConfig } from "../types"

type TaskDeskHomeProps = {
  config: ServerConfig
  sessions: ReactNode
}

type TaskDeskView = "tasks" | "sessions"

type LoadState = "loading" | "ready" | "unavailable" | "error"

const TASKDESK_DISCOVERY_TIMEOUT_MS = 12_000

function formatLastActivity(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return "Unknown activity"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(timestamp)
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} timed out after ${TASKDESK_DISCOVERY_TIMEOUT_MS / 1000}s.`)), TASKDESK_DISCOVERY_TIMEOUT_MS)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (reason) => {
        window.clearTimeout(timer)
        reject(reason)
      }
    )
  })
}

function browserConnectionHint(config: ServerConfig): string {
  if (typeof window === "undefined") return ""
  const origin = window.location.origin
  return ` Browser access requires the daemon to allow this exact origin with --cors ${origin}. Target: ${config.host}:${config.port}.`
}

export function TaskDeskHome({ config, sessions }: TaskDeskHomeProps) {
  const [view, setView] = useState<TaskDeskView>("tasks")
  const [machine, setMachine] = useState<MachineSnapshot | null>(null)
  const [tasks, setTasks] = useState<MachineTask[]>([])
  const [state, setState] = useState<LoadState>("loading")
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState("loading")
    setError(null)

    void (async () => {
      try {
        const snapshot = await withTimeout(discoverMachine(config), "Machine discovery")
        if (cancelled) return
        setMachine(snapshot)
        if (!snapshot) {
          setTasks([])
          setState("unavailable")
          return
        }

        const loadedTasks = await withTimeout(taskClient.listTasks(config), "Task loading")
        if (cancelled) return
        setTasks(sortTasksByActivity(loadedTasks))
        setState("ready")
      } catch (reason) {
        if (cancelled) return
        setMachine(null)
        setTasks([])
        const detail = reason instanceof Error ? reason.message : String(reason)
        setError(`${detail}${browserConnectionHint(config)}`)
        setState("error")
      }
    })()

    return () => {
      cancelled = true
    }
  }, [config.backend, config.host, config.port, config.username, config.password, config.agentId, revision])

  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  const agents = useMemo(() => machine ? selectableMachineAgents(machine) : [], [machine])

  if (view === "sessions") {
    return (
      <div className="taskdesk-shell taskdesk-shell-sessions">
        <header className="taskdesk-topbar">
          <div className="taskdesk-machine-heading">
            <button className="taskdesk-back" type="button" onClick={() => setView("tasks")}>TaskDesk</button>
            <span className="taskdesk-divider" aria-hidden="true">/</span>
            <strong>Sessions</strong>
          </div>
        </header>
        <div className="taskdesk-session-host">{sessions}</div>
      </div>
    )
  }

  return (
    <div className="taskdesk-shell">
      <header className="taskdesk-topbar">
        <div>
          <p className="taskdesk-eyebrow">TaskDesk 3.0</p>
          <h1>{machine?.machine.name || "Machine"}</h1>
          <p className="taskdesk-machine-id">
            {machine ? `${agents.length} agent${agents.length === 1 ? "" : "s"} available` : `${config.host}:${config.port}`}
          </p>
        </div>
        <div className="taskdesk-topbar-actions">
          <button type="button" className="taskdesk-secondary-button" onClick={() => setView("sessions")}>Sessions</button>
          <button type="button" className="taskdesk-secondary-button" onClick={refresh} disabled={state === "loading"}>Refresh</button>
        </div>
      </header>

      <main className="taskdesk-home">
        <section className="taskdesk-summary" aria-label="Machine summary">
          <div className="taskdesk-summary-card">
            <span>Machine</span>
            <strong>{machine?.machine.name || (state === "loading" ? "Connecting..." : "Unavailable")}</strong>
          </div>
          <div className="taskdesk-summary-card">
            <span>Agents</span>
            <strong>{machine ? agents.length : "-"}</strong>
          </div>
          <div className="taskdesk-summary-card">
            <span>Tasks</span>
            <strong>{state === "ready" ? tasks.length : "-"}</strong>
          </div>
        </section>

        {machine && agents.length > 0 ? (
          <section className="taskdesk-agents" aria-label="Available agents">
            {agents.map((agent) => (
              <span className="taskdesk-agent-chip" key={agent.id} title={`${agent.backend} · ${agent.transport}`}>
                <span className={`taskdesk-agent-dot taskdesk-agent-dot-${agent.state}`} aria-hidden="true" />
                {agent.label}
              </span>
            ))}
          </section>
        ) : null}

        <section className="taskdesk-tasks-section">
          <div className="taskdesk-section-heading">
            <div>
              <p className="taskdesk-eyebrow">Work</p>
              <h2>Tasks</h2>
            </div>
            <p>Tasks are durable work. Sessions remain available separately for direct harness conversations.</p>
          </div>

          {state === "loading" ? (
            <div className="taskdesk-state" role="status">Loading machine and tasks...</div>
          ) : state === "unavailable" ? (
            <div className="taskdesk-state taskdesk-state-warning">
              <strong>This connection does not expose TaskDesk machine APIs.</strong>
              <span>Ordinary sessions still work. Connect to the unified Harness Remote daemon to use Tasks.</span>
              <button type="button" className="taskdesk-primary-button" onClick={() => setView("sessions")}>Open Sessions</button>
            </div>
          ) : state === "error" ? (
            <div className="taskdesk-state taskdesk-state-error" role="alert">
              <strong>Could not load TaskDesk.</strong>
              <span>{error || "Unknown error"}</span>
              <button type="button" className="taskdesk-primary-button" onClick={refresh}>Try again</button>
            </div>
          ) : tasks.length === 0 ? (
            <div className="taskdesk-state">
              <strong>No tasks yet.</strong>
              <span>The next TaskDesk milestone will add the final New Task flow here.</span>
            </div>
          ) : (
            <div className="taskdesk-task-list">
              {tasks.map((task) => {
                const normalizedStatus = normalizeTaskStatus(task.status)
                return (
                  <article className="taskdesk-task-card" key={task.id} data-status={normalizedStatus}>
                    <div className="taskdesk-task-main">
                      <div className="taskdesk-task-title-row">
                        <h3>{taskTitle(task)}</h3>
                        <span className={`taskdesk-status taskdesk-status-${normalizedStatus}`}>{taskStatusLabel(task.status)}</span>
                      </div>
                      <p className="taskdesk-task-project">{task.project?.name || task.projectId}</p>
                      <div className="taskdesk-task-meta">
                        <span><b>Agent</b> {agentLabel(agents, task.agentId)}</span>
                        <span><b>Model</b> {modelLabel(task)}</span>
                        <span><b>Workspace</b> {task.workspace?.mode || "project"}</span>
                      </div>
                    </div>
                    <div className="taskdesk-task-side">
                      <time dateTime={task.updatedAt}>{formatLastActivity(task.updatedAt || task.createdAt)}</time>
                      <span className="taskdesk-task-open-hint">Task detail coming next</span>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
