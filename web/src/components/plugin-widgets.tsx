import { useEffect, useRef, useState, type CSSProperties } from "react"
import { AlertIcon, LoadingIcon } from "../Icons"
import { mutatePlugin } from "../pluginClient"
import {
  formatPluginValue,
  formatResetAt,
  pluginToneClass,
  type PluginInfo,
  type PluginMeter,
  type PluginSettingsField,
  type PluginSettingsSection,
  type PluginStat
} from "../plugins"
import { useLanguage, useTranslator } from "../useTranslator"
import type { WorkspaceMachine } from "../workspaceMachines"

export function PluginIcon({ plugin, size = 20 }: { plugin: Pick<PluginInfo, "icon" | "name">; size?: number }) {
  const tokenHarness = plugin.icon === "token-harness"
  return (
    <span className={`hr-plugin-icon${tokenHarness ? " token-harness" : ""}`} style={{ ["--hr-plugin-icon-size" as string]: `${size}px` }} aria-hidden="true">
      {tokenHarness ? (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4.2 17.5a8.4 8.4 0 1 1 15.6 0" />
          <path d="M7 17.5h10" opacity=".45" />
          <path d="m12.2 16.9 3.1-5.1" />
          <circle cx="12" cy="16.9" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      ) : (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8.5 3.5h4a1.5 1.5 0 0 1 1.5 1.5v1.2a2.3 2.3 0 1 0 4.6 0V5a1.5 1.5 0 0 1 1.5-1.5h.4v4a1.5 1.5 0 0 1-1.5 1.5h-1.2a2.3 2.3 0 1 0 0 4.6H19a1.5 1.5 0 0 1 1.5 1.5v4h-4a1.5 1.5 0 0 1-1.5-1.5v-1.2a2.3 2.3 0 1 0-4.6 0V19a1.5 1.5 0 0 1-1.5 1.5h-4v-4a1.5 1.5 0 0 1 1.5-1.5h1.2a2.3 2.3 0 1 0 0-4.6H5A1.5 1.5 0 0 1 3.5 9V5h4Z" />
        </svg>
      )}
    </span>
  )
}

function toneForPlugin(plugin: PluginInfo): string {
  if (plugin.state === "error") return "danger"
  if (plugin.state === "disabled") return "muted"
  if (plugin.state === "available") return "warn"
  return "good"
}

export function PluginStateBadge({ plugin }: { plugin: PluginInfo }) {
  const t = useTranslator()
  const label = plugin.state === "error"
    ? t("plugins.needsAttention")
    : plugin.state === "available"
      ? t("plugins.notInstalled")
      : plugin.state === "disabled"
        ? t("plugins.disabled")
        : t("plugins.active")
  return (
    <span className={`hr-plugin-state-badge tone-${toneForPlugin(plugin)}`}>
      <i aria-hidden="true" />
      {label}
    </span>
  )
}

