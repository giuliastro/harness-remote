import { randomUUID } from "node:crypto"
import { boundTaskOutcome, buildTaskContext, formatTaskHandoff } from "./task-context.js"
import { taskLaunchError } from "./task-errors.js"
import { normalizeTaskModel } from "./task-model.js"
import { WorktreeManager } from "./worktree-manager.js"

const MAX_AGENT_ID_CHARS = 160
const MAX_ROLE_CHARS = 80
const MAX_CLIENT_REQUEST_ID_CHARS = 200

function taskRuns(task) {
  if (Array.isArray(task?.runs) && task.runs.length) return task.runs
  return task?.run ? [task.run] : []
}

function runAgent(task, run) {
  return run?.agentId || task?.agentId || ""
}

function latestRunForAgent(task, agentID, { requireSession = false } = {}) {
  const runs = taskRuns(task)
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]
    if (runAgent(task, run) !== agentID) continue
    if (requireSession && !run?.sessionId) continue
    return run
  }
  return null
}

function happenedAfter(value, baseline) {
  const timestamp = Date.parse(value || "")
  if (!Number.isFinite(timestamp)) return false
  const previous = Date.parse(baseline || "")
  return !Number.isFinite(previous) || timestamp > previous
}

function validateRunOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw taskLaunchError("invalid_request", "Task Run options must be an object")
  }
  if (Object.prototype.hasOwnProperty.call(options, "prompt") && typeof options.prompt !== "string") {
    throw taskLaunchError("invalid_request", "Task Run prompt must be a string")
  }
  if (Object.prototype.hasOwnProperty.call(options, "agentId")) {
    if (typeof options.agentId !== "string" || !options.agentId.trim()) {
      throw taskLaunchError("invalid_request", "Target harness must be a non-empty string")
    }
    if (options.agentId.trim().length > MAX_AGENT_ID_CHARS) {
      throw taskLaunchError("invalid_request", "Target harness identifier is too long")
    }
  }
  if (Object.prototype.hasOwnProperty.call(options, "role")) {
    if (typeof options.role !== "string" || !options.role.trim()) {
      throw taskLaunchError("invalid_request", "Task Run role must be a non-empty string")
    }
    if (options.role.trim().length > MAX_ROLE_CHARS) {
      throw taskLaunchError("invalid_request", "Task Run role is too long")
    }
  }
  if (Object.prototype.hasOwnProperty.call(options, "clientRequestId")) {
    if (typeof options.clientRequestId !== "string" || !options.clientRequestId.trim()) {
      throw taskLaunchError("invalid_request", "Client request id must be a non-empty string")
    }
    if (options.clientRequestId.trim().length > MAX_CLIENT_REQUEST_ID_CHARS) {
      throw taskLaunchError("invalid_request", "Client request id is too long")
    }
  }
  if (Object.prototype.hasOwnProperty.call(options, "model") && options.model !== null && !normalizeTaskModel(options.model)) {
    throw taskLaunchError("invalid_request", "Task Run model is malformed")
  }
  if (Object.prototype.hasOwnProperty.call(options, "fresh") && typeof options.fresh !== "boolean") {
    throw taskLaunchError("invalid_request", "Task Run fresh flag must be boolean")
  }
  if (Object.prototype.hasOwnProperty.call(options, "mode") && !["fresh", "resume"].includes(options.mode)) {
    throw taskLaunchError("invalid_request", "Task Run mode must be fresh or resume")
  }
}

function requestedAgent(task, options = {}) {
  const explicit = typeof options.agentId === "string" ? options.agentId.trim() : ""
  return explicit || runAgent(task, task.run)
}

function requestedModel(task, targetAgent, options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, "model")) return normalizeTaskModel(options.model)
  const priorTargetRun = latestRunForAgent(task, targetAgent)
  if (priorTargetRun?.model) return normalizeTaskModel(priorTargetRun.model)
  if (targetAgent === task.agentId) return normalizeTaskModel(task.model)
  return null
}

function requestedRole(task, options = {}) {
  const explicit = typeof options.role === "string" ? options.role.trim() : ""
  if (explicit) return explicit
  return task.run ? "continue" : "implement"
}

function completedRun(run, result) {
  const outcome = boundTaskOutcome(result?.outcome)
  return outcome ? { ...run, outcome, outcomeVersion: 2 } : run
}

