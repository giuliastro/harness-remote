import { useEffect, useMemo, useState } from "react"
import { CloseIcon, FolderIcon, LoadingIcon, PlayIcon, ServerIcon } from "../Icons"
import { discoverMachineConnection, selectableMachineAgents } from "../machineClient"
import { loadActiveServerProfile, loadServerProfiles } from "../serverProfiles"
import { taskClient, type MachineProject } from "../taskClient"
import type { Translator } from "../i18n"
import type { MachineSnapshot, ModelOption, ServerConfig } from "../types"

function activeProfileAgent(machine: MachineSnapshot | null, config: ServerConfig) {
  if (!machine) return undefined
  return selectableMachineAgents(machine).find((agent) => (
    config.agentId ? agent.id === config.agentId : agent.backend === config.backend
  ))
}

export function TaskLaunchDialog({ t, onClose, onLaunched }: {
  t: Translator
  onClose: () => void
  onLaunched: () => void
}) {
  const profile = useMemo(() => loadActiveServerProfile(loadServerProfiles()), [])
  const config: ServerConfig = profile.config
  const [taskConfig, setTaskConfig] = useState<ServerConfig | null>(null)
  const [machine, setMachine] = useState<MachineSnapshot | null>(null)
  const [projects, setProjects] = useState<MachineProject[]>([])
  const [projectId, setProjectId] = useState("")
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelIndex, setModelIndex] = useState(-1)
  const [modelStale, setModelStale] = useState(false)
  const [modelNotice, setModelNotice] = useState<string | null>(null)
  const [prompt, setPrompt] = useState("")
  const [isolated, setIsolated] = useState(true)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedProject = projects.find((project) => project.id === projectId)
  const agent = activeProfileAgent(machine, config)
  const otherAgents = machine ? selectableMachineAgents(machine).length > 1 : false
  const canStart = Boolean(taskConfig && agent && projectId && prompt.trim()) && !starting

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(null)
      setTaskConfig(null)
      setModelStale(false)
      setModelNotice(null)
      try {
        const connection = await discoverMachineConnection(config)
        if (!connection) throw new Error(t('task.requiresDaemon'))
        const knownProjects = await taskClient.listProjects(connection.config)
        if (cancelled) return
        const active = activeProfileAgent(connection.machine, config)
        if (!active) throw new Error(t('task.agentUnavailable', { agent: config.agentId ?? config.backend }))

        // This is deliberately machine/agent-level discovery, not a session picker shortcut. The
        // daemon refreshes the harness catalog whenever New Task opens and may return its last known
        // catalog only when the fresh lookup failed. Launch validates the selected model again.
        const catalog = await taskClient.listAgentModels(connection.config, active.id)
        if (cancelled) return
        setModels(catalog.models)
        setModelIndex(catalog.models.findIndex((option) => option.isDefault))
        setModelStale(catalog.stale)
        setModelNotice(catalog.stale ? (catalog.error ?? "Model catalog could not be refreshed.") : null)
        setTaskConfig(connection.config)
        setMachine(connection.machine)
        setProjects(knownProjects)
        setProjectId(knownProjects[0]?.id ?? "")
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [config, t])

  async function start() {
    if (!canStart || !taskConfig || !agent) return
    setStarting(true)
    setError(null)
    try {
      const model = models[modelIndex]
      let task = await taskClient.createTask(taskConfig, {
        projectId,
        agentId: agent.id,
        prompt: prompt.trim(),
        model: model && { providerID: model.providerID, modelID: model.modelID, variant: model.variant }
      })
      if (isolated && selectedProject?.kind === "git") task = await taskClient.prepareWorktree(taskConfig, task.id)
      // The daemon performs a second live model refresh here. If the harness removed the selected
      // model after this dialog opened, launch is rejected instead of silently using a default.
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
            <h2 id="new-task-title">{t('task.new')}</h2>
            <p className="subtle">{t('task.subtitle', { machine: machineName })}</p>
          </div>
          <button type="button" className="btn-icon btn-ghost" onClick={onClose} aria-label={t('session.cancel')}><CloseIcon size={16} /></button>
        </div>

        <div className="wizard-body">
          {loading ? (
            <div className="empty-state compact"><LoadingIcon size={26} /><p>{t('task.loading')}</p></div>
          ) : error ? (
            <div className="error fade-in">✗ {error}</div>
          ) : projects.length === 0 ? (
            <div className="empty-state compact"><FolderIcon size={30} /><p>{t('task.noProjects')}</p></div>
          ) : (
            <div className="task-launch-form">
              <div className="task-context">
                <div className="task-context-item">
                  <span className="eyebrow">{t('task.machine')}</span>
                  <strong><ServerIcon size={15} /><span className="truncate">{machineName}</span></strong>
                </div>
                <div className="task-context-item">
                  <span className="eyebrow">{t('task.agent')}</span>
                  <strong><span className="truncate">{agent?.label ?? config.backend}</span></strong>
                </div>
              </div>
              {otherAgents && <p className="subtle task-launch-note">{t('task.activeAgent')}</p>}

              <label className="field">
                <span>{t('task.project')}</span>
                <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                  {projects.map((project) => <option key={project.id} value={project.id}>{project.name} — {project.path}</option>)}
                </select>
              </label>

              {models.length > 0 && (
                <label className="field">
                  <span>{t('task.model')}</span>
                  <select value={String(modelIndex)} onChange={(event) => setModelIndex(Number(event.target.value))}>
                    <option value="-1">{t('task.modelDefault')}</option>
                    {models.map((option, index) => (
                      <option key={`${option.providerID}/${option.modelID}/${option.variant ?? ""}`} value={String(index)}>
                        {option.providerName} — {option.modelName}{option.variant ? ` (${option.variant})` : ""}
                      </option>
                    ))}
                  </select>
                  {modelStale && modelNotice && <span className="subtle">{modelNotice}</span>}
                </label>
              )}

              <label className="field">
                <span>{t('task.label')}</span>
                <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t('task.promptPlaceholder')} rows={6} autoFocus />
              </label>

              <div className="task-launch-worktree">
                <label className="task-launch-check">
                  <input type="checkbox" checked={isolated} onChange={(event) => setIsolated(event.target.checked)} disabled={selectedProject?.kind !== "git"} />
                  <span><FolderIcon size={15} />{t('task.isolatedWorktree')}</span>
                </label>
                {selectedProject?.kind !== "git" && <p className="subtle task-launch-note">{t('task.nonGit')}</p>}
              </div>
            </div>
          )}
        </div>

        <div className="wizard-footer">
          <span className="spacer" />
          <button type="button" className="btn-secondary" onClick={onClose}>{t('session.cancel')}</button>
          <button type="button" className="btn-primary" disabled={!canStart} onClick={() => void start()}>
            {starting ? <LoadingIcon size={15} /> : <PlayIcon size={15} />}
            {starting ? t('task.starting') : t('task.start')}
          </button>
        </div>
      </section>
    </div>
  )
}
