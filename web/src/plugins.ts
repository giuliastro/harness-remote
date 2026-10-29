import type { WorkspaceMachine } from "./workspaceMachines"

/**
 * Declarative plugin data.
 *
 * The daemon decides what a plugin can see on this machine; the renderer only knows these shapes.
 * A plugin never ships executable frontend code: its views are meters, stats, charts, settings
 * fields and lifecycle actions, which keeps the shell's layout and accessibility consistent as the
 * number of plugins grows.
 */

export type PluginTone = "good" | "warn" | "danger" | "muted"
export type PluginState = "active" | "available" | "disabled" | "error"

export type PluginDependency = {
  state: "missing" | "external" | "managed"
  name: string
  version: string | null
  path: string | null
  manager: string | null
  compatible: boolean
  supportsObserve: boolean
  detail?: string
}

export type PluginLifecycleAction = {
  available: boolean
  label?: string
  reason?: string
}

export type PluginCustomAction = {
  id: string
  label: string
  style: "primary" | "secondary" | "danger"
}

export type PluginActions = {
  install: PluginLifecycleAction
  update: PluginLifecycleAction
  uninstall: PluginLifecycleAction
  custom: PluginCustomAction[]
}

export type PluginMeter = {
  id: string
  harness?: string
  harnessLabel: string
  label: string
  scope: string
  state: string
  remainingPercent: number | null
  usedPercent: number | null
  resetsAt: string | null
  source?: string
  confidence?: string
  detail?: string
  tone?: PluginTone
}

export type PluginStat = {
  id: string
  label: string
  value: number | string
  unit?: string
  format: "number" | "text" | "percent"
  detail?: string
}

export type PluginChart = {
  title?: string
  unit?: string
  points: Array<{ label: string; value: number }>
}

export type PluginHarnessSummary = {
  harnessId: string
  label: string
  state: string
  remainingPercent: number | null
  detail?: string
}

export type PluginHomeContribution = {
  title: string
  subtitle?: string
  footnote?: string
  harnesses: PluginHarnessSummary[]
  meters: PluginMeter[]
  stats: PluginStat[]
  chart: PluginChart | null
}

export type PluginContributions = {
  home?: PluginHomeContribution
}

export type PluginSettingsField = {
  id: string
  type: "toggle" | "select" | "text"
  label: string
  description?: string
  value: string | number | boolean
  stateLabel?: string
  help?: string
  disabled?: boolean
  options?: Array<{ value: string; label: string }>
}

export type PluginSettingsSection = {
  id: string
  title: string
  description?: string
  fields: PluginSettingsField[]
}

export type PluginSettings = {
  sections: PluginSettingsSection[]
}

export type PluginDiagnostic = {
  severity: "error" | "warning" | "info"
  message: string
  detail?: string
}

export type PluginInfo = {
  id: string
  name: string
  version: string
  description: string
  vendor?: string
  homepage?: string
  license?: string
  icon: string
  builtIn: boolean
  surfaces: string[]
  capabilities: string[]
  permissions: string[]
  runtime: { kind: "node" | "python" }
  enabled: boolean
  ready: boolean
  state: PluginState
  dependency: PluginDependency | null
  actions: PluginActions
  contributions: PluginContributions
  settings: PluginSettings | null
  diagnostics: PluginDiagnostic[]
  storage?: { bytes: number; complete: boolean }
  message?: string
  checkedAt: string
}

export type PluginSnapshot = {
  plugins: PluginInfo[]
  generatedAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function tone(value: unknown): PluginTone | undefined {
  return value === "good" || value === "warn" || value === "danger" || value === "muted" ? value : undefined
}

function customAction(value: unknown): PluginCustomAction | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return null
  return {
    id: value.id,
    label: stringValue(value.label, value.id),
    style: value.style === "primary" || value.style === "danger" ? value.style : "secondary"
  }
}

function action(value: unknown): PluginLifecycleAction {
  if (!isRecord(value) || value.available !== true) return { available: false }
  return {
    available: true,
    ...(optionalString(value.label) ? { label: optionalString(value.label) } : {}),
    ...(optionalString(value.reason) ? { reason: optionalString(value.reason) } : {})
  }
}

function harnessSummary(value: unknown): PluginHarnessSummary | null {
  if (!isRecord(value)) return null
  return {
    harnessId: stringValue(value.harnessId, ""),
    label: stringValue(value.label, "Harness"),
    state: stringValue(value.state, "unknown"),
    remainingPercent: numberOrNull(value.remainingPercent),
    detail: optionalString(value.detail)
  }
}

