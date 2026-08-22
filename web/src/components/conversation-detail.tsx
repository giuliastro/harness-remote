import { useEffect, useMemo, useState } from "react"
import { api } from "../api"
import {
  taskClient,
  type MachineTask,
  type MachineTaskRun,
  type TaskWorkspaceInspection
} from "../taskClient"
import type { BackendKind, DiffFile, MachineAgentHost, ServerConfig } from "../types"
import { runSessionID, workThreadRuns } from "../work-thread-timeline"
import { LoadingIcon } from "../Icons"
import { WorkThreadConversation } from "./work-thread-conversation"

type DetailTab = "chat" | "sessions" | "changes"

type Props = {
  conversation: MachineTask
  baseConfig: ServerConfig
  agents: MachineAgentHost[]
  machineName: string
  onConversationUpdate: (conversation: MachineTask) => void
  onWorkspaceRefresh?: () => void
}

type NativeSessionRecord = {
  id: string
  run: MachineTaskRun
  agentID: string
  index: number
}

function supportedBackend(value: string, fallback: BackendKind): BackendKind {
  return value === "opencode" || value === "omp" || value === "pi" || value === "claude" || value === "codex"
    ? value
    : fallback
}

function runAgent(conversation: MachineTask, run?: MachineTaskRun | null): string {
  return run?.agentId || conversation.agentId
}

function configForRun(base: ServerConfig, agents: MachineAgentHost[], conversation: MachineTask, run?: MachineTaskRun | null): ServerConfig {
  const agentID = runAgent(conversation, run)
  const agent = agents.find((candidate) => candidate.id === agentID)
  return { ...base, backend: supportedBackend(agent?.backend || agentID, base.backend), agentId: agentID }
}

function agentLabel(agents: MachineAgentHost[], id: string): string {
  return agents.find((agent) => agent.id === id)?.label || id || "Coding agent"
}

function agentBackend(agents: MachineAgentHost[], id: string): string {
  return agents.find((agent) => agent.id === id)?.backend || id
}

function modelLabel(run?: MachineTaskRun | null, conversation?: MachineTask): string {
  const model = run?.model ?? conversation?.model
  if (!model) return "Default model"
  return `${model.modelID}${model.variant ? ` · ${model.variant}` : ""}`
}

function titleFor(conversation: MachineTask): string {
  if (conversation.title?.trim()) return conversation.title.trim()
  const line = conversation.prompt.trim().split(/\r?\n/).find(Boolean)?.trim() || "Untitled conversation"
  return line.length > 100 ? `${line.slice(0, 97)}...` : line
}

function formatDate(value?: string | null): string {
  if (!value) return ""
  const parsed = Date.parse(value)
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(parsed)
    : value
}

function compactSessionID(id: string): string {
  if (id.length <= 20) return id
  return `${id.slice(0, 9)}…${id.slice(-7)}`
}

function nativeSessions(conversation: MachineTask): NativeSessionRecord[] {
  const seen = new Set<string>()
  const records: NativeSessionRecord[] = []
  workThreadRuns(conversation).forEach((run, index) => {
    const id = runSessionID(run)
    if (!id || seen.has(id)) return
    seen.add(id)
    records.push({ id, run, agentID: runAgent(conversation, run), index })
  })
  return records
}

