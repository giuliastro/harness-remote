import { useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { taskClient, type MachineTask, type MachineTaskRun } from "../taskClient"
import type { TaskDeskTranslator } from "../taskdesk-i18n"
import type { MachineAgentHost, ServerConfig } from "../types"
import { CloseIcon, LoadingIcon, SettingsIcon } from "../Icons"

const REMARK_PLUGINS = [remarkGfm]

type ProductTask = MachineTask & { finishedAt?: string | null }

function taskRuns(task: ProductTask): MachineTaskRun[] {
  if (Array.isArray(task.runs) && task.runs.length) return task.runs
  return task.run ? [task.run] : []
}

function runAgentLabel(run: MachineTaskRun, task: ProductTask, agents: MachineAgentHost[]): string {
  const id = run.agentId || task.agentId
  return agents.find((agent) => agent.id === id)?.label || id
}

export function TaskRunHistoryThread({ task, agents, t }: { task: ProductTask; agents: MachineAgentHost[]; t: TaskDeskTranslator }) {
  const runs = taskRuns(task)
  const historical = runs.slice(0, Math.max(0, runs.length - 1))
  if (!historical.length) return null

  return (
    <section className="td3-task-thread-history" aria-label={t("runs.title")}>
      {historical.map((run, index) => {
        const sequence = run.sequence ?? index + 1
        const agent = runAgentLabel(run, task, agents)
        return (
          <article className="td3-task-thread-turn" key={run.id || sequence}>
            <header><strong>Run #{sequence}</strong><span>{agent}</span></header>
            <div className="td3-task-thread-message user"><strong>{t("conversation.you")}</strong><p>{run.prompt || task.prompt}</p></div>
            {run.outcome ? <div className="td3-task-thread-message assistant"><strong>{agent}</strong><div className="td3-markdown"><ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{run.outcome}</ReactMarkdown></div></div> : null}
          </article>
        )
      })}
      <div className="td3-task-thread-current-label"><span>{t("detail.run")}</span></div>
    </section>
  )
}

export function TaskQuickContinue({
  config,
  task,
  agentLabel,
  modelLabel,
  active,
  canContinue,
  t,
  onAdvanced,
  onContinued
}: {
  config: ServerConfig
  task: ProductTask
  agentLabel: string
  modelLabel: string
  active: boolean
  canContinue: boolean
  t: TaskDeskTranslator
  onAdvanced: () => void
  onContinued: (task: ProductTask) => void
}) {
  const [prompt, setPrompt] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (active) {
    return <div className="td3-task-composer-working" role="status"><LoadingIcon size={16} /><span>{t("review.working")}</span></div>
  }
  if (!canContinue) return null

  async function submit() {
    const text = prompt.trim()
    if (!text || sending) return
    setSending(true)
    setError(null)
    try {
      const next = await taskClient.continueTask(config, task.id, text) as ProductTask
      setPrompt("")
      onContinued(next)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="td3-task-composer">
      <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t("continue.placeholder")} aria-label={t("continue.prompt")} />
      <footer>
        <div className="td3-task-composer-context"><span>{agentLabel}</span><span>·</span><span>{modelLabel}</span></div>
        <button type="button" className="td3-button td3-composer-settings" onClick={onAdvanced} title={t("continue.title")} aria-label={t("continue.title")}><SettingsIcon size={15} /></button>
        <button type="button" className="td3-button primary td3-composer-send" disabled={!prompt.trim() || sending} onClick={() => void submit()}>{sending ? <LoadingIcon size={15} /> : null}{sending ? t("continue.starting") : t("continue.start")}</button>
      </footer>
      {error ? <div className="td3-inline-error td3-task-composer-error" role="alert">{error}</div> : null}
    </section>
  )
}

export function ResultSummaryModal({ title, summary, t, onClose }: { title: string; summary: string; t: TaskDeskTranslator; onClose: () => void }) {
  return (
    <div className="td3-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="td3-modal td3-result-modal" role="dialog" aria-modal="true" aria-label={t("card.resultSummary")} onMouseDown={(event) => event.stopPropagation()}>
        <header><div><small>{t("review.eyebrow")}</small><h2>{t("card.resultSummary")}</h2><p>{title}</p></div><button type="button" onClick={onClose} aria-label={t("nav.close")} title={t("nav.close")}><CloseIcon size={17} /></button></header>
        <div className="td3-modal-body"><div className="td3-markdown"><ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{summary}</ReactMarkdown></div></div>
      </section>
    </div>
  )
}