function meter(value: unknown): PluginMeter | null {
  if (!isRecord(value)) return null
  return {
    id: stringValue(value.id, `meter-${Math.random().toString(36).slice(2)}`),
    harness: optionalString(value.harness),
    harnessLabel: stringValue(value.harnessLabel, optionalString(value.harness) ?? "Harness"),
    label: stringValue(value.label, "Window"),
    scope: stringValue(value.scope, "unknown"),
    state: stringValue(value.state, "unknown"),
    remainingPercent: numberOrNull(value.remainingPercent),
    usedPercent: numberOrNull(value.usedPercent),
    resetsAt: typeof value.resetsAt === "string" ? value.resetsAt : null,
    source: optionalString(value.source),
    confidence: optionalString(value.confidence),
    detail: optionalString(value.detail),
    tone: tone(value.tone)
  }
}

function stat(value: unknown): PluginStat | null {
  if (!isRecord(value)) return null
  const numeric = numberOrNull(value.value)
  const format = value.format === "number" || value.format === "text" || value.format === "percent"
    ? value.format
    : numeric === null ? "text" : "number"
  return {
    id: stringValue(value.id, `stat-${Math.random().toString(36).slice(2)}`),
    label: stringValue(value.label, "Statistic"),
    value: numeric ?? stringValue(value.value, "—"),
    ...(optionalString(value.unit) ? { unit: optionalString(value.unit) } : {}),
    format,
    ...(optionalString(value.detail) ? { detail: optionalString(value.detail) } : {})
  }
}

function chart(value: unknown): PluginChart | null {
  if (!isRecord(value) || !Array.isArray(value.points)) return null
  const points = value.points
    .filter((point): point is Record<string, unknown> => isRecord(point) && numberOrNull(point.value) !== null)
    .slice(0, 90)
    .map((point) => ({
      label: stringValue(point.label, ""),
      value: numberOrNull(point.value) ?? 0
    }))
  if (points.length === 0) return null
  return {
    ...(optionalString(value.title) ? { title: optionalString(value.title) } : {}),
    ...(optionalString(value.unit) ? { unit: optionalString(value.unit) } : {}),
    points
  }
}

function contributions(value: unknown): PluginContributions {
  if (!isRecord(value)) return {}
  const result: PluginContributions = {}
  if (isRecord(value.home)) {
    result.home = {
      title: stringValue(value.home.title, "Plugin"),
      subtitle: optionalString(value.home.subtitle),
      footnote: optionalString(value.home.footnote),
      harnesses: Array.isArray(value.home.harnesses)
        ? value.home.harnesses.map(harnessSummary).filter((item): item is PluginHarnessSummary => Boolean(item)).slice(0, 16)
        : [],
      meters: Array.isArray(value.home.meters) ? value.home.meters.map(meter).filter((item): item is PluginMeter => Boolean(item)).slice(0, 24) : [],
      stats: Array.isArray(value.home.stats) ? value.home.stats.map(stat).filter((item): item is PluginStat => Boolean(item)).slice(0, 12) : [],
      chart: chart(value.home.chart)
    }
  }
  return result
}

function settings(value: unknown): PluginSettings | null {
  if (!isRecord(value) || !Array.isArray(value.sections)) return null
  return {
    sections: value.sections
      .filter((section): section is Record<string, unknown> => isRecord(section) && typeof section.id === "string" && Array.isArray(section.fields))
      .slice(0, 12)
      .map((section) => {
        const rawFields = Array.isArray(section.fields) ? section.fields : []
        return {
          id: stringValue(section.id),
          title: stringValue(section.title, stringValue(section.id)),
          description: optionalString(section.description),
          fields: rawFields
            .filter((field): field is Record<string, unknown> =>
              isRecord(field)
              && typeof field.id === "string"
              && (field.type === "toggle" || field.type === "select" || field.type === "text")
            )
            .slice(0, 32)
            .map((field) => {
              const rawOptions = Array.isArray(field.options) ? field.options : []
              return {
                id: stringValue(field.id),
                type: field.type as PluginSettingsField["type"],
                label: stringValue(field.label, stringValue(field.id)),
                description: optionalString(field.description),
                value: typeof field.value === "string" || typeof field.value === "number" || typeof field.value === "boolean" ? field.value : "",
                stateLabel: optionalString(field.stateLabel),
                help: optionalString(field.help),
                disabled: field.disabled === true,
                options: rawOptions
                  .filter((option): option is Record<string, unknown> => isRecord(option) && (typeof option.value === "string" || typeof option.value === "number"))
                  .slice(0, 48)
                  .map((option) => ({ value: String(option.value), label: stringValue(option.label, String(option.value)) }))
              }
            })
        }
      })
  }
}

function diagnostics(value: unknown): PluginDiagnostic[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.message === "string")
    .slice(0, 24)
    .map((item) => ({
      severity: item.severity === "error" || item.severity === "warning" ? item.severity : "info",
      message: stringValue(item.message),
      detail: optionalString(item.detail)
    }))
}

