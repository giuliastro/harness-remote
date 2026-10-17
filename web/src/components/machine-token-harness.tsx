import { useEffect, useRef, useState } from "react"
import { loadLanguage } from "../appPreferences"
import { readMachineOptimization, type OptimizationSnapshot, type OptimizationWindow } from "../tokenHarnessClient"
import type { WorkspaceMachine } from "../workspaceMachines"
import "../token-harness-observability.css"

const translations = {
  en: {
    open: "Usage & optimization", refresh: "Refresh", loading: "Reading machine metrics…",
    unavailable: "Token Harness is not available on this machine.",
    partial: "Some observations could not be read. Missing values are not zero.",
    error: "Could not read usage from this machine.",
    empty: "No supported coding agents detected.", allowance: "Subscription allowance",
    missing: "No reliable allowance observation", optimizers: "Optimizers",
    none: "No configured optimizers detected", savings: "Recorded output reductions",
    noSavings: "No attributable optimization receipts yet.",
    scope: "Machine-local data · not per-session or billed savings",
    unknown: "Unknown", reset: "Resets", asOf: "Observed",
    five: "5-hour", weekly: "Weekly", monthly: "Monthly", other: "Other",
    measured: "Measured", cached: "Cached", source: "Source",
    operations: "operations"
  },
  it: {
    open: "Utilizzo e ottimizzazione", refresh: "Aggiorna", loading: "Lettura metriche della macchina…",
    unavailable: "Token Harness non è disponibile su questa macchina.",
    partial: "Alcuni dati non sono disponibili. Un valore mancante non equivale a zero.",
    error: "Impossibile leggere le quote di questa macchina.",
    empty: "Nessun coding agent supportato rilevato.", allowance: "Quote abbonamento",
    missing: "Nessuna rilevazione affidabile della quota", optimizers: "Ottimizzatori",
    none: "Nessun ottimizzatore configurato", savings: "Riduzioni dell'output registrate",
    noSavings: "Nessuna misura attribuibile ancora disponibile.",
    scope: "Dati locali alla macchina · non per sessione né risparmi fatturati",
    unknown: "Sconosciuto", reset: "Reset", asOf: "Rilevato",
    five: "5 ore", weekly: "Settimanale", monthly: "Mensile", other: "Altro",
    measured: "Misurato", cached: "Cache", source: "Fonte",
    operations: "operazioni"
  },
  "zh-TW": {
    open: "用量與最佳化", refresh: "重新整理", loading: "正在讀取主機資料…",
    unavailable: "此主機無法使用 Token Harness。", partial: "部分資料無法讀取；缺少數值不代表零。",
    error: "無法讀取主機用量。", empty: "未偵測到支援的程式碼代理。",
    allowance: "訂閱額度", missing: "無可靠額度資料", optimizers: "最佳化工具",
    none: "未偵測到已設定工具", savings: "已記錄輸出減量",
    noSavings: "尚無可歸屬的測量資料。", scope: "主機資料，非個別工作階段或實際帳單節省",
    unknown: "未知", reset: "重設", asOf: "觀察時間", five: "5 小時", weekly: "每週",
    monthly: "每月", other: "其他", measured: "已測量", cached: "快取",
    source: "來源", operations: "次操作"
  },
  "zh-CN": {
    open: "用量与优化", refresh: "刷新", loading: "正在读取主机数据…",
    unavailable: "此主机无法使用 Token Harness。", partial: "部分数据不可用；缺失值不代表零。",
    error: "无法读取主机用量。", empty: "未检测到支持的编程代理。",
    allowance: "订阅额度", missing: "无可靠额度数据", optimizers: "优化工具",
    none: "未检测到已配置工具", savings: "已记录输出减少量",
    noSavings: "暂无可归属的测量数据。", scope: "主机数据，非单次会话或实际账单节省",
    unknown: "未知", reset: "重置", asOf: "观测时间", five: "5 小时", weekly: "每周",
    monthly: "每月", other: "其他", measured: "已测量", cached: "缓存",
    source: "来源", operations: "次操作"
  }
} as const

type Copy = Record<keyof typeof translations["en"], string>

function dateLabel(value: string | null, language: string) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(language)
}

