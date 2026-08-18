import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { discoverMachine, selectableMachineAgents } from "../machineClient"
import { taskClient, type MachineTask } from "../taskClient"
import { agentLabel, modelLabel, normalizeTaskStatus, sortTasksByActivity, taskStatusLabel, taskTitle } from "../taskdeskHomeModel"
import type { MachineSnapshot, ServerConfig } from "../types"

type TaskDeskHomeProps = {
  config: ServerConfig
  sessions: ReactNode
  onUpdateConnection: (config: ServerConfig) => void
}

type TaskDeskView = "tasks" | "sessions"
type LoadState = "loading" | "ready" | "unavailable" | "error"

const TASKDESK_DISCOVERY_TIMEOUT_MS = 12_000

function formatLastActivity(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return "Unknown activity"
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp)
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
  return ` Browser access requires the daemon to allow this exact origin with --cors ${window.location.origin}. Target: ${config.host}:${config.port}.`
}

function ConnectionEditor({
  config,
  onCancel,
  onSave
}: {
  config: ServerConfig
  onCancel: () => void
  onSave: (config: ServerConfig) => void
}) {
  const [host, setHost] = useState(config.host)
  const [port, setPort] = useState(String(config.port))
  const [username, setUsername] = useState(config.username)
  const [password, setPassword] = useState(config.password)
  const parsedPort = Number(port)
  const valid = host.trim().length > 0 && Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65_535

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <section className="modal-card wizard taskdesk-connection-editor" role="dialog" aria-modal="true" aria-labelledby="taskdesk-connection-title" onClick={(event) => event.stopPropagation()}>
        <div className="wizard-header">
          <div className="wizard-header-text">
            <h2 id="taskdesk-connection-title">Machine connection</h2>
            <p className="subtle">Use the Address, Username and Password printed by the Harness Remote daemon.</p>
          </div>
        </div>
        <div className="wizard-body">
          <label className="field">
            <span>Host</span>
            <input value={host} onChange={(event) => setHost(event.target.value)} spellCheck={false} autoCapitalize="none" autoCorrect="off" />
          </label>
          <label className="field">
            <span>Port</span>
            <input value={port} inputMode="numeric" onChange={(event) => setPort(event.target.value)} />
          </label>
          <label className="field">
            <span>Username</span>
            <input value={username} onChange={(event) => setUsername(event.target.value)} spellCheck={false} autoCapitalize="none" autoCorrect="off" />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
          </label>
        </div>
        <div className="wizard-footer">
          <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="btn-primary"
            disabled={!valid}
            onClick={() => onSave({ ...config, host: host.trim(), port: parsedPort, username: username.trim(), password: password.trim() })}
          >
            Save and reconnect
          </button>
        </div>
      </section>
    </div>
  )
}

export function TaskDeskHome({ config, sessions, onUpdateConnection }: TaskDeskHomeProps) {
  const [view, setView] = useState<TaskDeskView>("tasks")
  const [machine, setMachine] = useState<MachineSnapshot | null>(null)
  const [tasks, setTasks] = useState<MachineTask[]>([])
  const [state, setState] = useState<LoadState>("loading")
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [editingConnection, setEditingConnection] = useState(false)

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
          <button type="button" className="taskdesk-machine-address" onClick={() => setEditingConnection(true)} title="Edit machine connection">
            {machine ? `${agents.length} agent${agents.length === 1 ? "" : "s"} available · ${config.host}:${config.port}` : `${config.host}:${config.port}`}
          </button>
        </div>
        <div className="taskdesk-topbar-actions">
          <button type="button" className="taskdesk-secondary-button" onClick={() => setEditingConnection(true)}>Connection</button>
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
              <button type="button" className="taskdesk-primary-button" onClick={() => setEditingConnection(true)}>Change connection</button>
            </div>
          ) : state === "error" ? (
            <div className="taskdesk-state taskdesk-state-error" role="alert">
              <strong>Could not load TaskDesk.</strong>
              <span>{error || "Unknown error"}</span>
              <div className="taskdesk-state-actions">
                <button type="button" className="taskdesk-primary-button" onClick={() => setEditingConnection(true)}>Change connection</button>
                <button type="button" className="taskdesk-secondary-button" onClick={refresh}>Try again</button>
              </div>
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

      {editingConnection && (
        <ConnectionEditor
          config={config}
          onCancel={() => setEditingConnection(false)}
          onSave={(nextConfig) => {
            setEditingConnection(false)
            onUpdateConnection(nextConfig)
          }}
        />
      )}
    </div>
  )
}