export function normalizePlugin(value: unknown): PluginInfo | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return null
  const dependency = isRecord(value.dependency)
    ? {
      state: value.dependency.state === "external" ? "external" as const : value.dependency.state === "managed" ? "managed" as const : "missing" as const,
      name: stringValue(value.dependency.name, "dependency"),
      version: typeof value.dependency.version === "string" ? value.dependency.version : null,
      path: typeof value.dependency.path === "string" ? value.dependency.path : null,
      manager: typeof value.dependency.manager === "string" ? value.dependency.manager : null,
      compatible: value.dependency.compatible !== false,
      supportsObserve: value.dependency.supportsObserve === true,
      detail: optionalString(value.dependency.detail)
    }
    : null
  const actions = isRecord(value.actions) ? value.actions : {}
  const state = value.state === "active" || value.state === "available" || value.state === "disabled" || value.state === "error"
    ? value.state
    : value.ready === true
      ? value.enabled === true ? "active" : "disabled"
      : "available"
  return {
    id: value.id,
    name: value.name,
    version: stringValue(value.version, "0.0.0"),
    description: stringValue(value.description),
    vendor: optionalString(value.vendor),
    homepage: optionalString(value.homepage),
    license: optionalString(value.license),
    icon: stringValue(value.icon, "puzzle"),
    builtIn: value.builtIn === true,
    surfaces: Array.isArray(value.surfaces) ? value.surfaces.filter((item): item is string => typeof item === "string") : [],
    capabilities: Array.isArray(value.capabilities) ? value.capabilities.filter((item): item is string => typeof item === "string") : [],
    permissions: Array.isArray(value.permissions) ? value.permissions.filter((item): item is string => typeof item === "string") : [],
    runtime: { kind: isRecord(value.runtime) && value.runtime.kind === "python" ? "python" : "node" },
    enabled: value.enabled === true,
    ready: value.ready === true,
    state,
    dependency,
    actions: {
      install: action(actions.install),
      update: action(actions.update),
      uninstall: action(actions.uninstall),
      custom: Array.isArray(actions.custom)
        ? actions.custom.map(customAction).filter((item): item is PluginCustomAction => Boolean(item)).slice(0, 8)
        : []
    },
    contributions: contributions(value.contributions),
    settings: settings(value.settings),
    diagnostics: diagnostics(value.diagnostics),
    storage: isRecord(value.storage) && numberOrNull(value.storage.bytes) !== null
      ? { bytes: Math.max(0, numberOrNull(value.storage.bytes) ?? 0), complete: value.storage.complete === true }
      : undefined,
    message: optionalString(value.message),
    checkedAt: stringValue(value.checkedAt, new Date().toISOString())
  }
}

export function normalizePluginSnapshot(value: unknown): PluginSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.plugins)) return null
  return {
    plugins: value.plugins.map(normalizePlugin).filter((plugin): plugin is PluginInfo => Boolean(plugin)),
    generatedAt: stringValue(value.generatedAt, new Date().toISOString())
  }
}

export function pluginIsActive(plugin: PluginInfo): boolean {
  return plugin.enabled && plugin.ready && plugin.state === "active"
}

export function activePlugins(snapshot: PluginSnapshot | null): PluginInfo[] {
  return (snapshot?.plugins ?? []).filter(pluginIsActive)
}

export function preferredPluginMachine(
  machines: WorkspaceMachine[],
  preferred?: WorkspaceMachine | null,
  isDesktopLocal?: (machine: WorkspaceMachine) => boolean
): WorkspaceMachine | undefined {
  if (preferred && machines.some((machine) => machine.id === preferred.id)) return preferred
  if (isDesktopLocal) {
    const local = machines.find((machine) => isDesktopLocal(machine))
    if (local) return local
  }
  return machines[0]
}

export function formatPluginValue(stat: PluginStat, language: string): string {
  if (stat.format === "text" || typeof stat.value === "string") return String(stat.value)
  const number = typeof stat.value === "number" ? stat.value : Number(stat.value)
  if (!Number.isFinite(number)) return String(stat.value)
  if (stat.format === "percent") return `${Math.round(number)}%`
  const formatted = new Intl.NumberFormat(language, {
    notation: number >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: number >= 10_000 ? 1 : 0
  }).format(number)
  const unit = stat.unit === "characters" ? "chars" : stat.unit
  return unit ? `${formatted} ${unit}` : formatted
}

export function formatResetAt(value: string | null, language: string, now = Date.now()): string | null {
  if (!value) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return null
  const delta = time - now
  if (delta <= 0) return "reset due"
  const minutes = Math.round(delta / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return new Intl.DateTimeFormat(language, { month: "short", day: "numeric" }).format(time)
}

export function pluginToneClass(tone?: PluginTone): string {
  return tone ? ` tone-${tone}` : ""
}
