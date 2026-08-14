import { useEffect, useMemo, useState } from "react"
import { CloseIcon, FolderIcon, LoadingIcon, PlayIcon, ServerIcon } from "../Icons"
import { discoverMachineConnection, selectableMachineAgents } from "../machineClient"
import { loadActiveServerProfile, loadServerProfiles } from "../serverProfiles"
import { taskClient, type MachineProject } from "../taskClient"
import { api } from "../api"
import type { Translator } from "../i18n"
import type { MachineSnapshot, ModelOption, ServerConfig } from "../types"

/**
 * Which agent a task runs on is not a choice yet: the launched session has to open in the existing
 * session workflow, which is scoped to the active profile. New machine profiles carry `agentId`;
 * profiles migrated from before the daemon do not, so those resolve by backend instead.
 */
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
      try {
        const connection = await discoverMachineConnection(config)
        if (!connection) throw new Error(t('task.requiresDaemon'))
        const knownProjects = await taskClient.listProjects(connection.config)
        if (cancelled) return
        const active = activeProfileAgent(connection.machine, config)
        if (!active) throw new Error(t('task.agentUnavailable', { agent: config.agentId ?? config.backend }))
        // Models are an agent-scoped question, and not every agent answers it: ACP harnesses have
        // no model listing, so a failure here means "no choice to offer", not a broken dialog.
        const offered = await api
          .listModels({ ...connection.config, agentId: active.id })
          .catch(() => [] as ModelOption[])
        if (cancelled) return
        setModels(offered)
        setModelIndex(offered.findIndex((option) => option.isDefault))
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
              {/* Where the work will run. Both are decided by the active profile, so they are stated
                  rather than offered — a select holding one option reads as a choice that is not one. */}
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