function MeterRow({ meter, compact = false }: { meter: PluginMeter; compact?: boolean }) {
  const t = useTranslator()
  const language = useLanguage()
  const reset = formatResetAt(meter.resetsAt, language)
  const remaining = meter.remainingPercent
  const style = { ["--hr-plugin-meter-value" as string]: `${remaining ?? 0}%` } as CSSProperties
  return (
    <div className={`hr-plugin-meter${compact ? " compact" : ""}${pluginToneClass(meter.tone)}`} style={style}>
      <div className="hr-plugin-meter-copy">
        <span>{meter.label}</span>
        <strong>{remaining === null ? "—" : `${Math.round(remaining)}%`}</strong>
      </div>
      <div
        className="hr-plugin-meter-track"
        role="meter"
        aria-label={`${meter.harnessLabel} ${meter.label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining ?? undefined}
      >
        <i aria-hidden="true" />
      </div>
      <div className="hr-plugin-meter-meta">
        {remaining === null ? (
          <span title={meter.detail}>{meter.detail || t("plugins.quotaUnavailable")}</span>
        ) : (
          <span>{[meter.source, meter.confidence].filter(Boolean).join(" · ") || t("plugins.remaining", { percent: Math.round(remaining) })}</span>
        )}
        {reset ? <span className="hr-plugin-reset" title={meter.resetsAt ?? undefined}>↻ {reset}</span> : null}
      </div>
    </div>
  )
}

export function PluginAllowance({ meters, compact = false, focusHarness }: { meters: PluginMeter[]; compact?: boolean; focusHarness?: string }) {
  const t = useTranslator()
  const groups = new Map<string, { label: string; state: string; meters: PluginMeter[] }>()
  for (const meter of meters) {
    const id = meter.harness || meter.harnessLabel
    const group = groups.get(id) ?? { label: meter.harnessLabel, state: meter.state, meters: [] }
    group.meters.push(meter)
    groups.set(id, group)
  }
  const orderedGroups = [...groups.entries()].sort(([left], [right]) => {
    if (left === focusHarness) return -1
    if (right === focusHarness) return 1
    return 0
  })
  if (groups.size === 0) {
    return (
      <div className="hr-plugin-allowance-empty">
        <AlertIcon size={15} />
        <span>{t("plugins.quotaUnavailable")}</span>
      </div>
    )
  }
  return (
    <div className={`hr-plugin-allowance${compact ? " compact" : ""}`}>
      {orderedGroups.map(([id, group]) => (
        <section className={`hr-plugin-harness${id === focusHarness ? " focus" : ""}`} key={id}>
          <header>
            <strong>{group.label}</strong>
            {id === focusHarness ? <span className="hr-plugin-in-use">{t("plugins.inUse")}</span> : null}
            <span className={`hr-plugin-harness-state${group.meters.some((meter) => meter.remainingPercent !== null) ? " live" : ""}`}>
              {group.meters.some((meter) => meter.remainingPercent !== null) ? t("plugins.observed") : t("plugins.unavailable")}
            </span>
          </header>
          {group.meters.map((meter) => <MeterRow key={meter.id} meter={meter} compact={compact} />)}
          {group.meters.length === 0 ? <p>{t("plugins.quotaUnavailable")}</p> : null}
        </section>
      ))}
    </div>
  )
}

export function PluginStats({ stats }: { stats: PluginStat[] }) {
  const language = useLanguage()
  if (stats.length === 0) return null
  return (
    <div className={`hr-plugin-stats count-${Math.min(stats.length, 4)}`}>
      {stats.map((stat) => (
        <div className="hr-plugin-stat" key={stat.id}>
          <strong>{formatPluginValue(stat, language)}</strong>
          <span>{stat.label}</span>
          {stat.detail ? <small>{stat.detail}</small> : null}
        </div>
      ))}
    </div>
  )
}

export function PluginSparkline({ chart }: { chart: NonNullable<PluginInfo["contributions"]["home"]>["chart"] }) {
  if (!chart || chart.points.length === 0) return null
  const max = Math.max(...chart.points.map((point) => point.value), 1)
  const total = chart.points.reduce((sum, point) => sum + point.value, 0)
  const language = useLanguage()
  const formattedTotal = new Intl.NumberFormat(language, { notation: "compact", maximumFractionDigits: 1 }).format(total)
  return (
    <div className="hr-plugin-chart">
      <div className="hr-plugin-chart-heading">
        <span>{chart.title || "Recorded savings"}</span>
        <strong>{formattedTotal}{chart.unit ? ` ${chart.unit}` : ""}</strong>
      </div>
      <div className="hr-plugin-bars" role="img" aria-label={`${chart.title || "Savings"}: ${formattedTotal} ${chart.unit ?? ""}`}>
        {chart.points.map((point, index) => (
          <span
            className="hr-plugin-bar"
            key={`${point.label}:${index}`}
            title={`${point.label}: ${new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(point.value)} ${chart.unit ?? ""}`}
          >
            <i style={{ height: `${Math.max(4, (point.value / max) * 100)}%` }} />
            {(index === 0 || index === chart.points.length - 1) ? <small>{point.label}</small> : <small aria-hidden="true" />}
          </span>
        ))}
      </div>
    </div>
  )
}

export function PluginDashboardContent({
  plugin,
  compact = false,
  machine,
  onChanged,
  showRouting = true,
  showWindow = true,
  routingFirst = false,
  focusHarness
}: {
  plugin: PluginInfo
  compact?: boolean
  machine?: WorkspaceMachine
  onChanged?: () => void
  showRouting?: boolean
  showWindow?: boolean
  routingFirst?: boolean
  focusHarness?: string
}) {
  const t = useTranslator()
  const home = plugin.contributions.home
  if (!home) return null
  const routingSettings = showRouting && machine && plugin.settings ? (
    <PluginSettingsForm
      machine={machine}
      plugin={plugin}
      sectionIDs={["routing"]}
      compact={compact}
      onChanged={onChanged}
    />
  ) : null
  return (
    <div className={`hr-plugin-dashboard${compact ? " compact" : ""}`}>
      <section className="hr-plugin-section">
        <div className="hr-plugin-section-heading">
          <div>
            <h4>{t("plugins.allowance")}</h4>
          </div>
        </div>
        <PluginAllowance meters={home.meters} compact={compact} focusHarness={focusHarness} />
      </section>
      {routingFirst ? routingSettings : null}
      {(home.stats.length > 0 || home.chart) ? (
        <section className="hr-plugin-section">
          <div className="hr-plugin-section-heading">
            <div>
              <h4>{t("plugins.savings")}</h4>
            </div>
          </div>
          <PluginStats stats={home.stats} />
          {home.chart && !compact ? <PluginSparkline chart={home.chart} /> : null}
        </section>
      ) : null}
      {!routingFirst ? routingSettings : null}
      {showWindow && machine && plugin.settings && !compact ? (
        <PluginSettingsForm
          machine={machine}
          plugin={plugin}
          sectionIDs={["dashboard"]}
          onChanged={onChanged}
        />
      ) : null}
      {home.footnote ? <p className="hr-plugin-footnote">{home.footnote}</p> : null}
    </div>
  )
}

function fieldValue(field: PluginSettingsField): string | number | boolean {
  return field.value
}

function FieldControl({
  field,
  value,
  busy,
  onChange
}: {
  field: PluginSettingsField
  value: string | number | boolean
  busy: boolean
  onChange: (value: string | number | boolean) => void
}) {
  const [draft, setDraft] = useState(String(value ?? ""))
  useEffect(() => { setDraft(String(value ?? "")) }, [value])
  if (field.type === "toggle") {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={value === true}
        aria-label={field.label}
        className={`hr-plugin-switch${value === true ? " on" : ""}`}
        disabled={field.disabled || busy}
        onClick={() => onChange(value !== true)}
      >
        <span aria-hidden="true" />
      </button>
    )
  }
  if (field.type === "select") {
    return (
      <select
        value={String(value ?? "")}
        disabled={field.disabled || busy}
        aria-label={field.label}
        onChange={(event) => onChange(event.target.value)}
      >
        {(field.options ?? []).map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
      </select>
    )
  }
  return (
    <input
      value={draft}
      disabled={field.disabled || busy}
      aria-label={field.label}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => { if (draft !== String(value ?? "")) onChange(draft) }}
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur() } }}
    />
  )
}

export function PluginSettingsForm({
  machine,
  plugin,
  sectionIDs,
  compact = false,
  onChanged
}: {
  machine: WorkspaceMachine
  plugin: PluginInfo
  sectionIDs?: string[]
  compact?: boolean
  onChanged?: () => void
}) {
  const t = useTranslator()
  const [pending, setPending] = useState<Record<string, string | number | boolean>>({})
  const [busyField, setBusyField] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sections = (plugin.settings?.sections ?? []).filter((section) => !sectionIDs || sectionIDs.includes(section.id))
  const shownSections = compact
    ? sections.map((section) => ({ ...section, fields: section.fields.slice(0, 3) }))
    : sections
  const allFields = (plugin.settings?.sections ?? []).flatMap((section) => section.fields)

  useEffect(() => {
    setPending((current) => {
      if (Object.keys(current).length === 0) return current
      const next = { ...current }
      let changed = false
      for (const [id, value] of Object.entries(current)) {
        const field = allFields.find((candidate) => candidate.id === id)
        if (field && field.value === value) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : current
    })
    // Clearing happens only when the daemon has confirmed the new value. `checkedAt` is the
    // snapshot revision that carries that confirmation.
  }, [plugin.checkedAt])

  useEffect(() => () => { if (clearTimer.current) clearTimeout(clearTimer.current) }, [])

  function showNotice(next: { kind: "success" | "error"; text: string }) {
    setNotice(next)
    if (clearTimer.current) clearTimeout(clearTimer.current)
    clearTimer.current = setTimeout(() => setNotice(null), next.kind === "error" ? 8_000 : 4_000)
  }

  async function apply(field: PluginSettingsField, value: string | number | boolean) {
    const previous = pending[field.id]
    setPending((current) => ({ ...current, [field.id]: value }))
    setBusyField(field.id)
    try {
      await mutatePlugin(machine.config, plugin.id, "settings", { values: { [field.id]: value } })
      showNotice({ kind: "success", text: t("plugins.settingSaved") })
      onChanged?.()
    } catch (error) {
      setPending((current) => {
        const next = { ...current }
        if (previous === undefined) delete next[field.id]
        else next[field.id] = previous
        return next
      })
      showNotice({ kind: "error", text: error instanceof Error ? error.message : t("plugins.settingFailed") })
    } finally {
      setBusyField(null)
    }
  }

  if (shownSections.length === 0) return null
  return (
    <div className={`hr-plugin-settings${compact ? " compact" : ""}`}>
      {shownSections.map((section: PluginSettingsSection) => (
        <section className="hr-plugin-section" key={section.id}>
          <div className="hr-plugin-section-heading">
            <div>
              <h4>{section.title}</h4>
            </div>
          </div>
          {section.description && !compact ? <p className="hr-plugin-section-description">{section.description}</p> : null}
          <div className="hr-plugin-setting-list">
            {section.fields.map((field) => {
              const value = pending[field.id] ?? fieldValue(field)
              const busy = busyField === field.id
              return (
                <div className={`hr-plugin-setting${field.disabled ? " disabled" : ""}`} key={field.id}>
                  <div className="hr-plugin-setting-copy">
                    <div>
                      <strong>{field.label}</strong>
                      {field.stateLabel ? <span className={`hr-plugin-field-state${value === true ? " on" : ""}`}>{field.stateLabel}</span> : null}
                    </div>
                    {field.description && !compact ? <p>{field.description}</p> : null}
                    {field.help && !compact ? <small>{field.help}</small> : null}
                  </div>
                  <div className="hr-plugin-setting-control">
                    {busy ? <LoadingIcon size={15} /> : <FieldControl field={field} value={value} busy={busy} onChange={(next) => void apply(field, next)} />}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ))}
      {notice ? (
        <p className={`hr-plugin-setting-notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.text}
        </p>
      ) : null}
    </div>
  )
}

