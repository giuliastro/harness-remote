import { useEffect, useMemo, useState } from "react"
import { CloseIcon, FolderIcon, LoadingIcon, PlusIcon, ServerIcon } from "../Icons"
import { discoverMachineConnection, selectableMachineAgents } from "../machineClient"
import { loadActiveServerProfile, loadServerProfiles } from "../serverProfiles"
import { taskCopy } from "../taskCopy"
import { taskClient, type MachineProject } from "../taskClient"
import type { Translator } from "../i18n"
import type { MachineSnapshot, ServerConfig } from "../types"

export function TaskLaunchDialog({ t, language, onClose, onLaunched }: {
  t: Translator
  language: string
  onClose: () => void
  onLaunched: () => void
}) {
  const profile = useMemo(() => loadActiveServerProfile(loadServerProfiles()), [])
  const config: ServerConfig = profile.config
  const [taskConfig, setTaskConfig] = useState<ServerConfig | null>(null)
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
  const profileAgent = availableAgents.find((agent) => config.agentId ? agent.id === config.agentId : agent.backend === config.backend)
  const agents = profileAgent ? [profileAgent] : []
  const canStart = Boolean(taskConfig && projectId && agentId && prompt.trim()) && !starting

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(null)
      setTaskConfig(null)
      try {
        const connection = await discoverMachineConnection(config)
        if (!connection) throw new Error(taskCopy(language, "requiresDaemon"))
        const knownProjects = await taskClient.listProjects(connection.config)
        if (cancelled) return
        const selectable = selectableMachineAgents(connection.machine)
        const activeAgent = selectable.find((agent) => config.agentId ? agent.id === config.agentId : agent.backend === config.backend)
        if (!activeAgent) {
          const label = config.agentId ?? config.backend
          throw new Error(taskCopy(language, "agentUnavailable", { agent: label }))
        }
        setTaskConfig(connection.config)
        setMachine(connection.machine)
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
  }, [config, language])

  async function start() {
    if (!canStart || !taskConfig) return
    setStarting(true)
    setError(null)
    try {
      let task = await taskClient.createTask(taskConfig, { projectId, agentId, prompt: prompt.trim() })
      if (isolated && selectedProject?.kind === "git") task = await taskClient.prepareWorktree(taskConfig, task.id)
      await taskClient.launch(taskConfig, task.id)
      onLaunched()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStarting(false)
    }
  }

  const machineName = machine?.machine.name ?? profile.name

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal-card wizard fade-in" role="dialog" aria-modal="true" aria-labelledby="new-task-title" onClick={(event) => event.stopPropagation()}>
        <div className="wizard-header">
          <div className="wizard-header-text">
            <h2 id="new-task-title">{taskCopy(language, "newTask")}</h2>
            <p className="subtle">{taskCopy(language, "subtitle", { machine: machineName })}</p>
          </div>
          <button type="button" className="btn-icon btn-ghost" onClick={onClose} aria-label={t('session.cancel')}><CloseIcon size={16} /></button>
        </div>

        <div className="wizard-body">
          {loading ? (
            <div className="empty-state compact"><LoadingIcon size={26} /><p>{taskCopy(language, "loading")}</p></div>
          ) : error ? (
            <div className="error fade-in">✗ {error}</div>
          ) : projects.length === 0 ? (
            <div className="empty-state compact"><FolderIcon size={30} /><p>{taskCopy(language, "noProjects")}</p></div>
          ) : (
            <div className="task-launch-form">
              <div className="folder-picker-current">
                <span className="eyebrow">{taskCopy(language, "machine")}</span>
                <strong><ServerIcon size={15} /> <span className="truncate">{machineName}</span></strong>
              </div>

              <div className="task-launch-grid">
                <label className="field">
                  <span>{taskCopy(language, "project")}</span>
                  <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                    {projects.map((project) => <option key={project.id} value={project.id}>{project.name} — {project.path}</option>)}
                  </select>
                </label>

                <label className="field">
                  <span>{taskCopy(language, "agent")}</span>
                  <select value={agentId} onChange={(event) => setAgentId(event.target.value)} disabled={agents.length === 0}>
                    {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
                  </select>
                </label>
              </div>
              {availableAgents.length > 1 && <p className="subtle task-launch-agent-note">{taskCopy(language, "activeAgent")}</p>}

              <label className="field">
                <span>{taskCopy(language, "task")}</span>
                <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={taskCopy(language, "promptPlaceholder")} rows={6} autoFocus />
              </label>

              <div className="task-launch-worktree">
                <label className="task-launch-check">
                  <input type="checkbox" checked={isolated} onChange={(event) => setIsolated(event.target.checked)} disabled={selectedProject?.kind !== "git"} />
                  <span><FolderIcon size={15} /> {taskCopy(language, "isolatedWorktree")}</span>
                </label>
                {selectedProject?.kind !== "git" && <p className="subtle">{taskCopy(language, "nonGit")}</p>}
              </div>
            </div>
          )}
        </div>

        <div className="wizard-footer">
          <span className="spacer" />
          <button type="button" className="btn-secondary" onClick={onClose}>{t('session.cancel')}</button>
          <button type="button" className="btn-primary" disabled={!canStart || loading || Boolean(error) || projects.length === 0} onClick={() => void start()}>
            {starting ? <LoadingIcon size={15} /> : <PlusIcon size={15} />}
            {starting ? taskCopy(language, "starting") : taskCopy(language, "startTask")}
          </button>
        </div>
      </section>
    </div>
  )
}
