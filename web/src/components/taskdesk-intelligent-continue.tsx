import { useEffect, useMemo, useRef, useState, type ComponentType } from "react"
import type { LanguageCode } from "../i18n"
import {
  taskClient,
  type MachineTask,
  type MachineTaskRun,
  type TaskContext
} from "../taskClient"
import { taskDeskContinueCopy } from "../taskdesk-continue-i18n"
import type { TaskDeskTranslator } from "../taskdesk-i18n"
import type { MachineAgentHost, ModelOption, ModelSelection } from "../types"
import type { WorkspaceMachine } from "../workspaceMachines"
import { LoadingIcon } from "../Icons"
import "../taskdesk-continue.css"

type ContinueRecord = {
  runtime: {
    machine: WorkspaceMachine
    agents: MachineAgentHost[]
  }
  task: MachineTask & { finishedAt?: string | null }
}

type Props = {
  record: ContinueRecord
  language: LanguageCode
  t: TaskDeskTranslator
  onClose: () => void
  onContinued: (task: MachineTask) => void
  legacyFallback?: ComponentType<any>
}

const ROLE_OPTIONS = ["continue", "review", "test", "debug", "refactor", "investigate", "custom"] as const
type RoleOption = typeof ROLE_OPTIONS[number]

function runSessionID(run?: MachineTaskRun | null): string | null {
  return run?.sessionId || run?.sessionID || null
}

function taskRuns(task: MachineTask): MachineTaskRun[] {
  if (Array.isArray(task.runs) && task.runs.length) return task.runs
  return task.run ? [task.run] : []
}

function runAgent(task: MachineTask, run: MachineTaskRun): string {
  return run.agentId || task.agentId
}

function latestReusableRun(task: MachineTask, agentID: string): MachineTaskRun | null {
  const runs = taskRuns(task)
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]
    if (runAgent(task, run) === agentID && runSessionID(run)) return run
  }
  return null
}

function latestModelForAgent(task: MachineTask, agentID: string): ModelSelection | null {
  const runs = taskRuns(task)
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]
    if (runAgent(task, run) === agentID && run.model) return run.model
  }
  return agentID === task.agentId ? task.model || null : null
}

function modelKey(model: Pick<ModelSelection, "providerID" | "modelID" | "variant">): string {
  return `${model.providerID}|${model.modelID}|${model.variant || ""}`
}

function selectedModel(models: ModelOption[], key: string): ModelOption | undefined {
  return models.find((model) => modelKey(model) === key)
}

function roleLabel(role: RoleOption, copy: ReturnType<typeof taskDeskContinueCopy>): string {
  if (role === "continue") return copy.roleContinue
  if (role === "review") return copy.roleReview
  if (role === "test") return copy.roleTest
  if (role === "debug") return copy.roleDebug
  if (role === "refactor") return copy.roleRefactor
  if (role === "investigate") return copy.roleInvestigate
  return copy.roleCustom
}

