const MAX_OUTCOME_CHARS = 6_000
const MAX_OBJECTIVE_CHARS = 12_000
const MAX_RUN_PROMPT_CHARS = 2_000
const MAX_ERROR_CHARS = 2_000
const MAX_CONTEXT_RUNS = 12
const MAX_CHANGED_FILES = 80
const MAX_CHANGED_FILE_CHARS = 500
const HANDOFF_OUTCOME_CHARS = 1_600
const HANDOFF_RECENT_RUNS = 6

function cleanText(value) {
  return typeof value === "string" ? value.trim() : ""
}

function boundedText(value, limit = MAX_OUTCOME_CHARS) {
  const text = cleanText(value)
  if (text.length <= limit) return text
  return `…${text.slice(-(limit - 1))}`
}

export function boundTaskOutcome(value) {
  return boundedText(value, MAX_OUTCOME_CHARS)
}

function cleanRole(value, fallback = "continue") {
  const normalized = cleanText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  return normalized || fallback
}

function runStatus(run, taskStatus) {
  const persisted = cleanText(run?.status)
  if (persisted) return persisted
  if (run?.finishedAt) return taskStatus === "failed" ? "failed" : "completed"
  return taskStatus || "unknown"
}

function runError(run) {
  if (typeof run?.error === "string") return boundedText(run.error, MAX_ERROR_CHARS)
  return boundedText(run?.error?.message, MAX_ERROR_CHARS)
}

export function summarizeTaskRun(run, taskStatus = "unknown") {
  if (!run || typeof run !== "object") return null
  const sequence = Number.isFinite(Number(run.sequence)) ? Number(run.sequence) : undefined
  const model = run.model && typeof run.model === "object"
    ? {
        providerID: cleanText(run.model.providerID),
        modelID: cleanText(run.model.modelID),
        ...(cleanText(run.model.variant) ? { variant: cleanText(run.model.variant) } : {})
      }
    : null
  const outcome = boundedText(run.outcome)
  const error = runError(run)
  return {
    ...(run.id ? { id: run.id } : {}),
    ...(sequence ? { sequence } : {}),
    agentId: cleanText(run.agentId),
    role: cleanRole(run.role, sequence === 1 ? "implement" : "continue"),
    ...(model?.providerID && model?.modelID ? { model } : {}),
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    status: runStatus(run, taskStatus),
    prompt: boundedText(run.prompt, MAX_RUN_PROMPT_CHARS),
    ...(outcome ? { outcome } : {}),
    ...(error ? { error } : {}),
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(Number.isFinite(Number(run.contextRevision)) ? { contextRevision: Number(run.contextRevision) } : {})
  }
}

export function buildPersistedTaskContext(task, revision = task?.context?.revision ?? 0) {
  const allRuns = Array.isArray(task?.runs) ? task.runs : task?.run ? [task.run] : []
  const recentRuns = allRuns.slice(-MAX_CONTEXT_RUNS)
  const runSummaries = recentRuns
    .map((run) => summarizeTaskRun(run, run?.id === task?.run?.id ? task?.status : run?.status || (run?.finishedAt ? "completed" : "unknown")))
    .filter(Boolean)
  const latestRun = task?.run ? summarizeTaskRun(task.run, task.status) : null
  const errorMessage = boundedText(task?.error?.message, MAX_ERROR_CHARS) || latestRun?.error || ""
  return {
    version: 1,
    revision: Math.max(0, Number(revision) || 0),
    taskId: task?.id || "",
    objective: boundedText(task?.prompt, MAX_OBJECTIVE_CHARS),
    currentState: cleanText(task?.status) || "draft",
    latestOutcome: latestRun
      ? {
          status: latestRun.status,
          agentId: latestRun.agentId,
          role: latestRun.role,
          ...(latestRun.outcome ? { text: latestRun.outcome } : {}),
          ...(errorMessage ? { error: errorMessage } : {})
        }
      : null,
    runSummaries
  }
}

