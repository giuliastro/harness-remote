import { useEffect, useMemo, useRef, useState } from "react"
import { continueNativeSessionAcrossMachine } from "../cross-machine-continuation"
import { reconcileCrossMachineProjectSelection } from "../cross-machine-project-selection"
import {
  loadCrossMachineProjectRoute,
  requireTargetRouteProject,
  type CrossMachineProjectRoute
} from "../cross-machine-route-projects"
import {
  planCrossMachineContinuation,
  type CrossMachineRoutePlan
} from "../cross-machine-route-plan"
import type { NativeSessionSurfaceTarget } from "../native-session-discovery"
import type { NativeSessionRouteMachine } from "../native-session-routing"
import { taskClient, type AgentModelScope } from "../taskClient"
import type { BackendKind, MachineAgentHost, ModelOption, ModelSelection, ServerConfig } from "../types"
import { ModelPicker, modelOptionKey } from "./model-picker"

const ROUTE_MODEL_SCOPE: AgentModelScope = {}

type Props = {
  source: NativeSessionSurfaceTarget
  routes: NativeSessionRouteMachine[]
  interactionEnabled: boolean
  onOpenSession: (target: NativeSessionSurfaceTarget) => void
  onSessionRefresh?: () => void
  onConnectionIssue?: () => void
}

function supportedBackend(value: string | undefined, fallback: BackendKind): BackendKind {
  return value === "opencode" || value === "omp" || value === "pi" || value === "claude" || value === "codex"
    ? value
    : fallback
}

function configForAgent(base: ServerConfig, agent: MachineAgentHost): ServerConfig {
  return {
    ...base,
    backend: supportedBackend(agent.backend, base.backend),
    agentId: agent.id
  }
}

function modelKey(model?: ModelSelection | null): string {
  return model ? modelOptionKey(model as ModelOption) : ""
}

function transportFailure(reason: unknown): boolean {
  return /cannot reach|timed out|network|connection|failed to fetch/i.test(reason instanceof Error ? reason.message : String(reason))
}

function planSummary(plan: CrossMachineRoutePlan | null, loading: boolean): string {
  if (loading) return "Verifying Project continuity…"
  if (!plan) return "Choose a target Project to verify the workspace before anything is created."
  if (plan.disposition === "blocked") {
    return "This Project does not match the source repository/history. Cross-machine continuation is blocked."
  }
  if (plan.disposition === "confirm") {
    if (plan.preflight.reason === "workspace_diverged") {
      return "The repository matches, but branch, HEAD or working-tree state differs. Review the target workspace before continuing."
    }
    return "Harness Remote cannot fully prove that the two workspaces are identical. Explicit confirmation is required."
  }
  return "Same repository, branch and HEAD verified; both worktrees are clean."
}

/**
 * Explicit cross-machine continuation surface.
 *
 * This is deliberately separate from the mature same-machine composer. Selection and planning are
 * read-only until Send: no target Session is created while browsing machines, Projects, harnesses or
 * models. The final orchestrator re-runs Project continuity immediately before mutation, so this UI
 * never turns a stale plan into authorization.
 */