function sessionUnavailable(error) {
  return error?.code === "session_unavailable"
}

export class TaskRunController {
  constructor({ taskStore, taskLauncher, worktreeManager, acpService, runIDFactory = randomUUID, clock = () => new Date().toISOString() }) {
    this.taskStore = taskStore
    this.taskLauncher = taskLauncher
    this.worktreeManager = worktreeManager ?? (taskStore?.stateDirectory ? new WorktreeManager({ stateDirectory: taskStore.stateDirectory }) : undefined)
    this.acpService = acpService
    this.runIDFactory = runIDFactory
    this.clock = clock
    this.reconciliationError = null
    this.reconciliation = (typeof taskStore?.list === "function" ? this.reconcileAll() : Promise.resolve())
      .catch((error) => { this.reconciliationError = error })
  }

  async #awaitReconciliation() {
    await this.reconciliation
    if (this.reconciliationError) throw taskLaunchError("agent_unavailable", "Task state is unavailable", { cause: this.reconciliationError })
  }

  async #terminal(taskID, run, status, error = null, result = null) {
    const terminalRun = status === "completed" ? completedRun(run, result) : run
    try { await this.taskStore.setRunState(taskID, { status, run: terminalRun, error, expectedRunId: run?.id }) } catch {}
  }

  async #adoptAcpTaskSession(task) {
    if (!task.run?.sessionId || task.run.transport !== "acp") return null
    const agentID = runAgent(task, task.run)
    const service = this.acpService?.(agentID)
    if (!service) return null
    const title = task.prompt?.trim().split("\n")[0].slice(0, 60)
    try {
      return await service.adoptTaskSession(task.run.sessionId, { title, prompt: task.run?.prompt || task.prompt })
    } catch {
      return null
    }
  }

  async #contextForTask(task) {
    let workspace = { managed: task.workspace?.mode === "worktree", dirty: false, changeCount: 0, changedFiles: [] }
    if (!this.worktreeManager) return buildTaskContext(task, { workspace })
    try {
      if (task.workspace?.mode === "worktree") {
        workspace = await this.worktreeManager.inspect(task.workspace)
      } else if (task.workspace?.mode === "project" && task.project?.kind === "git" && typeof this.worktreeManager.inspectProject === "function") {
        workspace = await this.worktreeManager.inspectProject(task.workspace.path || task.project.path)
      }
    } catch {
      // Context remains useful even when Git state cannot be inspected temporarily.
    }
    return buildTaskContext(task, { workspace })
  }

  async reconcileAll() {
    for (const task of await this.taskStore.list()) {
      if (!["starting", "running"].includes(task.status)) continue
      const adoptedAcpSession = await this.#adoptAcpTaskSession(task)
      if (!task.run?.id) {
        try { await this.taskStore.setRunState(task.id, { status: "failed", error: new Error("Active task has no persisted run identity") }) } catch {}
        continue
      }
      if (task.run.transport === "acp" && adoptedAcpSession === false) {
        await this.#terminal(task.id, task.run, "failed", new Error("Task session is no longer available after daemon restart"))
        continue
      }
      let state = "unknown"
      try { state = await this.taskLauncher.inspectRun?.(task) ?? "unknown" } catch {}
      if (state === "completed") await this.#terminal(task.id, task.run, "completed")
      else if (state === "failed") await this.#terminal(task.id, task.run, "failed", new Error("Task run could not be confirmed after daemon restart"))
    }
  }

  async context(taskID) {
    await this.#awaitReconciliation()
    const task = await this.taskStore.get(taskID)
    if (!task) throw taskLaunchError("unknown_task", `Unknown task: ${taskID}`)
    return this.#contextForTask(task)
  }

  async inspectWorkspace(taskID) {
    await this.#awaitReconciliation()
    const task = await this.taskStore.get(taskID)
    if (!task) throw taskLaunchError("unknown_task", `Unknown task: ${taskID}`)
    if (!this.worktreeManager) {
      if (task.workspace?.mode === "worktree") throw new Error("Worktree manager is not configured")
      return { managed: false, dirty: false, changeCount: 0, changedFiles: [] }
    }
    if (task.workspace?.mode === "worktree") return this.worktreeManager.inspect(task.workspace)
    if (task.workspace?.mode === "project" && task.project?.kind === "git" && typeof this.worktreeManager.inspectProject === "function") {
      return this.worktreeManager.inspectProject(task.workspace.path || task.project.path)
    }
    return { managed: false, dirty: false, changeCount: 0, changedFiles: [] }
  }

  async cleanupWorkspace(taskID) {
    await this.#awaitReconciliation()
    const task = await this.taskStore.get(taskID)
    if (!task) throw taskLaunchError("unknown_task", `Unknown task: ${taskID}`)
    if (task.status === "starting" || task.status === "running") throw taskLaunchError("task_active", "An active task cannot release its workspace")
    if (task.workspace?.mode !== "worktree") return { task, cleanup: { removed: false, branchDeleted: false } }
    if (!this.worktreeManager) throw new Error("Worktree manager is not configured")
    const cleanup = await this.worktreeManager.cleanup(task.workspace)
    const updated = await this.taskStore.clearWorkspace(taskID)
    return { task: updated, cleanup }
  }

  async launch(taskID, options = {}) {
    validateRunOptions(options)
    await this.#awaitReconciliation()
    const task = await this.taskStore.get(taskID)
    if (!task) throw taskLaunchError("unknown_task", `Unknown task: ${taskID}`)
    if (!["draft", "completed", "failed", "cancelled"].includes(task.status)) throw taskLaunchError("invalid_state", "Only draft or terminal tasks can start a run")
    if (!task.workspace?.path) throw taskLaunchError("workspace_required", "Task workspace is not prepared")

    const requestedPrompt = typeof options.prompt === "string" ? options.prompt.trim() : ""
    const userPrompt = requestedPrompt || task.prompt
    if (!userPrompt) throw taskLaunchError("invalid_state", "A run prompt is required")

    const previousRun = task.run ? structuredClone(task.run) : null
    const agentID = requestedAgent(task, options)
    if (!agentID) throw taskLaunchError("unknown_agent", "A target harness is required")
    const model = requestedModel(task, agentID, options)
    const role = requestedRole(task, options)
    const clientRequestId = typeof options.clientRequestId === "string" ? options.clientRequestId.trim() : ""
    const requestedReuseSession = options.reuseSession === true
    const reusableRun = requestedReuseSession ? latestRunForAgent(task, agentID, { requireSession: true }) : null
    if (requestedReuseSession && !reusableRun) throw taskLaunchError("session_unavailable", "The requested native Session cannot be reused for this Run")

    const directNativeContinuation = Boolean(reusableRun && previousRun && reusableRun.id === previousRun.id)
    const restoredAfterReusableRun = Boolean(
      reusableRun && happenedAfter(task.restoredAt, reusableRun.finishedAt || reusableRun.startedAt)
    )
    let reuseSession = requestedReuseSession
    let needsHandoffContext = Boolean(previousRun && (!reuseSession || !directNativeContinuation || restoredAfterReusableRun))
    let effectivePrompt = userPrompt

    const previousRunCount = taskRuns(task).length
    const baseRun = {
      id: this.runIDFactory(),
      sequence: previousRunCount + 1,
      agentId: agentID,
      model,
      role,
      ...(clientRequestId ? { clientRequestId } : {}),
      // Persist acceptance before model discovery or Git/context inspection. The real revision is
      // kept in local run state until the native Session is linked, while the same run id remains authoritative.
      contextRevision: 0,
      sessionId: null,
      transport: null,
      directory: task.workspace.path,
      prompt: userPrompt,
      startedAt: this.clock()
    }
    const runForContinuity = () => ({
      ...baseRun,
      ...(needsHandoffContext ? { handoffFromRunId: previousRun?.id ?? null } : {}),
      ...(reuseSession && reusableRun ? { resumedFromRunId: reusableRun.id ?? null } : {}),
      ...(restoredAfterReusableRun && reuseSession ? { handoffReason: "workspace_restore", workspaceRestoredAt: task.restoredAt } : {})
    })

    let run = runForContinuity()
    // This write is the transport acceptance boundary. Once it succeeds, a client that loses the
    // HTTP response can reconnect and observe the new run instead of resending an ambiguous prompt.
    let current = await this.taskStore.setRunState(taskID, { status: "starting", run })
    // A concurrent/retried mutation with the same clientRequestId is returned by the store as the
    // already-accepted Run. Never continue native Session creation for the losing duplicate call.
    if (current.run?.id !== baseRun.id) return current
    const currentForRun = () => ({
      ...current,
      agentId: agentID,
      model,
      prompt: effectivePrompt,
      run: { ...run, agentId: agentID, model }
    })

    try {
      await this.taskLauncher.validateModelSelection?.(agentID, model)
      const context = await this.#contextForTask(task)
      effectivePrompt = needsHandoffContext
        ? formatTaskHandoff(context, { targetAgentId: agentID, role, instruction: userPrompt })
        : userPrompt
      run = { ...run, contextRevision: Number(context.revision) || 0 }

      let session
      if (reuseSession) {
        try {
          session = await this.taskLauncher.resumeSession(currentForRun(), reusableRun)
        } catch (error) {
          // Normal TaskDesk conversation follows the best available continuity path. A persisted
          // native Session can disappear after a harness restart or history cleanup; that should not
          // surface as a Session-id error to the product user. Explicit Advanced `mode: resume`
          // remains strict and still reports the missing Session.
          if (!sessionUnavailable(error) || options.mode === "resume") throw error
          reuseSession = false
          needsHandoffContext = Boolean(previousRun)
          effectivePrompt = needsHandoffContext
            ? formatTaskHandoff(context, { targetAgentId: agentID, role, instruction: userPrompt })
            : userPrompt
          run = {
            ...runForContinuity(),
            contextRevision: Number(context.revision) || 0,
            ...(previousRun ? { handoffReason: "session_unavailable" } : {})
          }
          session = await this.taskLauncher.createSession(currentForRun())
        }
      } else {
        session = await this.taskLauncher.createSession(currentForRun())
      }

      const linkedRun = { ...run, sessionId: session.sessionId, transport: session.transport }
      run = linkedRun
      current = await this.taskStore.setRunState(taskID, { status: "starting", run: linkedRun, expectedRunId: baseRun.id })
      current = await this.taskStore.setRunState(taskID, { status: "running", run: linkedRun, expectedRunId: linkedRun.id })
      const onFailed = (error) => void this.#terminal(taskID, linkedRun, "failed", error)
      onFailed.onFailed = onFailed
      onFailed.onCompleted = (result) => void this.#terminal(taskID, linkedRun, "completed", null, result)
      await this.taskLauncher.startPrompt(currentForRun(), session, onFailed)
      return current
    } catch (error) {
      await this.#terminal(taskID, run, "failed", error)
      throw error
    }
  }

  async continue(taskID, input) {
    const options = typeof input === "string" ? { prompt: input } : input && typeof input === "object" && !Array.isArray(input) ? input : {}
    validateRunOptions(options)
    const text = typeof options.prompt === "string" ? options.prompt.trim() : ""
    if (!text) throw taskLaunchError("invalid_state", "A continuation prompt is required")
    await this.#awaitReconciliation()
    const task = await this.taskStore.get(taskID)
    if (!task) throw taskLaunchError("unknown_task", `Unknown task: ${taskID}`)
    const clientRequestId = typeof options.clientRequestId === "string" ? options.clientRequestId.trim() : ""
    if (clientRequestId && taskRuns(task).some((run) => run?.clientRequestId === clientRequestId)) {
      return task
    }
    if (!["completed", "failed", "cancelled"].includes(task.status)) throw taskLaunchError("invalid_state", "Only a terminal task can start another run")

    const agentID = requestedAgent(task, options)
    const explicitFresh = options.mode === "fresh" || options.fresh === true
    const explicitResume = options.mode === "resume"
    const reusableRun = latestRunForAgent(task, agentID, { requireSession: true })
    if (explicitResume && !reusableRun) {
      throw taskLaunchError("session_unavailable", "No native Session for the selected harness can be resumed. Start a fresh Run instead.")
    }
    const reuseSession = !explicitFresh && Boolean(reusableRun)

    // Ordinary TaskDesk continuation is best-effort continuity. If the harness no longer has a
    // resumable native Session, launch() creates a fresh Session and transfers persisted Task context.
    // Only explicit Advanced mode=resume is strict about requiring the old native Session.
    return this.launch(taskID, { ...options, prompt: text, agentId: agentID, reuseSession })
  }
}