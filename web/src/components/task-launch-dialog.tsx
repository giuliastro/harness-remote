import { useEffect, useMemo, useState } from "react"
import { CloseIcon, FolderIcon, LoadingIcon, PlusIcon, ServerIcon } from "../Icons"
import { discoverMachine, selectableMachineAgents } from "../machineClient"
import { loadActiveServerProfile, loadServerProfiles } from "../serverProfiles"
import { taskClient, type MachineProject } from "../taskClient"
import type { Translator } from "../i18n"
import type { MachineSnapshot, ServerConfig } from "../types"

export function TaskLaunchDialog({ t, onClose, onLaunched }: {
  t: Translator
  onClose: () => void
  onLaunched: () => void
}) {
  const profile = useMemo(() => loadActiveServerProfile(loadServerProfiles()), [])
  const config: ServerConfig = profile.config
  const [machine, setMachine] = useState<MachineSnapshot | null>(null)
  const [projects, setProjects] = useState<MachineProject[]>([])
  const [projectId, setProjectId] = useState("")
  const [agentId, setAgentId] = useState("")
  const [prompt, setPrompt] = useState("")
  const [isolated, setIsolated] = useState(true)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedProject = projects.find((project) => project.id === projectId)
  const availableAgents = machine ? selectableMachineAgents(machine) : []
  // The current sessions surface is scoped to the active saved profile. New machine profiles carry
  // agentId; migrated legacy profiles do not, so fall back to the profile backend in that case.
  const profileAgent = availableAgents.find((agent) => config.agentId ? agent.id === config.agentId : agent.backend === config.backend)
  const agents = profileAgent ? [profileAgent] : []
  const canStart = Boolean(projectId && agentId && prompt.trim()) && !starting

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(null)
      try {
        const discovered = await discoverMachine(config)
        if (!discovered) throw new Error("Task launch requires a Harness machine daemon.")
        const knownProjects = await taskClient.listProjects(config)
        if (cancelled) return
        const selectable = selectableMachineAgents(discovered)
        const activeAgent = selectable.find((agent) => config.agentId ? agent.id === config.agentId : agent.backend === config.backend)
        if (!activeAgent) {
          const label = config.agentId ?? config.backend
          throw new Error(`The active agent ${label} is unavailable on this machine.`)
        }
        setMachine(discovered)
        setProjects(knownProjects)
        setProjectId(knownProjects[0]?.id ?? "")
        setAgentId(activeAgent.id)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [config])

  async function start() {
    if (!canStart) return
    setStarting(true)
    setError(null)
    try {
      let task = await taskClient.createTask(config, { projectId, agentId, prompt: prompt.trim() })
      if (isolated && selectedProject?.kind === "git") task = await taskClient.prepareWorktree(config, task.id)
      await taskClient.launch(config, task.id)
      onLaunched()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal-card wizard fade-in" role="dialog" aria-modal="true" aria-labelledby="new-task-title" onClick={(event) => event.stopPropagation()}>
        <div className="wizard-header">
          <div className="wizard-header-text">
            <h2 id="new-task-title">New Task</h2>
            <p className="subtle">Start isolated agent work on {machine?.machine.name ?? profile.name}.</p>
          </div>
          <button type="button" className="btn-icon btn-ghost" onClick={onClose} aria-label={t('session.cancel')}><CloseIcon size={16} /></button>
        </div>

        <div className="wizard-body">
          {loading ? (
            <div className="empty-state compact"><LoadingIcon size={26} /><p>Loading machine projects and agents…</p></div>
          ) : (
            <>
              <label className="field">
                <span>Project</span>
                <select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={projects.length === 0}>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name} — {project.path}</option>)}
                </select>
              </label>

              <label className="field">
                <span>Task</span>
                <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the work the agent should complete…" rows={5} autoFocus />
              </label>

              <label className="field">
                <span>Agent</span>
                <select value={agentId} onChange={(event) => setAgentId(event.target.value)} disabled={agents.length === 0}>
                  {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
                </select>
              </label>
              {availableAgents.length > 1 && <p className="subtle">This task stays on the active agent profile so its launched session opens in the existing session workflow. Cross-agent placement arrives with Fleet.</p>}

              <div className="folder-picker-current">
                <span className="eyebrow">Machine</span>
                <strong><ServerIcon size={15} /> {machine?.machine.name ?? "Harness daemon"}</strong>
              </div>

              <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: "0.65rem" }}>
                <input type="checkbox" checked={isolated} onChange={(event) => setIsolated(event.target.checked)} disabled={selectedProject?.kind !== "git"} />
                <span><FolderIcon size={14} /> Use a new isolated Git worktree</span>
              </label>
              {selectedProject?.kind !== "git" && <p className="subtle">This project is not a Git repository, so the task will run in the project directory.</p>}
            </>
          )}
          {error && <div className="error fade-in">✗ {error}</div>}
        </div>

        <div className="wizard-footer">
          <span className="spacer" />
          <button type="button" className="btn-secondary" onClick={onClose}>{t('session.cancel')}</button>
          <button type="button" className="btn-primary" disabled={!canStart || loading} onClick={() => void start()}>
            {starting ? <LoadingIcon size={15} /> : <PlusIcon size={15} />}
            {starting ? "Starting…" : "Start Task"}
          </button>
        </div>
      </section>
    </div>
  )
}