function NativeSessionsPanel({ conversation, agents }: { conversation: MachineTask; agents: MachineAgentHost[] }) {
  const sessions = useMemo(() => nativeSessions(conversation), [conversation.runs, conversation.run, conversation.id])
  const currentID = runSessionID(conversation.run)

  if (sessions.length === 0) {
    return (
      <div className="tdw-detail-empty hr-session-empty">
        <strong>No native Session yet</strong>
        <span>The first coding agent Session will appear here as soon as the conversation starts.</span>
      </div>
    )
  }

  return (
    <div className="hr-session-panel">
      <div className="hr-session-panel-intro">
        <div>
          <span>Native continuity</span>
          <h2>{sessions.length} native Session{sessions.length === 1 ? "" : "s"}, one conversation</h2>
          <p>Each coding agent keeps its real Session. Harness Remote only links them when you continue with another agent.</p>
        </div>
        <strong className="hr-session-count">{sessions.length}</strong>
      </div>

      <div className="hr-session-chain">
        {sessions.map((record, index) => {
          const previous = sessions[index - 1]
          const changedAgent = Boolean(previous && previous.agentID !== record.agentID)
          const backend = agentBackend(agents, record.agentID)
          const icon = `${import.meta.env.BASE_URL}harness-icons/${backend}.svg`
          return (
            <div className="hr-session-step" key={record.id}>
              {index > 0 ? (
                <div className={`hr-session-transition${changedAgent ? " switched" : ""}`}>
                  <span>{changedAgent ? `Continued with ${agentLabel(agents, record.agentID)}` : "Continued in a new native Session"}</span>
                </div>
              ) : null}
              <article className={`hr-session-card${record.id === currentID ? " current" : ""}`}>
                <div className="hr-session-agent">
                  <span className="hr-session-agent-icon"><img src={icon} alt="" onError={(event) => { event.currentTarget.style.display = "none" }} /></span>
                  <div>
                    <strong>{agentLabel(agents, record.agentID)}</strong>
                    <small>{modelLabel(record.run, conversation)}</small>
                  </div>
                </div>
                <div className="hr-session-meta">
                  <span>{record.id === currentID ? "Current Session" : "Previous Session"}</span>
                  <small>{formatDate(record.run.startedAt)}</small>
                </div>
                <details className="hr-session-native-details">
                  <summary>Native details</summary>
                  <div><span>Session ID</span><code title={record.id}>{compactSessionID(record.id)}</code></div>
                  <div><span>Working directory</span><code title={record.run.directory || conversation.workspace.path}>{record.run.directory || conversation.workspace.path}</code></div>
                </details>
              </article>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ChangesPanel({ conversation, baseConfig, agents, revision }: { conversation: MachineTask; baseConfig: ServerConfig; agents: MachineAgentHost[]; revision: number }) {
  const [inspection, setInspection] = useState<TaskWorkspaceInspection | null>(null)
  const [diff, setDiff] = useState<DiffFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const run = conversation.run
    const session = runSessionID(run)
    const config = configForRun(baseConfig, agents, conversation, run)
    const directory = run?.directory || conversation.workspace.path
    void Promise.all([
      taskClient.inspectWorkspace(baseConfig, conversation.id),
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
  }, [conversation.id, conversation.updatedAt, revision])

  if (loading) return <div className="tdw-detail-loading"><LoadingIcon size={20} /> Loading project changes...</div>
  if (error) return <div className="tdw-inline-error" role="alert">{error}</div>

  const changedFiles = inspection?.changedFiles ?? diff.map((file) => file.file)
  if (!inspection?.changeCount && diff.length === 0) {
    return (
      <div className="tdw-detail-empty">
        <strong>No project changes</strong>
        <span>This conversation has not changed files in the current project workspace.</span>
      </div>
    )
  }

  return (
    <div className="tdw-changes-panel hr-changes-panel">
      <div className="tdw-detail-summary-strip">
        <span><small>Changed files</small><strong>{inspection?.changeCount ?? diff.length}</strong></span>
        <span><small>Project workspace</small><strong>{inspection?.dirty ? "Modified" : "Clean"}</strong></span>
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

export function ConversationDetail({ conversation, baseConfig, agents, machineName, onConversationUpdate, onWorkspaceRefresh }: Props) {
  const [tab, setTab] = useState<DetailTab>("chat")
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const sessions = useMemo(() => nativeSessions(conversation), [conversation.runs, conversation.run, conversation.id])
  const current = conversation.run

  useEffect(() => {
    setTab("chat")
    setError(null)
  }, [conversation.id])

  async function rename() {
    const next = window.prompt("Conversation title", titleFor(conversation))
    if (!next?.trim() || next.trim() === titleFor(conversation)) return
    setError(null)
    try {
      onConversationUpdate(await taskClient.renameWorkThread(baseConfig, conversation.id, next.trim()))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return (
    <div className="tdw-detail hr-conversation-detail">
      <header className="tdw-thread-header hr-conversation-header">
        <div className="tdw-thread-heading">
          <span>{conversation.project?.name || conversation.projectId}</span>
          <div className="tdw-thread-title-edit">
            <h1>{titleFor(conversation)}</h1>
            <button type="button" onClick={() => void rename()} title="Rename conversation">Rename</button>
          </div>
          <p>{agentLabel(agents, runAgent(conversation, current))} · {modelLabel(current, conversation)} · {machineName}</p>
        </div>
      </header>

      <nav className="tdw-detail-tabs hr-conversation-tabs" aria-label="Conversation detail">
        <button type="button" className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>Chat</button>
        <button type="button" className={tab === "sessions" ? "active" : ""} onClick={() => setTab("sessions")}>Sessions <span>{sessions.length}</span></button>
        <button type="button" className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>Changes</button>
      </nav>

      {error ? <div className="tdw-detail-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>×</button></div> : null}

      <div className="tdw-detail-body">
        {tab === "chat" ? (
          <WorkThreadConversation
            key={conversation.id}
            task={conversation}
            baseConfig={baseConfig}
            agents={agents}
            onTaskUpdate={onConversationUpdate}
            onWorkspaceRefresh={() => {
              setRevision((value) => value + 1)
              onWorkspaceRefresh?.()
            }}
          />
        ) : null}
        {tab === "sessions" ? <NativeSessionsPanel conversation={conversation} agents={agents} /> : null}
        {tab === "changes" ? <ChangesPanel conversation={conversation} baseConfig={baseConfig} agents={agents} revision={revision} /> : null}
      </div>
    </div>
  )
}
