import { useEffect, useMemo, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { api } from "../api"
import {
  taskClient,
  type MachineTask,
  type MachineTaskRun,
  type TaskCheckpoint,
  type TaskWorkspaceInspection
} from "../taskClient"
import type { BackendKind, DiffFile, MachineAgentHost, ServerConfig } from "../types"
import { runSessionID, workThreadRuns } from "../work-thread-timeline"
import { LoadingIcon } from "../Icons"
import { WorkThreadConversation } from "./work-thread-conversation"

const REMARK_PLUGINS = [remarkGfm]

type DetailTab = "conversation" | "changes" | "result" | "history"

type Props = {
  task: MachineTask
  baseConfig: ServerConfig
  agents: MachineAgentHost[]
  machineName: string
  onTaskUpdate: (task: MachineTask) => void
  onWorkspaceRefresh?: () => void
}

function supportedBackend(value: string, fallback: BackendKind): BackendKind {
  return value === "opencode" || value === "omp" || value === "pi" || value === "claude" || value === "codex"
    ? value
    : fallback
}

function runAgent(task: MachineTask, run?: MachineTaskRun | null): string {
  return run?.agentId || task.agentId
}

function configForRun(base: ServerConfig, agents: MachineAgentHost[], task: MachineTask, run?: MachineTaskRun | null): ServerConfig {
  const agentID = runAgent(task, run)
  const agent = agents.find((candidate) => candidate.id === agentID)
  return { ...base, backend: supportedBackend(agent?.backend || agentID, base.backend), agentId: agentID }
}

function agentLabel(agents: MachineAgentHost[], id: string): string {
  return agents.find((agent) => agent.id === id)?.label || id || "Coding agent"
}

function modelLabel(run?: MachineTaskRun | null, task?: MachineTask): string {
  const model = run?.model ?? task?.model
  if (!model) return "Default model"
  return `${model.modelID}${model.variant ? ` · ${model.variant}` : ""}`
}

function titleFor(task: MachineTask): string {
  if (task.title?.trim()) return task.title.trim()
  const line = task.prompt.trim().split(/\r?\n/).find(Boolean)?.trim() || "Untitled Task"
  return line.length > 100 ? `${line.slice(0, 97)}...` : line
}

function isActive(task: MachineTask): boolean {
  return task.status === "starting" || task.status === "running"
}

function stateLabel(task: MachineTask, needsAttention = false): string {
  if (task.finishedAt) return "Done"
  if (needsAttention) return "Needs attention"
  if (isActive(task)) return "Working"
  if (task.status === "failed") return "Needs attention"
  if (task.status === "cancelled") return "Stopped"
  return "Ready"
}

function stateClass(task: MachineTask, needsAttention = false): string {
  if (task.finishedAt) return "done"
  if (needsAttention) return "attention"
  if (isActive(task)) return "working"
  if (task.status === "failed") return "failed"
  if (task.status === "cancelled") return "stopped"
  return "ready"
}

function formatDate(value?: string | null): string {
  if (!value) return ""
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed) : value
}

function checkpointForRun(checkpoints: TaskCheckpoint[], run: MachineTaskRun): TaskCheckpoint | undefined {
  return checkpoints.find((checkpoint) => checkpoint.runId && checkpoint.runId === run.id && checkpoint.kind === "after-run")
}