export function PluginHomeDashboard({
  plugins,
  machine,
  onOpenPlugins,
  onChanged
}: {
  plugins: PluginInfo[]
  machine: WorkspaceMachine
  onOpenPlugins: () => void
  onChanged: () => void
}) {
  const t = useTranslator()
  const visible = plugins.filter((plugin) => plugin.contributions.home)
  if (visible.length === 0) return null
  return (
    <div className="hr-plugin-home-stack">
      {visible.map((plugin) => {
        const home = plugin.contributions.home!
        return (
          <section className="hr-plugin-home-card" key={plugin.id} aria-label={`${plugin.name} ${t("plugins.dashboard")}`}>
            <header className="hr-plugin-home-head">
              <div className="hr-plugin-home-title">
                <PluginIcon plugin={plugin} size={26} />
                <div>
                  <span>Harness Remote plugin · {machine.name}</span>
                  <h3>{home.title}</h3>
                  {home.subtitle ? <p>{home.subtitle}</p> : null}
                </div>
              </div>
              <div className="hr-plugin-home-actions">
                <PluginStateBadge plugin={plugin} />
                <button type="button" className="tdw-button secondary" onClick={onOpenPlugins}>{t("plugins.manage")}</button>
              </div>
            </header>
            <PluginDashboardContent
              plugin={plugin}
              machine={machine}
              onChanged={onChanged}
              showWindow={false}
            />
          </section>
        )
      })}
    </div>
  )
}

export function PluginDiagnostics({ plugin }: { plugin: PluginInfo }) {
  const t = useTranslator()
  if (plugin.diagnostics.length === 0) return null
  const visible = plugin.diagnostics.slice(0, 8)
  return (
    <section className="hr-plugin-diagnostics" aria-label={t("plugins.diagnostics")}>
      <h4>{t("plugins.diagnostics")}</h4>
      <ul>
        {visible.map((item, index) => (
          <li className={`severity-${item.severity}`} key={`${item.message}:${index}`}>
            <span>{item.severity}</span>
            <div>
              <strong>{item.message}</strong>
              {item.detail ? <small>{item.detail}</small> : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