export function CrossMachineContinuePanel({
  source,
  routes,
  interactionEnabled,
  onOpenSession,
  onSessionRefresh,
  onConnectionIssue
}: Props) {
  const availableRoutes = useMemo(
    () => routes.filter((route) => route.machineID !== source.machineID && route.agents.length > 0),
    [routes, source.machineID]
  )
  const [open, setOpen] = useState(false)
  const [machineID, setMachineID] = useState("")
  const [projectRoute, setProjectRoute] = useState<CrossMachineProjectRoute | null>(null)
  const [projectID, setProjectID] = useState("")
  const [agentID, setAgentID] = useState("")
  const [models, setModels] = useState<ModelOption[]>([])
  const [modelKeyValue, setModelKeyValue] = useState("")
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [planLoading, setPlanLoading] = useState(false)
  const [plan, setPlan] = useState<CrossMachineRoutePlan | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [prompt, setPrompt] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const projectGeneration = useRef(0)
  const projectMachineID = useRef("")
  const modelGeneration = useRef(0)
  const planGeneration = useRef(0)

  const machine = availableRoutes.find((candidate) => candidate.machineID === machineID)
  const agent = machine?.agents.find((candidate) => candidate.id === agentID)
  const selectedModel = models.find((candidate) => modelKey(candidate) === modelKeyValue)
  const modelRequired = agent?.capabilities?.models === true
  const modelReady = !modelRequired || (!modelsLoading && Boolean(selectedModel))
  const targetProject = projectRoute?.targetProjects.find((candidate) => candidate.id === projectID)
  const blocked = plan?.disposition === "blocked"
  const confirmationRequired = plan?.disposition === "confirm"
  const planReady = plan?.disposition === "ready" || (confirmationRequired && confirmed)
  const canSend = interactionEnabled
    && Boolean(machine && agent && targetProject)
    && modelReady
    && !projectsLoading
    && !modelsLoading
    && !planLoading
    && !blocked
    && planReady
    && Boolean(prompt.trim())
    && !sending

  useEffect(() => {
    if (!open || availableRoutes.length === 0) return
    if (availableRoutes.some((candidate) => candidate.machineID === machineID)) return
    setMachineID(availableRoutes[0].machineID)
  }, [open, availableRoutes, machineID])

  useEffect(() => {
    const generation = ++projectGeneration.current
    const preserveProjectSelection = Boolean(open && machine && machineID && projectMachineID.current === machineID)
    projectMachineID.current = open && machine ? machineID : ""
    setProjectRoute(null)
    setProjectID((current) => preserveProjectSelection ? current : "")
    setPlan(null)
    setConfirmed(false)
    setError(null)
    if (!open || !machine) {
      setProjectsLoading(false)
      return
    }
    setProjectsLoading(true)
    void loadCrossMachineProjectRoute({ source, targetMachine: machine })
      .then((route) => {
        if (projectGeneration.current !== generation) return
        setProjectRoute(route)
        setProjectID((current) => reconcileCrossMachineProjectSelection(
          current,
          route.targetProjects,
          preserveProjectSelection
        ))
      })
      .catch((reason) => {
        if (projectGeneration.current !== generation) return
        if (transportFailure(reason)) onConnectionIssue?.()
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (projectGeneration.current === generation) setProjectsLoading(false)
      })
  }, [open, machineID, machine, source.key, onConnectionIssue])

  useEffect(() => {
    const generation = ++modelGeneration.current
    setModels([])
    setModelKeyValue("")
    setPlan(null)
    setConfirmed(false)
    if (!open || !machine) {
      setAgentID("")
      setModelsLoading(false)
      return
    }

    const nextAgent = machine.agents.some((candidate) => candidate.id === agentID)
      ? machine.agents.find((candidate) => candidate.id === agentID)!
      : machine.agents[0]
    if (nextAgent.id !== agentID) {
      setAgentID(nextAgent.id)
      return
    }
    if (nextAgent.capabilities?.models !== true) {
      setModelsLoading(false)
      return
    }

    setModelsLoading(true)
    void taskClient.listAgentModels(configForAgent(machine.config, nextAgent), nextAgent.id, ROUTE_MODEL_SCOPE)
      .then((catalog) => {
        if (modelGeneration.current !== generation) return
        setModels(catalog.models)
        const fallback = catalog.models.find((candidate) => candidate.isDefault) || catalog.models[0]
        setModelKeyValue(fallback ? modelKey(fallback) : "")
      })
      .catch((reason) => {
        if (modelGeneration.current !== generation) return
        if (transportFailure(reason)) onConnectionIssue?.()
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (modelGeneration.current === generation) setModelsLoading(false)
      })
  }, [open, machineID, machine, agentID, onConnectionIssue])

  useEffect(() => {
    const generation = ++planGeneration.current
    setPlan(null)
    setConfirmed(false)
    if (!open || !machine || !agent || !projectID) {
      setPlanLoading(false)
      return
    }
    setPlanLoading(true)
    void planCrossMachineContinuation({
      source,
      targetMachine: machine,
      targetAgent: agent,
      targetProjectId: projectID
    })
      .then((next) => {
        if (planGeneration.current === generation) setPlan(next)
      })
      .catch((reason) => {
        if (planGeneration.current !== generation) return
        if (transportFailure(reason)) onConnectionIssue?.()
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (planGeneration.current === generation) setPlanLoading(false)
      })
  }, [open, machineID, agentID, projectID, machine, agent, source.key, onConnectionIssue])

  if (!availableRoutes.length) return null

  const submit = async () => {
    if (!canSend || !machine || !agent || !projectRoute || !targetProject || !plan) return
    setSending(true)
    setError(null)
    try {
      // Revalidate that the selected Project still belongs to this target catalog before crossing the
      // mutation boundary. The orchestrator then re-runs Git identity preflight once more.
      requireTargetRouteProject(machine.machineID, projectID, projectRoute.targetProjects)
      const model: ModelSelection | null = selectedModel
        ? { providerID: selectedModel.providerID, modelID: selectedModel.modelID, variant: selectedModel.variant }
        : null
      const result = await continueNativeSessionAcrossMachine({
        source,
        sourceProjectId: projectRoute.sourceProject.id,
        targetMachine: machine,
        targetProjectId: targetProject.id,
        targetAgent: agent,
        prompt: prompt.trim(),
        attachments: [],
        model,
        confirmedProjectContinuity: confirmationRequired && confirmed
      })
      setPrompt("")
      setConfirmed(false)
      onSessionRefresh?.()
      onOpenSession(result.target)
    } catch (reason) {
      if (transportFailure(reason)) onConnectionIssue?.()
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="hr-cross-machine-panel" aria-label="Continue on another machine">
      <button
        type="button"
        className="hr-cross-machine-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        disabled={!interactionEnabled || sending}
      >
        Continue on another machine
      </button>

      {open ? (
        <div className="hr-cross-machine-body">
          <div className="hr-cross-machine-fields">
            <label>
              <span>Machine</span>
              <select value={machineID} disabled={sending} onChange={(event) => {
                setMachineID(event.target.value)
                setAgentID("")
                setError(null)
              }}>
                {availableRoutes.map((route) => <option key={route.machineID} value={route.machineID}>{route.label}</option>)}
              </select>
            </label>

            <label>
              <span>Project</span>
              <select
                value={projectID}
                disabled={sending || projectsLoading || !projectRoute}
                onChange={(event) => { setProjectID(event.target.value); setError(null) }}
              >
                <option value="">{projectsLoading ? "Loading Projects…" : "Select Project…"}</option>
                {(projectRoute?.targetProjects || []).map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>

            <label>
              <span>Harness</span>
              <select value={agentID} disabled={sending || !machine} onChange={(event) => {
                setAgentID(event.target.value)
                setError(null)
              }}>
                {(machine?.agents || []).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
              </select>
            </label>

            <label>
              <span>Model</span>
              <ModelPicker
                compact
                models={models}
                value={modelKeyValue}
                onChange={setModelKeyValue}
                disabled={sending || modelsLoading || !agent || agent.capabilities?.models !== true}
                loading={modelsLoading}
                placeholder={agent?.capabilities?.models === true ? "Select model" : "Harness default"}
                unavailableHint={modelRequired && !modelsLoading && !models.length ? "No verified models available" : undefined}
              />
            </label>
          </div>

          <div className={`hr-cross-machine-preflight ${plan?.disposition || "idle"}`} role="status" aria-live="polite">
            <strong>{targetProject ? `${targetProject.name} on ${machine?.label || "target machine"}` : "Project verification"}</strong>
            <span>{planSummary(plan, planLoading)}</span>
            {confirmationRequired ? (
              <label className="hr-cross-machine-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={sending}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>I understand the target workspace differs and want to continue there.</span>
              </label>
            ) : null}
          </div>

          <label className="hr-cross-machine-prompt">
            <span>First message on the target Session</span>
            <textarea
              value={prompt}
              disabled={sending || blocked}
              rows={3}
              placeholder="Continue the work on this machine…"
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>

          {error ? <div className="tdw-chat-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>×</button></div> : null}

          <div className="hr-cross-machine-actions">
            <small>Attachments and source permissions are not transferred.</small>
            <button type="button" disabled={!canSend} onClick={() => void submit()}>
              {sending ? "Creating linked Session…" : "Continue on target machine"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