export function buildTaskContext(task, { workspace } = {}) {
  const revision = Number.isFinite(Number(task?.context?.revision)) ? Number(task.context.revision) : 0
  const persisted = buildPersistedTaskContext(task, revision)
  const allRuns = Array.isArray(task?.runs) ? task.runs : task?.run ? [task.run] : []
  const allChangedFiles = Array.isArray(workspace?.changedFiles)
    ? workspace.changedFiles.filter((value) => typeof value === "string" && value.trim()).map((value) => boundedText(value, MAX_CHANGED_FILE_CHARS))
    : []
  const changedFiles = allChangedFiles.slice(0, MAX_CHANGED_FILES)
  return {
    ...persisted,
    runCount: allRuns.length,
    currentState: cleanText(task?.status) || persisted.currentState || "draft",
    latestRun: task?.run ? summarizeTaskRun(task.run, task.status) : null,
    changedFiles,
    workspace: {
      dirty: Boolean(workspace?.dirty),
      changeCount: Number(workspace?.changeCount) || allChangedFiles.length,
      listedChangeCount: changedFiles.length,
      truncated: allChangedFiles.length > changedFiles.length
    },
    restore: task?.restoredAt
      ? {
          at: task.restoredAt,
          checkpointId: cleanText(task?.restoredCheckpointId) || null
        }
      : null,
    verification: null,
    unresolved: []
  }
}

export function formatTaskHandoff(context, { targetAgentId, role, instruction }) {
  const lines = [
    "You are taking over an existing TaskDesk task.",
    "The context below was transferred by TaskDesk. It is not native conversational memory from another harness.",
    "",
    "TASK OBJECTIVE",
    boundedText(context.objective, MAX_OBJECTIVE_CHARS) || "(not recorded)",
    "",
    "CURRENT STATE",
    context.currentState || "unknown"
  ]

  const latest = context.latestRun || context.runSummaries?.at?.(-1)
  if (latest) lines.push("", "PREVIOUS STEP", `${latest.agentId || "unknown harness"} / ${latest.role || "continue"} / ${latest.status || "unknown"}`)
  if (context.latestOutcome?.text) lines.push("", "PREVIOUS RESULT", boundedText(context.latestOutcome.text, HANDOFF_OUTCOME_CHARS))
  if (context.latestOutcome?.error) lines.push("", "LATEST ERROR", boundedText(context.latestOutcome.error, MAX_ERROR_CHARS))
  if (context.restore?.at) {
    lines.push(
      "",
      "WORKSPACE RESTORE",
      `TaskDesk restored the shared workspace${context.restore.checkpointId ? ` to checkpoint ${context.restore.checkpointId}` : " to an earlier checkpoint"} at ${context.restore.at}.`,
      "The current files are authoritative. Native session memory may describe code from after the restored point, so inspect the workspace again before relying on remembered file state."
    )
  }
  if (context.changedFiles?.length) {
    lines.push("", "CHANGED FILES", ...context.changedFiles.map((file) => `- ${boundedText(file, MAX_CHANGED_FILE_CHARS)}`))
    if (context.workspace?.truncated) lines.push(`- …and ${Math.max(0, Number(context.workspace.changeCount) - context.changedFiles.length)} more changed file(s)`)
  } else if (context.workspace?.changeCount) {
    lines.push("", "WORKSPACE CHANGES", `${context.workspace.changeCount} changed file(s) are present in the shared workspace.`)
  }
  if (context.runSummaries?.length) {
    lines.push("", "RECENT TASK STEPS")
    for (const run of context.runSummaries.slice(-HANDOFF_RECENT_RUNS)) {
      lines.push(`- Run ${run.sequence || "?"}: ${run.agentId || "unknown"} / ${run.role || "continue"} / ${run.status || "unknown"}`)
      if (run.outcome) lines.push(`  Result: ${boundedText(run.outcome, HANDOFF_OUTCOME_CHARS)}`)
      if (run.error) lines.push(`  Error: ${boundedText(run.error, MAX_ERROR_CHARS)}`)
    }
    if (Number(context.runCount) > context.runSummaries.length) {
      lines.push(`- ${Number(context.runCount) - context.runSummaries.length} earlier Task step(s) retained in Task history but omitted from this handoff`)
    }
  }

  lines.push("", "YOUR ROLE", cleanRole(role), "", "TARGET HARNESS", cleanText(targetAgentId) || "unknown", "", "USER INSTRUCTION", cleanText(instruction), "", "Continue from the shared workspace and the transferred Task Context. Inspect the current files before assuming previous work is correct.")
  return lines.join("\n")
}