function ChangesPanel({ task, baseConfig, agents, revision }: { task: MachineTask; baseConfig: ServerConfig; agents: MachineAgentHost[]; revision: number }) {
  const [inspection, setInspection] = useState<TaskWorkspaceInspection | null>(null)
  const [diff, setDiff] = useState<DiffFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const run = task.run
    const session = runSessionID(run)
    const config = configForRun(baseConfig, agents, task, run)
    const directory = run?.directory || task.workspace.path
    void Promise.all([
      taskClient.inspectWorkspace(baseConfig, task.id),
      session ? api.loadDiff(config, session, directory).catch(() => []) : Promise.resolve([])
    ]).then(([nextInspection, nextDiff]) => {
      if (cancelled) return
      setInspection(nextInspection)
      setDiff(nextDiff)
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [task.id, task.updatedAt, revision])

  if (loading) return <div className="tdw-detail-loading"><LoadingIcon size={20} /> Loading changes...</div>
  if (error) return <div className="tdw-inline-error" role="alert">{error}</div>
  const changedFiles = inspection?.changedFiles ?? diff.map((file) => file.file)
  if (!inspection?.changeCount && diff.length === 0) return <div className="tdw-detail-empty"><strong>No workspace changes</strong><span>The Task has not changed files from its current baseline.</span></div>

  return (
    <div className="tdw-changes-panel">
      <div className="tdw-detail-summary-strip">
        <span><small>Changed files</small><strong>{inspection?.changeCount ?? diff.length}</strong></span>
        <span><small>Workspace</small><strong>{inspection?.dirty ? "Modified" : "Clean"}</strong></span>
      </div>
      {diff.length > 0 ? diff.map((file) => (
        <details className="tdw-diff-file" key={file.file} open={diff.length === 1}>
          <summary><strong>{file.file}</strong><span>+{file.additions} -{file.deletions}</span></summary>
          {file.patch ? <pre>{file.patch}</pre> : <p>Patch detail is not available from this coding agent.</p>}
        </details>
      )) : (
        <div className="tdw-file-list">
          {changedFiles.map((file) => <div key={file}><strong>{file}</strong></div>)}
        </div>
      )}
    </div>
  )
}

function ResultPanel({ task, agents, inspection, onDone, finishing }: {
  task: MachineTask
  agents: MachineAgentHost[]
  inspection: TaskWorkspaceInspection | null
  onDone: () => void
  finishing: boolean
}) {
  const latest = task.run
  const outcome = latest?.outcome || task.context?.latestOutcome?.text
  const error = task.error?.message || task.context?.latestOutcome?.error
  return (
    <div className="tdw-result-panel">
      <div className="tdw-result-hero">
        <span>Latest result</span>
        <h2>{task.finishedAt ? "Task marked done" : isActive(task) ? "Coding agent is still working" : task.status === "failed" ? "This step needs attention" : "Ready for your next instruction"}</h2>
        {outcome ? <div className="tdw-result-markdown td3-markdown"><ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{outcome}</ReactMarkdown></div> : error ? <p className="error">{error}</p> : <p>No natural-language result was recorded for the latest step. The conversation and workspace remain authoritative.</p>}
      </div>
      <div className="tdw-result-grid">
        <span><small>Status</small><strong>{stateLabel(task)}</strong></span>
        <span><small>Coding agent</small><strong>{agentLabel(agents, runAgent(task, latest))}</strong></span>
        <span><small>Model</small><strong>{modelLabel(latest, task)}</strong></span>
        <span><small>Changed files</small><strong>{inspection ? inspection.changeCount : "Open Changes"}</strong></span>
      </div>
      {!task.finishedAt ? (
        <div className="tdw-result-actions">
          <button type="button" className="tdw-button primary" disabled={isActive(task) || finishing} onClick={onDone}>{finishing ? "Marking done..." : "Mark done"}</button>
          <span>Marking done closes the Task workflow only. It does not delete the workspace or its history.</span>
        </div>
      ) : <div className="tdw-result-complete">Done {formatDate(task.finishedAt)}</div>}
    </div>
  )
}

function HistoryPanel({
  task,
  agents,
  restoring,
  checkpointing,
  onCheckpoint,
  onRestore
}: {
  task: MachineTask
  agents: MachineAgentHost[]
  restoring: string | null
  checkpointing: boolean
  onCheckpoint: () => void
  onRestore: (checkpoint: TaskCheckpoint) => void
}) {
  const runs = workThreadRuns(task)
  const checkpoints = task.checkpoints ?? []
  const baseline = checkpoints.find((checkpoint) => checkpoint.kind === "baseline")
  const extra = checkpoints.filter((checkpoint) => checkpoint.kind !== "baseline" && checkpoint.kind !== "after-run")

  return (
    <div className="tdw-history-panel">
      <div className="tdw-history-heading">
        <div><strong>Version history</strong><span>TaskDesk restore points preserve the coding workspace without exposing Git mechanics.</span></div>
        <button type="button" className="tdw-button secondary" disabled={isActive(task) || checkpointing || task.workspace.mode !== "worktree"} onClick={onCheckpoint}>{checkpointing ? "Saving..." : "Save checkpoint"}</button>
      </div>
      {baseline ? (
        <div className="tdw-history-item baseline">
          <div><span>Starting point</span><strong>{baseline.label}</strong><small>{formatDate(baseline.createdAt)}</small></div>
          <button type="button" className="tdw-button secondary" disabled={Boolean(restoring) || isActive(task)} onClick={() => onRestore(baseline)}>{restoring === baseline.id ? "Restoring..." : "Restore"}</button>
        </div>
      ) : null}
      {runs.map((run, index) => {
        const checkpoint = checkpointForRun(checkpoints, run)
        return (
          <div className="tdw-history-item" key={run.id || `${index}:${run.startedAt || ""}`}>
            <div className="tdw-history-step"><span>Step {run.sequence || index + 1}</span><strong>{agentLabel(agents, runAgent(task, run))} · {modelLabel(run, task)}</strong><small>{formatDate(run.startedAt)}{run.finishedAt ? ` to ${formatDate(run.finishedAt)}` : ""}</small></div>
            <div className="tdw-history-copy"><p>{run.prompt || (index === 0 ? task.prompt : "Continuation")}</p>{run.outcome ? <blockquote>{run.outcome}</blockquote> : null}</div>
            <span className={`tdw-history-status ${run.status || "unknown"}`}>{run.status || (run.finishedAt ? "completed" : "unknown")}</span>
            {checkpoint ? <button type="button" className="tdw-button secondary" disabled={Boolean(restoring) || isActive(task)} onClick={() => onRestore(checkpoint)}>{restoring === checkpoint.id ? "Restoring..." : "Restore this version"}</button> : <span className="tdw-history-no-restore">{task.workspace.mode === "worktree" && run.finishedAt ? "Restore point pending" : ""}</span>}
          </div>
        )
      })}
      {extra.map((checkpoint) => (
        <div className="tdw-history-item checkpoint" key={checkpoint.id}>
          <div><span>Checkpoint</span><strong>{checkpoint.label}</strong><small>{formatDate(checkpoint.createdAt)}{checkpoint.partial ? " · partial untracked-file snapshot" : ""}</small></div>
          <button type="button" className="tdw-button secondary" disabled={Boolean(restoring) || isActive(task)} onClick={() => onRestore(checkpoint)}>{restoring === checkpoint.id ? "Restoring..." : "Restore"}</button>
        </div>
      ))}
      {task.workspace.mode !== "worktree" ? <div className="tdw-detail-note">Restore points are available for TaskDesk-managed Git workspaces. This Task uses its project directory directly.</div> : null}
    </div>
  )
}

export function WorkThreadDetail({ task, baseConfig, agents, machineName, onTaskUpdate, onWorkspaceRefresh }: Props) {
  const [tab, setTab] = useState<DetailTab>("conversation")
  const [revision, setRevision] = useState(0)
  const [inspection, setInspection] = useState<TaskWorkspaceInspection | null>(null)
  const [finishing, setFinishing] = useState(false)
  const [checkpointing, setCheckpointing] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [needsAttention, setNeedsAttention] = useState(false)
  const runs = useMemo(() => workThreadRuns(task), [task.runs, task.run])
  const current = task.run

  useEffect(() => {
    setTab("conversation")
    setInspection(null)
    setError(null)
    setNeedsAttention(false)
  }, [task.id])

  useEffect(() => {
    if (tab !== "result") return
    let cancelled = false
    void taskClient.inspectWorkspace(baseConfig, task.id).then((value) => {
      if (!cancelled) setInspection(value)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [tab, task.id, task.updatedAt, revision])

  async function rename() {
    const next = window.prompt("Task title", titleFor(task))
    if (!next?.trim() || next.trim() === titleFor(task)) return
    setError(null)
    try { onTaskUpdate(await taskClient.renameWorkThread(baseConfig, task.id, next.trim())) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }

  async function markDone() {
    setFinishing(true)
    setError(null)
    try {
      const response = await taskClient.finish(baseConfig, task.id)
      onTaskUpdate(response.task)
      setInspection(response.result)
      onWorkspaceRefresh?.()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setFinishing(false) }
  }

  async function saveCheckpoint() {
    setCheckpointing(true)
    setError(null)
    try {
      const checkpoint = await taskClient.createCheckpoint(baseConfig, task.id, { label: `Saved ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date())}`, kind: "manual" })
      if (!checkpoint) throw new Error("This workspace does not support TaskDesk restore points.")
      onTaskUpdate(await taskClient.getWorkThread(baseConfig, task.id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setCheckpointing(false) }
  }

  async function restore(checkpoint: TaskCheckpoint) {
    if (!window.confirm(`Restore "${checkpoint.label}"? Current workspace changes will be snapshotted first when possible.`)) return
    setRestoring(checkpoint.id)
    setError(null)
    try {
      const response = await taskClient.restoreCheckpoint(baseConfig, task.id, checkpoint.id)
      onTaskUpdate(response.task)
      setRevision((value) => value + 1)
      onWorkspaceRefresh?.()
      setTab("changes")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally { setRestoring(null) }
  }

  return (
    <div className="tdw-detail">
      <header className="tdw-thread-header">
        <div className="tdw-thread-heading">
          <span>{task.project?.name || task.projectId}</span>
          <div className="tdw-thread-title-edit"><h1>{titleFor(task)}</h1><button type="button" onClick={() => void rename()} title="Rename Task">Rename</button></div>
          <p>{agentLabel(agents, runAgent(task, current))} · {modelLabel(current, task)} · {machineName}</p>
        </div>
        <span className={`tdw-live-state ${stateClass(task, needsAttention)}`}><i />{stateLabel(task, needsAttention)}</span>
      </header>

      <nav className="tdw-detail-tabs" aria-label="Task detail">
        <button type="button" className={tab === "conversation" ? "active" : ""} onClick={() => setTab("conversation")}>Conversation</button>
        <button type="button" className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>Changes</button>
        <button type="button" className={tab === "result" ? "active" : ""} onClick={() => setTab("result")}>Result</button>
        <button type="button" className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>History <span>{runs.length}</span></button>
      </nav>

      {error ? <div className="tdw-detail-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>×</button></div> : null}

      <div className="tdw-detail-body">
        {tab === "conversation" ? (
          <WorkThreadConversation
            key={task.id}
            task={task}
            baseConfig={baseConfig}
            agents={agents}
            onTaskUpdate={onTaskUpdate}
            onAttentionChange={setNeedsAttention}
            onWorkspaceRefresh={() => { setRevision((value) => value + 1); onWorkspaceRefresh?.() }}
          />
        ) : null}
        {tab === "changes" ? <ChangesPanel task={task} baseConfig={baseConfig} agents={agents} revision={revision} /> : null}
        {tab === "result" ? <ResultPanel task={task} agents={agents} inspection={inspection} onDone={() => void markDone()} finishing={finishing} /> : null}
        {tab === "history" ? <HistoryPanel task={task} agents={agents} restoring={restoring} checkpointing={checkpointing} onCheckpoint={() => void saveCheckpoint()} onRestore={(checkpoint) => void restore(checkpoint)} /> : null}
      </div>
    </div>
  )
}