export function IntelligentContinueTaskModal({
  record,
  language,
  t,
  onClose,
  onContinued,
  legacyFallback: LegacyFallback
}: Props) {
  const copy = useMemo(() => taskDeskContinueCopy(language), [language])
  const initialAgentID = record.task.run?.agentId || record.task.agentId || record.runtime.agents[0]?.id || ""
  const [agentID, setAgentID] = useState(initialAgentID)
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelKeyValue, setModelKeyValue] = useState("")
  const [modelsLoading, setModelsLoading] = useState(false)
  const [context, setContext] = useState<TaskContext | null>(null)
  const [contextLoading, setContextLoading] = useState(true)
  const [contextError, setContextError] = useState<string | null>(null)
  const [legacyMode, setLegacyMode] = useState(false)
  const [role, setRole] = useState<RoleOption>("continue")
  const [customRole, setCustomRole] = useState("")
  const [mode, setMode] = useState<"resume" | "fresh">(() => latestReusableRun(record.task, initialAgentID) ? "resume" : "fresh")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [prompt, setPrompt] = useState("")
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const modelGeneration = useRef(0)

  const reusableRun = useMemo(() => latestReusableRun(record.task, agentID), [record.task, agentID])
  const reusableSessionID = runSessionID(reusableRun)
  const selectedAgent = useMemo(
    () => record.runtime.agents.find((agent) => agent.id === agentID) || null,
    [record.runtime.agents, agentID]
  )
  const targetAgentAvailable = Boolean(
    selectedAgent && (selectedAgent.state === "available" || selectedAgent.state === "configured")
  )

  useEffect(() => {
    let cancelled = false
    setContextLoading(true)
    setContextError(null)
    void taskClient.loadContext(record.runtime.machine.config, record.task.id).then((loaded) => {
      if (!cancelled) setContext(loaded)
    }).catch((reason) => {
      if (cancelled) return
      const message = reason instanceof Error ? reason.message : String(reason)
      const compatibleFallback = /HTTP 404|incompatible response/i.test(message)
      if (compatibleFallback && LegacyFallback) setLegacyMode(true)
      else setContextError(message)
    }).finally(() => {
      if (!cancelled) setContextLoading(false)
    })
    return () => { cancelled = true }
  }, [record.runtime.machine.id, record.task.id, LegacyFallback])

  useEffect(() => {
    if (!agentID) {
      setModels([])
      setModelKeyValue("")
      return
    }
    const generation = ++modelGeneration.current
    const preferredModel = latestModelForAgent(record.task, agentID)
    setModelsLoading(true)
    setError(null)
    void taskClient.listAgentModels(record.runtime.machine.config, agentID).then((catalog) => {
      if (generation !== modelGeneration.current) return
      setModels(catalog.models)
      const preferred = preferredModel
        ? catalog.models.find((model) => model.providerID === preferredModel.providerID
          && model.modelID === preferredModel.modelID
          && (model.variant || "") === (preferredModel.variant || ""))
        : undefined
      const next = preferred || catalog.models.find((model) => model.isDefault) || catalog.models[0]
      setModelKeyValue(next ? modelKey(next) : "")
    }).catch((reason) => {
      if (generation !== modelGeneration.current) return
      setModels([])
      setModelKeyValue("")
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (generation === modelGeneration.current) setModelsLoading(false)
    })
  }, [record.runtime.machine.id, record.task.id, agentID])

  useEffect(() => {
    setMode(reusableRun ? "resume" : "fresh")
  }, [agentID, reusableRun?.id, reusableSessionID])

  if (legacyMode && LegacyFallback) {
    return <LegacyFallback record={record} t={t} onClose={onClose} onContinued={onContinued} />
  }

  const model = selectedModel(models, modelKeyValue)
  const roleValue = role === "custom" ? customRole.trim() : role
  const canStart = Boolean(
    prompt.trim()
    && agentID
    && targetAgentAvailable
    && roleValue
    && !working
    && !modelsLoading
    && !contextLoading
    && context
    && (mode === "fresh" || reusableRun)
  )
  const taskHeading = record.task.prompt.split(/\r?\n/, 1)[0]?.trim() || t("continue.title")
  const settingsSummary = [
    selectedAgent?.label || copy.targetHarness,
    model?.modelName || (modelsLoading ? t("model.loading") : t("model.agentDefault")),
    roleLabel(role, copy),
    mode === "resume" ? copy.reuseSession : copy.freshSession
  ].join(" · ")

  async function submit() {
    if (!canStart) return
    setWorking(true)
    setError(null)
    try {
      const input = {
        prompt: prompt.trim(),
        agentId: agentID,
        role: roleValue,
        mode,
        ...(model ? { model: { providerID: model.providerID, modelID: model.modelID, variant: model.variant } } : {})
      } as const
      onContinued(await taskClient.continueTask(record.runtime.machine.config, record.task.id, input))
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="td3-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="td3-modal td3-intelligent-continue"
        role="dialog"
        aria-modal="true"
        aria-label={t("continue.title")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div className="td3-continue-heading">
            <small>{t("continue.eyebrow")}</small>
            <h2>{taskHeading}</h2>
            <p>{t("continue.title")}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t("nav.close")} title={t("nav.close")}>×</button>
        </header>

        <div className="td3-modal-body td3-continue-grid">
          <section className={`td3-continue-settings${settingsOpen ? " open" : ""}`}>
            <div className="td3-continue-settings-summary">
              <div>
                <small>{copy.runSettings}</small>
                <strong>{selectedAgent?.label || copy.targetHarness}</strong>
                <span>{settingsSummary}</span>
              </div>
              <button
                type="button"
                className="td3-continue-settings-toggle"
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen((value) => !value)}
              >
                {settingsOpen ? copy.hideSettings : copy.editSettings}
              </button>
            </div>

            {settingsOpen ? (
              <div className="td3-continue-settings-body">
                <label>
                  <span>{copy.targetHarness}</span>
                  <select value={agentID} onChange={(event) => setAgentID(event.target.value)}>
                    {record.runtime.agents.map((agent) => (
                      <option
                        key={agent.id}
                        value={agent.id}
                        disabled={agent.state !== "available" && agent.state !== "configured"}
                      >
                        {agent.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>{copy.targetModel}</span>
                  <select value={modelKeyValue} onChange={(event) => setModelKeyValue(event.target.value)} disabled={modelsLoading || models.length === 0}>
                    {modelsLoading ? <option value="">{t("model.loading")}</option> : null}
                    {!modelsLoading && models.length === 0 ? <option value="">{t("model.agentDefault")}</option> : null}
                    {models.map((candidate) => (
                      <option key={modelKey(candidate)} value={modelKey(candidate)}>
                        {candidate.modelName}{candidate.variant ? ` (${candidate.variant})` : ""}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>{copy.role}</span>
                  <select value={role} onChange={(event) => setRole(event.target.value as RoleOption)}>
                    {ROLE_OPTIONS.map((candidate) => <option key={candidate} value={candidate}>{roleLabel(candidate, copy)}</option>)}
                  </select>
                </label>

                <label>
                  <span>{copy.sessionStrategy}</span>
                  <select value={mode} onChange={(event) => setMode(event.target.value as "resume" | "fresh")}>
                    {reusableRun ? <option value="resume">{copy.reuseSession}</option> : null}
                    <option value="fresh">{copy.freshSession}</option>
                  </select>
                </label>

                {role === "custom" ? (
                  <label className="td3-continue-wide">
                    <span>{copy.customRole}</span>
                    <input value={customRole} onChange={(event) => setCustomRole(event.target.value.slice(0, 80))} maxLength={80} />
                  </label>
                ) : null}

                {!targetAgentAvailable ? <div className="td3-inline-warning td3-continue-wide">{copy.targetUnavailable}</div> : null}
                {!reusableRun ? <div className="td3-inline-warning td3-continue-wide">{copy.noReusableSession}</div> : null}
                {reusableSessionID ? <p className="td3-continue-model-note td3-continue-wide">{copy.reuseSession}: {reusableSessionID}</p> : null}
              </div>
            ) : null}
          </section>

          <details className="td3-continue-context" open>
            <summary>
              <strong>{copy.contextTitle}</strong>
              <span>{context ? `${copy.contextRevision} ${context.revision}` : copy.contextLoading}</span>
            </summary>
            <div className="td3-continue-context-body">
              <p className="td3-continue-context-note">{copy.transferredContext}</p>
              {contextLoading ? <div className="td3-detail-loading"><LoadingIcon size={18} /><strong>{copy.contextLoading}</strong></div> : null}
              {contextError ? <div className="td3-inline-error" role="alert">{contextError}</div> : null}
              {context ? (
                <>
                  <div className="td3-continue-context-section">
                    <small>{copy.objective}</small>
                    <p>{context.objective}</p>
                  </div>
                  <div className="td3-continue-context-section">
                    <small>{copy.currentState}</small>
                    <p>{context.currentState}</p>
                  </div>
                  {context.latestOutcome ? (
                    <div className="td3-continue-context-section">
                      <small>{copy.latestOutcome}</small>
                      <p>{context.latestOutcome.text || context.latestOutcome.error || `${context.latestOutcome.agentId} / ${context.latestOutcome.status}`}</p>
                    </div>
                  ) : null}
                  <div className="td3-continue-context-section">
                    <small>{copy.changedFiles} ({context.workspace.changeCount})</small>
                    {context.changedFiles.length ? (
                      <div className="td3-continue-file-list">
                        {context.changedFiles.slice(0, 12).map((file) => <code key={file}>{file}</code>)}
                        {context.workspace.truncated ? <span>+{Math.max(0, context.workspace.changeCount - context.changedFiles.length)}</span> : null}
                      </div>
                    ) : <p>{copy.noChanges}</p>}
                  </div>
                  <div className="td3-continue-context-section">
                    <small>{copy.recentRuns} ({context.runCount})</small>
                    <div className="td3-continue-run-list">
                      {context.runSummaries.slice(-6).reverse().map((run, index) => (
                        <span key={run.id || `${run.sequence || index}-${run.agentId}`}>
                          #{run.sequence || "?"} {run.agentId} / {run.role} / {run.status}{run.outcome ? `: ${run.outcome.slice(0, 180)}` : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          </details>

          <label className="td3-continue-wide td3-continue-prompt">
            <span>{t("continue.prompt")}</span>
            <textarea rows={5} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t("continue.placeholder")} />
          </label>

          {error ? <div className="td3-inline-error td3-continue-wide" role="alert">{error}</div> : null}
        </div>

        <footer>
          <button type="button" className="td3-button" onClick={onClose}>{t("action.cancel")}</button>
          <button type="button" className="td3-button primary" disabled={!canStart} onClick={() => void submit()}>
            {working ? <LoadingIcon size={15} /> : null}
            {working ? t("continue.starting") : t("continue.start")}
          </button>
        </footer>
      </section>
    </div>
  )
}