function WindowRow({ window, copy, language }: { window: OptimizationWindow; copy: Copy; language: string }) {
  const label = window.scope === "five-hour" ? copy.five
    : window.scope === "weekly" ? copy.weekly
    : window.scope === "monthly" ? copy.monthly : window.bucketName || copy.other
  const remaining = window.remainingPercent
  const reset = dateLabel(window.resetsAt, language)
  return (
    <div className="uw-th-window">
      <div className="uw-th-window-heading">
        <strong>{label}{window.bucketName && window.scope !== "unknown" ? ` · ${window.bucketName}` : ""}</strong>
        <span>{remaining === null ? copy.unknown : `${Math.round(remaining)}%`}</span>
      </div>
      {remaining !== null ? <div className="uw-th-meter" role="progressbar"
        aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining}>
        <span style={{ width: `${remaining}%` }} />
      </div> : null}
      <small>{[reset ? `${copy.reset}: ${reset}` : null,
        window.confidence === "cached" ? copy.cached : null,
        window.source ? `${copy.source}: ${window.source}` : null].filter(Boolean).join(" · ")}</small>
    </div>
  )
}

/** Opt-in read: merely opening Machines does not launch Token Harness probes. */
export function MachineTokenHarness({ machine }: { machine: WorkspaceMachine }) {
  const language = loadLanguage()
  const copy: Copy = translations[language]
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [snapshot, setSnapshot] = useState<OptimizationSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)

  useEffect(() => () => { sequence.current += 1 }, [])

  async function refresh() {
    const request = ++sequence.current
    setLoading(true)
    setError(null)
    try {
      const value = await readMachineOptimization(machine.config)
      if (sequence.current === request) setSnapshot(value)
    } catch (reason) {
      if (sequence.current === request) setError(reason instanceof Error ? reason.message : copy.error)
    } finally {
      if (sequence.current === request) setLoading(false)
    }
  }

  function toggle() {
    setExpanded(!expanded)
    if (!expanded && !snapshot && !loading) void refresh()
  }

  return (
    <div className="uw-th-observability" data-token-harness>
      <button type="button" className="uw-manager-button uw-th-toggle" aria-expanded={expanded} onClick={toggle}>
        {copy.open} <span aria-hidden="true">{expanded ? "▴" : "▾"}</span>
      </button>
      {expanded ? (
        <div className="uw-th-content" aria-busy={loading}>
          <div className="uw-th-toolbar">
            <strong>Token Harness{snapshot?.toolVersion ? ` · ${snapshot.toolVersion}` : ""}</strong>
            <button type="button" className="uw-manager-button" disabled={loading} onClick={() => void refresh()}>{copy.refresh}</button>
          </div>
          {loading ? <p role="status">{copy.loading}</p> : null}
          {error ? <p className="uw-th-warning" role="alert">{copy.error} {error}</p> : null}
          {snapshot && !loading ? (
            snapshot.state === "unavailable" ? <p role="status">{copy.unavailable}</p> : (
              <>
                {snapshot.state === "partial" ? <p className="uw-th-warning" role="status">{copy.partial}</p> : null}
                {snapshot.agents.length === 0 ? <p>{copy.empty}</p> : snapshot.agents.map((agent) => (
                  <section className="uw-th-agent" key={agent.id}>
                    <div className="uw-th-agent-heading"><strong>{agent.id === "claude" ? "Claude Code" : agent.id === "codex" ? "Codex" : agent.id}</strong><small>{agent.version ?? ""}</small></div>
                    <div className="uw-th-agent-meta"><b>{copy.optimizers}:</b> {agent.optimizers.join(", ") || copy.none}</div>
                    <div className="uw-th-agent-meta"><b>{copy.allowance}:</b></div>
                    {agent.windows.length ? agent.windows.map((window, index) =>
                      <WindowRow key={`${window.scope}-${window.bucketName}-${index}`} window={window} copy={copy} language={language} />
                    ) : <p className="uw-th-muted">{copy.missing}</p>}
                  </section>
                ))}
                <section className="uw-th-savings">
                  <strong>{copy.savings}</strong>
                  {snapshot.savings.length ? snapshot.savings.map((row, index) => (
                    <div className="uw-th-saving-row" key={`${row.provider}-${index}`}>
                      <span>{row.provider ?? copy.unknown}</span>
                      <span><b>{row.saved.toLocaleString(language)} {row.unit}</b>
                        <small>{row.measurementClass ?? copy.measured}{row.operations !== null ? ` · ${row.operations} ${copy.operations}` : ""}</small></span>
                    </div>
                  )) : <p className="uw-th-muted">{copy.noSavings}</p>}
                </section>
                <p className="uw-th-note">{copy.scope}{snapshot.observedAt ? ` · ${copy.asOf}: ${dateLabel(snapshot.observedAt, language) ?? copy.unknown}` : ""}</p>
              </>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
