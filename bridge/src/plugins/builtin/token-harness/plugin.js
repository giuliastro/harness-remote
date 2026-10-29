#!/usr/bin/env node
import { execFile, spawn } from "node:child_process"
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const MIN_OBSERVE_VERSION = "0.1.34"
const HARNESS_NAMES = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "Oh My Pi",
  hermes: "Hermes"
}
const ROUTING_EVENTS = ["UserPromptSubmit", "SubagentStart", "SubagentStop"]
const WINDOWS = new Set(["7d", "30d", "all"])

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** The plugin can inspect a different home than the daemon for routing fixtures. */
function tokenHarnessHome(context) {
  return text(process.env.HARNESS_REMOTE_TOKEN_HARNESS_HOME).trim()
    || text(context?.home).trim()
    || os.homedir()
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function percentOrNull(value) {
  const parsed = numberOrNull(value)
  return parsed === null ? null : Math.min(100, Math.max(0, parsed))
}

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback
}

function compactError(error) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function tail(value, limit = 1_200) {
  const message = text(value).trim()
  return message.length > limit ? `…${message.slice(-limit)}` : message
}

async function exists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

function commandCandidates(name, platform) {
  if (platform !== "win32") return [name]
  return [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name]
}

async function findExecutable(name, context) {
  const home = text(context.home, os.homedir())
  const platform = text(context.platform, process.platform)
  const environment = process.env
  const directories = [
    ...text(environment.PATH).split(path.delimiter).filter(Boolean),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    ...(platform === "win32"
      ? [path.join(environment.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm")]
      : ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"])
  ]
  const seen = new Set()
  for (const directory of directories) {
    if (seen.has(directory)) continue
    seen.add(directory)
    for (const candidate of commandCandidates(name, platform)) {
      const target = path.join(directory, candidate)
      if (await exists(target)) return target
    }
  }
  return null
}

function versionFrom(output) {
  const match = /(?:^|[^\d])(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text(output))
  return match ? match[1] : null
}

function versionAtLeast(version, minimum) {
  if (!version) return false
  const left = version.split(/[+-]/)[0].split(".").map((part) => Number(part))
  const right = minimum.split(".").map((part) => Number(part))
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return (left[index] ?? 0) > (right[index] ?? 0)
  }
  return true
}

async function run(command, args, { cwd, env, timeout = 30_000 } = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env: {
        ...process.env,
        ...(env ?? {}),
        NO_COLOR: "1",
        FORCE_COLOR: "0"
      },
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      ...(process.platform === "win32" ? { shell: true } : {})
    })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    if (error && typeof error === "object" && ("stdout" in error || "stderr" in error)) {
      return {
        code: typeof error.code === "number" ? error.code : 1,
        stdout: text(error.stdout),
        stderr: text(error.stderr) || compactError(error)
      }
    }
    throw error
  }
}

async function runJSON(command, args, options = {}) {
  const result = await run(command, args, options)
  const stdout = text(result.stdout).trim()
  if (!stdout) {
    throw new Error(`${path.basename(command)} ${args[0] ?? ""} returned no output${result.stderr ? `: ${tail(result.stderr)}` : ""}`)
  }
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`${path.basename(command)} ${args[0] ?? ""} returned unreadable JSON: ${tail(stdout)}`)
  }
}

function firstDiagnostic(envelope, fallback) {
  const diagnostics = Array.isArray(envelope?.diagnostics) ? envelope.diagnostics : []
  const ordered = diagnostics
    .filter((item) => isRecord(item) && typeof item.message === "string")
    .sort((left, right) => {
      const weight = { error: 0, warning: 1, info: 2 }
      return (weight[left.severity] ?? 3) - (weight[right.severity] ?? 3)
    })
  const found = ordered[0]
  if (!found) return fallback
  return found.remediation ? `${found.message} ${found.remediation}` : found.message
}

function diagnostic({ severity = "info", message, detail }) {
  return {
    severity: ["error", "warning", "info"].includes(severity) ? severity : "info",
    message: text(message, "Token Harness plugin diagnostic"),
    ...(detail ? { detail: text(detail) } : {})
  }
}

function dedupeDiagnostics(items) {
  const byMessage = new Map()
  for (const item of items) {
    if (!item?.message) continue
    if (!byMessage.has(item.message)) byMessage.set(item.message, item)
  }
  return [...byMessage.values()].slice(0, 16)
}

async function resolveCli(context) {
  const home = tokenHarnessHome(context)
  const platform = text(context.platform, process.platform)
  const runtimeDirectory = text(context.managedRuntimeDirectory)
  const managed = runtimeDirectory
    ? path.join(runtimeDirectory, "node_modules", ".bin", platform === "win32" ? "token-harness.cmd" : "token-harness")
    : null
  const candidates = []
  if (managed && await exists(managed)) candidates.push({ path: managed, source: "managed" })
  const override = text(process.env.HARNESS_REMOTE_TOKEN_HARNESS_PATH).trim()
  if (override && await exists(override)) candidates.push({ path: override, source: "external" })
  const external = await findExecutable("token-harness", context)
  if (external && !candidates.some((candidate) => candidate.path === external)) candidates.push({ path: external, source: "external" })
  for (const candidate of candidates) {
    const result = await run(candidate.path, ["--version"], {
      cwd: home,
      env: { HOME: home },
      timeout: 15_000
    })
    if (result.code === 0) {
      return {
        path: candidate.path,
        source: candidate.source,
        version: versionFrom(`${result.stdout}\n${result.stderr}`)
      }
    }
  }
  return null
}

function normalizeConfig(config) {
  return {
    window: WINDOWS.has(config?.window) ? config.window : "7d"
  }
}

function windowLabel(window) {
  if (window === "30d") return "Last 30 days"
  if (window === "all") return "All time"
  return "Last 7 days"
}

function harnessLabel(harnessId) {
  return HARNESS_NAMES[harnessId] ?? text(harnessId, "Harness")
}

function scopeLabel(window) {
  const scope = text(window?.scope, "unknown")
  if (scope === "five-hour") return "5-hour"
  if (scope === "weekly") return "Weekly"
  if (scope === "monthly") return "Monthly"
  if (scope === "credit") return "Credits"
  if (scope === "model") return text(window?.bucketName, "Model")
  return text(window?.bucketName, "Window")
}

function toneForRemaining(remaining) {
  if (remaining === null) return "muted"
  if (remaining <= 15) return "danger"
  if (remaining <= 35) return "warn"
  return "good"
}

function quotaModel(quotas) {
  if (!isRecord(quotas) || !Array.isArray(quotas.harnesses)) return { harnesses: [], meters: [] }
  const order = new Map([["claude", 0], ["codex", 1]])
  const harnesses = [...quotas.harnesses]
    .filter((item) => isRecord(item) && typeof item.harnessId === "string")
    .sort((left, right) => (order.get(left.harnessId) ?? 10) - (order.get(right.harnessId) ?? 10) || left.harnessId.localeCompare(right.harnessId))
    .map((item) => ({
      harnessId: item.harnessId,
      label: harnessLabel(item.harnessId),
      state: text(item.state, "unavailable"),
      planType: text(item.planType) || null,
      windows: Array.isArray(item.windows) ? item.windows.filter(isRecord) : [],
      diagnostics: Array.isArray(item.diagnostics) ? item.diagnostics.filter(isRecord) : []
    }))
  const meters = []
  for (const harness of harnesses) {
    for (const window of harness.windows) {
      const remaining = percentOrNull(window.remainingPercent)
      const used = percentOrNull(window.usedPercent)
      const label = scopeLabel(window)
      const bucket = text(window.bucketName)
      meters.push({
        id: `${harness.harnessId}:${text(window.scope, "unknown")}:${text(window.bucketId, "")}:${text(window.window, "")}`,
        harness: harness.harnessId,
        harnessLabel: harness.label,
        label: bucket && bucket !== label ? `${label} · ${bucket}` : label,
        scope: text(window.scope, "unknown"),
        state: harness.state,
        remainingPercent: remaining,
        usedPercent: used,
        resetsAt: text(window.resetsAt) || null,
        source: text(window.source) || undefined,
        confidence: text(window.confidence) || undefined,
        detail: [
          harness.planType ? `${harness.planType} plan` : null,
          text(window.source) || null,
          text(window.confidence) || null
        ].filter(Boolean).join(" · "),
        tone: toneForRemaining(remaining)
      })
    }
  }
  return { harnesses, meters, observedAt: text(quotas.observedAt) || null }
}

function summaryEntries(quota) {
  return quota.harnesses.map((harness) => {
    const fiveHourRemaining = harness.windows
      .filter((window) => window.scope === "five-hour")
      .map((window) => percentOrNull(window.remainingPercent))
      .find((value) => value !== null)
    return {
      id: harness.harnessId,
      label: harness.label,
      state: harness.state,
      remainingPercent: fiveHourRemaining ?? null,
      detail: harness.diagnostics.find((item) => typeof item.message === "string")?.message
    }
  })
}

function metricsModel(metrics, window) {
  if (!isRecord(metrics)) return null
  const classes = Array.isArray(metrics.classes) ? metrics.classes.filter(isRecord) : []
  const providers = Array.isArray(metrics.providers) ? metrics.providers.filter(isRecord) : []
  const exact = classes.find((item) => item.class === "exact-local")
  const estimated = classes.find((item) => item.class === "estimated-local")
  const exactProviders = providers.filter((item) => item.class === "exact-local")
  const operations = exactProviders.reduce((total, item) => total + (numberOrNull(item.operations) ?? 0), 0)
  const exactSaved = numberOrNull(exact?.saved)
  const estimatedSaved = numberOrNull(estimated?.saved)
  const daily = Array.isArray(metrics.daily) ? metrics.daily.filter(isRecord) : []
  const exactDaily = daily.filter((item) => item.class === "exact-local" && numberOrNull(item.saved) !== null)
  const dailyByDate = new Map()
  for (const item of exactDaily) {
    const date = text(item.date)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    dailyByDate.set(date, (dailyByDate.get(date) ?? 0) + (numberOrNull(item.saved) ?? 0))
  }
  const stats = []
  if (exactSaved !== null) {
    stats.push({
      id: "exact-saved",
      label: "Exact local saved",
      value: exactSaved,
      unit: text(exact?.unit, "tokens"),
      format: "number",
      detail: `${windowLabel(window)}${operations ? ` · ${operations} recorded operations` : ""}`
    })
  }
  if (estimatedSaved !== null && estimatedSaved > 0) {
    stats.push({
      id: "estimated-saved",
      label: "Estimated local saved",
      value: estimatedSaved,
      unit: text(estimated?.unit, "characters"),
      format: "number",
      detail: "Estimated, kept separate from exact savings"
    })
  }
  const coverage = numberOrNull(metrics.coveragePercent)
  if (coverage !== null) {
    stats.push({
      id: "coverage",
      label: "Coverage",
      value: coverage,
      unit: "%",
      format: "percent",
      detail: "Recorded output coverage"
    })
  }
  if (stats.length === 0) {
    stats.push({
      id: "no-metrics",
      label: "Measured savings",
      value: "No local evidence yet",
      format: "text",
      detail: "Keep using your coding agents; Token Harness records observed changes."
    })
  }
  const points = [...dailyByDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-14)
    .map(([date, value]) => ({ label: date.slice(5), value }))
  return {
    stats,
    chart: points.length ? {
      title: "Exact local savings",
      unit: text(exact?.unit, "tokens"),
      points
    } : null,
    operations,
    observedFrom: text(metrics.firstRecordedAt) || null,
    observedTo: text(metrics.lastRecordedAt) || null,
    scope: text(metrics.scope, "all-projects")
  }
}

function savingsToMetrics(savings, window) {
  if (!isRecord(savings) || !Array.isArray(savings.rows)) return null
  const providers = savings.rows
    .filter((row) => isRecord(row) && numberOrNull(row.saved) !== null)
    .map((row) => ({
      providerId: text(row.providerId, "provider"),
      saved: numberOrNull(row.saved) ?? 0,
      unit: text(row.unit),
      class: text(row.unit) === "tokens" ? "exact-local" : "estimated-local",
      operations: numberOrNull(row.operations) ?? 0,
      before: numberOrNull(row.before),
      after: numberOrNull(row.after)
    }))
  const exactRows = providers.filter((row) => row.class === "exact-local")
  const estimatedRows = providers.filter((row) => row.class === "estimated-local")
  const sum = (rows) => rows.reduce((total, row) => total + row.saved, 0)
  const classes = []
  if (exactRows.length) {
    classes.push({
      class: "exact-local",
      unit: exactRows[0].unit,
      saved: sum(exactRows),
      note: null
    })
  }
  if (estimatedRows.length) {
    classes.push({
      class: "estimated-local",
      unit: estimatedRows[0].unit,
      saved: sum(estimatedRows),
      note: "Estimated from recorded output"
    })
  }
  return {
    scope: "all-projects",
    classes,
    providers,
    daily: [],
    coveragePercent: null,
    firstRecordedAt: text(savings.firstRecordedAt) || null,
    lastRecordedAt: text(savings.lastRecordedAt) || null,
    window
  }
}

async function collectUsage(cli, context, config) {
  const home = tokenHarnessHome(context)
  const diagnostics = []
  const supportsObserve = versionAtLeast(cli.version, MIN_OBSERVE_VERSION)
  if (supportsObserve) {
    try {
      const observe = await runJSON(cli.path, ["observe", "--json", "--since", config.window], {
        cwd: home,
        env: { HOME: home },
        timeout: 75_000
      })
      if (observe?.status === "ok" && observe?.data && isRecord(observe.data)) {
        return {
          quotas: observe.data.quotas ?? null,
          metrics: observe.data.metrics ?? null,
          agents: Array.isArray(observe.data.agents) ? observe.data.agents : [],
          diagnostics,
          supportsObserve,
          source: "observe"
        }
      }
      diagnostics.push(diagnostic({
        severity: "warning",
        message: firstDiagnostic(observe, "token-harness observe did not return a report"),
        detail: "The plugin fell back to the budget and savings commands."
      }))
    } catch (error) {
      diagnostics.push(diagnostic({
        severity: "warning",
        message: `token-harness observe failed: ${compactError(error)}`,
        detail: "The plugin fell back to the budget and savings commands."
      }))
    }
  } else {
    diagnostics.push(diagnostic({
      severity: "info",
      message: `Token Harness ${cli.version ?? "is present but its version is unknown"} does not provide the combined observe command.`,
      detail: "Harness Remote still reads current quota with budget and recorded savings with savings. Update Token Harness only for the combined observe report."
    }))
  }

  const [budget, savings] = await Promise.all([
    runJSON(cli.path, ["budget", "--json"], { cwd: home, env: { HOME: home }, timeout: 45_000 }).catch((error) => ({ status: "error", diagnostics: [{ message: compactError(error) }] })),
    runJSON(cli.path, ["savings", "--json", "--since", config.window], { cwd: home, env: { HOME: home }, timeout: 45_000 }).catch((error) => ({ status: "error", diagnostics: [{ message: compactError(error) }] }))
  ])
  if (budget?.status === "ok" && budget?.data) {
    diagnostics.push(...(Array.isArray(budget.diagnostics) ? budget.diagnostics.filter(isRecord) : []).map((item) => diagnostic({
      severity: item.severity,
      message: text(item.message, "Quota observation"),
      detail: text(item.remediation)
    })))
  } else {
    diagnostics.push(diagnostic({
      severity: "warning",
      message: firstDiagnostic(budget, "token-harness budget did not return a report")
    }))
  }
  return {
    quotas: budget?.status === "ok" ? budget.data : null,
    metrics: savings?.status === "ok" ? savingsToMetrics(savings.data, config.window) : null,
    agents: [],
    diagnostics,
    supportsObserve,
    source: supportsObserve ? "fallback" : "legacy"
  }
}

async function detectAgentBinaries(context) {
  const agents = []
  for (const harnessId of ["claude", "codex", "opencode", "pi", "omp"]) {
    if (await findExecutable(harnessId, context)) {
      agents.push({ harnessId, name: harnessLabel(harnessId), state: "detected", version: null })
    }
  }
  return agents
}

function hasRoutingMarker(value) {
  if (typeof value === "string") return value.includes("__internal-prompt-router")
  if (Array.isArray(value)) return value.some(hasRoutingMarker)
  if (!isRecord(value)) return false
  return Object.values(value).some(hasRoutingMarker)
}

function routingConfigPath(home, harness) {
  return harness === "claude"
    ? path.join(home, ".claude", "settings.json")
    : path.join(home, ".codex", "hooks.json")
}

async function readRouting(home, harness) {
  const configPath = routingConfigPath(home, harness)
  const base = {
    harness,
    configPath,
    complete: false,
    partial: false,
    state: "absent",
    label: "Off",
    detail: "No Token Harness native prompt hook is installed.",
    disabledAllHooks: false
  }
  let raw
  try {
    raw = await readFile(configPath, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return base
    return {
      ...base,
      state: "unknown",
      label: "Could not verify",
      detail: `The hook settings file could not be read: ${compactError(error)}`
    }
  }
  let doc
  try {
    doc = JSON.parse(raw)
  } catch {
    return {
      ...base,
      state: "unknown",
      label: "Needs review",
      detail: "The hook settings file is malformed JSON or contains comments."
    }
  }
  if (!isRecord(doc)) {
    return {
      ...base,
      state: "unknown",
      label: "Needs review",
      detail: "The hook settings root is not an object."
    }
  }
  const hooks = isRecord(doc.hooks) ? doc.hooks : {}
  let completeCount = 0
  let routeCount = 0
  for (const event of ROUTING_EVENTS) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] : []
    const routed = entries.filter((entry) => hasRoutingMarker(entry))
    routeCount += routed.length
    if (routed.length > 0) completeCount += 1
  }
  const complete = completeCount === ROUTING_EVENTS.length && routeCount === ROUTING_EVENTS.length
  const partial = routeCount > 0 && !complete
  const disabledAllHooks = doc.disableAllHooks === true
  return {
    ...base,
    complete,
    partial,
    state: complete ? "managed" : partial ? "conflict" : "absent",
    label: complete ? (disabledAllHooks ? "On · hooks paused" : "On") : partial ? "Needs review" : "Off",
    detail: complete
      ? disabledAllHooks
        ? `Token Harness routing hooks are installed, but Claude's disableAllHooks setting is on. ${configPath}`
        : `Token Harness routing hooks are installed in ${configPath}.`
      : partial
        ? `Some Token Harness routing hooks are present but the set is incomplete. Review ${configPath}.`
        : "No Token Harness native prompt hook is installed.",
    disabledAllHooks
  }
}

async function detectRouting(context) {
  const home = tokenHarnessHome(context)
  const [claude, codex] = await Promise.all([readRouting(home, "claude"), readRouting(home, "codex")])
  return { claude, codex }
}

function routingField(routing, installed) {
  const disabled = !installed || routing.state === "unknown"
  return {
    id: `routing.${routing.harness}`,
    type: "toggle",
    label: `${harnessLabel(routing.harness)} routing`,
    description: routing.harness === "claude"
      ? "Adds Token Harness's native per-prompt routing hook to Claude Code."
      : "Adds Token Harness's native per-prompt routing hook to Codex.",
    value: installed && routing.complete === true,
    stateLabel: installed ? routing.label : "Not installed",
    disabled,
    help: installed
      ? routing.detail
      : `${harnessLabel(routing.harness)} was not detected on this machine.`,
    tone: routing.state === "conflict" || routing.state === "unknown" ? "warn" : undefined
  }
}

function buildSettings(context, config, routing, agents) {
  const installed = new Set(
    agents
      .filter((agent) => isRecord(agent) && typeof agent.harnessId === "string" && agent.state !== "absent")
      .map((agent) => agent.harnessId)
  )
  return {
    sections: [
      {
        id: "routing",
        title: "Automatic model routing",
        description: "Token Harness can add a native prompt hook that asks the harness to delegate eligible bounded work to a cheaper subagent. It never changes the root model.",
        fields: [
          routingField(routing.claude, installed.has("claude")),
          routingField(routing.codex, installed.has("codex"))
        ]
      },
      {
        id: "dashboard",
        title: "Dashboard",
        description: "Choose the savings window used by the dashboard. Live quota readings always use the current window.",
        fields: [
          {
            id: "window",
            type: "select",
            label: "Savings window",
            description: "Exact and estimated local savings are always reported separately.",
            value: config.window,
            options: [
              { value: "7d", label: "Last 7 days" },
              { value: "30d", label: "Last 30 days" },
              { value: "all", label: "All time" }
            ]
          }
        ]
      },
      {
        id: "optimizers",
        title: "Optimizers",
        description: "RTK, HarnessTrim and the other Token Harness optimizers are configured by Token Harness itself. Use Open Token Harness to enable, disable or review them. Automatic routing can be changed directly above.",
        fields: []
      }
    ]
  }
}

function buildContributions(quota, metrics, supportsObserve) {
  const entries = summaryEntries(quota)
  const stats = metrics?.stats ?? []
  const home = {
    title: "Token Harness",
    subtitle: `${windowLabelSafe(metrics)} · stored local evidence`,
    footnote: "Local token reductions are not subscription quota. Quota percentages come from each harness.",
    harnesses: entries.map((entry) => ({
      harnessId: entry.id,
      label: entry.label,
      state: entry.state,
      remainingPercent: entry.remainingPercent,
      detail: entry.detail
    })),
    meters: quota.meters,
    stats,
    chart: metrics?.chart ?? null
  }
  if (!supportsObserve) {
    home.footnote = `${home.footnote} Quota comes from budget; recorded savings come from savings.`
  }
  return { home }
}

function windowLabelSafe(metrics) {
  return metrics?.window ? windowLabel(metrics.window) : "Last 7 days"
}

function dependencyModel(cli) {
  if (!cli) {
    return {
      state: "missing",
      name: "token-harness",
      version: null,
      path: null,
      manager: "npm",
      compatible: true,
      supportsObserve: false,
      detail: "Token Harness was not found on this machine."
    }
  }
  const supportsObserve = versionAtLeast(cli.version, MIN_OBSERVE_VERSION)
  return {
    state: cli.source,
    name: "token-harness",
    version: cli.version,
    path: cli.path,
    manager: "npm",
    compatible: true,
    supportsObserve,
    detail: cli.source === "managed"
      ? `Installed by Harness Remote${cli.version ? ` · v${cli.version}` : ""}`
      : `Detected on this machine${cli.version ? ` · v${cli.version}` : ""}`
  }
}

function actionModel(cli) {
  if (!cli) {
    return {
      install: { available: true, label: "Install Token Harness" },
      update: { available: false },
      uninstall: { available: false },
      custom: []
    }
  }
  const supportsObserve = versionAtLeast(cli.version, MIN_OBSERVE_VERSION)
  return {
    install: cli.source === "external" && !supportsObserve
      ? { available: true, label: "Install newer copy", reason: `A managed v${MIN_OBSERVE_VERSION}+ copy adds the combined observe report; the current dashboard already uses real budget and savings data.` }
      : { available: false },
    update: cli.source === "managed"
      ? { available: true, label: "Update Token Harness" }
      : { available: false },
    uninstall: cli.source === "managed"
      ? { available: true, label: "Uninstall Token Harness" }
      : { available: false, reason: "This copy was installed outside Harness Remote and will not be removed." },
    custom: [{
      id: "open",
      label: "Open Token Harness",
      tone: "secondary",
      reason: "Opens the Token Harness setup and optimizer dashboard on this machine."
    }]
  }
}

async function status(params) {
  const context = isRecord(params?.context) ? params.context : {}
  const config = normalizeConfig(params?.config)
  const enabled = params?.enabled === true
  const cli = await resolveCli(context)
  const dependency = dependencyModel(cli)
  const actions = actionModel(cli)
  if (!cli) {
    return {
      ready: false,
      dependency,
      actions,
      contributions: {},
      settings: null,
      diagnostics: [
        diagnostic({
          severity: "info",
          message: "Token Harness is not installed on this machine.",
          detail: "Install it from this panel, or keep the copy you manage outside Harness Remote and refresh."
        })
      ]
    }
  }
  if (!enabled) {
    return {
      ready: true,
      dependency,
      actions,
      contributions: {},
      settings: null,
      diagnostics: []
    }
  }

  const usage = await collectUsage(cli, context, config)
  const agents = usage.agents.length ? usage.agents : await detectAgentBinaries(context)
  const routing = await detectRouting(context)
  const quota = quotaModel(usage.quotas)
  const metrics = metricsModel(usage.metrics, config.window)
  if (metrics && usage.metrics) metrics.window = config.window
  const diagnostics = dedupeDiagnostics([
    ...usage.diagnostics,
    ...quota.harnesses.flatMap((harness) => harness.diagnostics
      .filter((item) => item.severity === "warning" || item.severity === "error")
      .map((item) => diagnostic({
        severity: item.severity,
        message: text(item.message, `${harness.label} quota is unavailable`),
        detail: text(item.remediation)
      })))
  ])
  return {
    ready: true,
    dependency,
    actions,
    contributions: buildContributions(quota, metrics, usage.supportsObserve),
    settings: buildSettings(context, config, routing, agents),
    diagnostics,
    message: usage.supportsObserve
      ? `Token Harness ${cli.version ?? ""}`.trim()
      : `Token Harness ${cli.version ?? ""} · budget and recorded savings`.trim()
  }
}

async function install(params) {
  const context = isRecord(params?.context) ? params.context : {}
  const runtimeDirectory = text(context.managedRuntimeDirectory)
  if (!runtimeDirectory) throw new Error("The plugin host did not provide a managed runtime directory")
  const npm = await findExecutable("npm", context)
  if (!npm) throw new Error("npm was not found on this machine, so Token Harness cannot be installed")
  await mkdir(runtimeDirectory, { recursive: true })
  const result = await run(npm, [
    "install",
    "--prefix",
    runtimeDirectory,
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    "token-harness@latest"
  ], {
    cwd: runtimeDirectory,
    timeout: 240_000
  })
  if (result.code !== 0) {
    throw new Error(`Token Harness installation failed: ${tail(result.stderr || result.stdout)}`)
  }
  const cli = await resolveCli(context)
  if (!cli || cli.source !== "managed") {
    throw new Error("npm finished, but the managed token-harness executable was not found")
  }
  return {
    message: `Token Harness ${cli.version ?? ""} installed by Harness Remote`.trim(),
    config: normalizeConfig(params?.config)
  }
}

async function uninstall(params) {
  const context = isRecord(params?.context) ? params.context : {}
  const runtimeDirectory = text(context.managedRuntimeDirectory)
  if (!runtimeDirectory) throw new Error("The plugin host did not provide a managed runtime directory")
  const before = await resolveCli(context)
  await stopDashboard(context)
  await rm(runtimeDirectory, { recursive: true, force: true })
  return {
    message: before?.source === "external"
      ? "The externally installed Token Harness was left untouched. The plugin has been disabled."
      : "The Token Harness copy installed by Harness Remote was removed.",
    config: normalizeConfig(params?.config)
  }
}

async function applyRouting(cli, params, harness, enabled) {
  if (harness !== "claude" && harness !== "codex") throw new Error(`Unsupported harness: ${harness}`)
  const context = isRecord(params?.context) ? params.context : {}
  const home = tokenHarnessHome(context)
  const planArgs = [
    "plan",
    "--harness", harness,
    "--provider", "none",
    enabled ? "--agent-routing" : "--disable-agent-routing",
    "--json"
  ]
  const plan = await runJSON(cli.path, planArgs, { cwd: home, env: { HOME: home }, timeout: 90_000 })
  if (plan?.status === "error" || plan?.status === "blocked" || (typeof plan?.exitCode === "number" && plan.exitCode >= 2)) {
    throw new Error(firstDiagnostic(plan, `Token Harness could not prepare a routing change for ${harness}`))
  }
  const planId = text(plan?.data?.planId)
  if (planId) {
    const applied = await runJSON(cli.path, ["apply", "--plan", planId, "--yes", "--json"], {
      cwd: home,
      env: { HOME: home },
      timeout: 90_000
    })
    if (applied?.status !== "ok" || (typeof applied?.exitCode === "number" && applied.exitCode !== 0)) {
      throw new Error(firstDiagnostic(applied, `Token Harness could not apply the routing change for ${harness}`))
    }
    return `${enabled ? "Enabled" : "Disabled"} automatic model routing for ${harnessLabel(harness)}.`
  }
  const diagnostics = Array.isArray(plan?.diagnostics) ? plan.diagnostics : []
  if (diagnostics.some((item) => item?.code === "prompt-routing-already-configured")) {
    return `Automatic model routing is already ${enabled ? "enabled" : "disabled"} for ${harnessLabel(harness)}.`
  }
  const unsupported = diagnostics.find((item) => item?.code === "prompt-routing-version-unverified")
  if (unsupported) throw new Error(firstDiagnostic(plan, unsupported.message))
  const current = await readRouting(home, harness)
  if (current.complete === enabled) {
    return `Automatic model routing is already ${enabled ? "enabled" : "disabled"} for ${harnessLabel(harness)}.`
  }
  throw new Error(firstDiagnostic(plan, `No safe automatic routing change is available for ${harnessLabel(harness)}`))
}

function dashboardReadyUrl(output) {
  const match = /Token Harness is ready:\s*(http:\/\/(?:127\.0\.0\.1|localhost):\d+\/?)/.exec(output)
  return match ? match[1] : null
}

async function runningDashboard(context) {
  const dataDirectory = text(context.pluginDataDirectory)
  if (!dataDirectory) return null
  try {
    const state = JSON.parse(await readFile(path.join(dataDirectory, "dashboard.json"), "utf8"))
    if (!Number.isInteger(state?.pid) || typeof state?.url !== "string") return null
    process.kill(state.pid, 0)
    return state.url
  } catch {
    return null
  }
}

async function stopDashboard(context) {
  const dataDirectory = text(context.pluginDataDirectory)
  if (!dataDirectory || !(await runningDashboard(context))) return
  await writeFile(path.join(dataDirectory, "dashboard.stop"), "stop")
  const statePath = path.join(dataDirectory, "dashboard.json")
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (!(await exists(statePath))) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Token Harness dashboard did not stop within 3s")
}

async function openDashboard(params) {
  const context = isRecord(params?.context) ? params.context : {}
  const cli = await resolveCli(context)
  if (!cli) throw new Error("Token Harness is not installed")
  const existing = await runningDashboard(context)
  if (existing) return { url: existing, message: "Token Harness is already running." }
  const home = tokenHarnessHome(context)
  const dataDirectory = text(context.pluginDataDirectory) || path.join(home, ".token-harness-plugin")
  await mkdir(dataDirectory, { recursive: true })
  const logPath = path.join(dataDirectory, "dashboard.log")
  const statePath = path.join(dataDirectory, "dashboard.json")
  const runnerPath = path.join(text(context.pluginDirectory, path.dirname(process.argv[1] ?? ".")), "dashboard-runner.cjs")
  await rm(path.join(dataDirectory, "dashboard.stop"), { force: true })
  await writeFile(logPath, "")
  const child = spawn(process.execPath, [runnerPath, cli.path, logPath, home], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home
    },
    detached: true,
    stdio: "ignore",
    windowsHide: true
  })
  if (!child?.pid) throw new Error("Token Harness could not be started")
  child.on("error", () => undefined)
  const deadline = Date.now() + 30_000
  let url = null
  let exitedAt = null
  while (Date.now() < deadline) {
    try {
      url = dashboardReadyUrl(await readFile(logPath, "utf8"))
    } catch {
      url = null
    }
    if (url) break
    if (child.exitCode !== null) {
      // `exitCode` can become visible before the file stream is flushed. Give the runner a short
      // drain window instead of declaring a valid one-shot CLI failed.
      exitedAt ??= Date.now()
      if (Date.now() - exitedAt > 1_000) break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!url) {
    const output = await readFile(logPath, "utf8").catch(() => "")
    throw new Error(`Token Harness did not report a dashboard URL.${output.trim() ? ` ${tail(output)}` : ""}`)
  }
  await writeFile(statePath, JSON.stringify({ pid: child.pid, url, startedAt: new Date().toISOString() }), { mode: 0o600 })
  child.unref()
  return { url, message: "Token Harness is ready." }
}

async function configure(params) {
  const context = isRecord(params?.context) ? params.context : {}
  const previous = normalizeConfig(params?.config)
  const values = isRecord(params?.values) ? params.values : {}
  const cli = await resolveCli(context)
  if (!cli) throw new Error("Token Harness is not installed")
  let config = { ...previous }
  const messages = []
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith("routing.")) {
      const harness = key.slice("routing.".length)
      if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`)
      messages.push(await applyRouting(cli, params, harness, value))
      continue
    }
    if (key === "window") {
      if (!WINDOWS.has(value)) throw new Error("The savings window must be 7d, 30d or all")
      config.window = value
      messages.push(`Savings window set to ${windowLabel(value)}.`)
      continue
    }
    throw new Error(`Unknown Token Harness setting: ${key}`)
  }
  return {
    ok: true,
    config,
    message: messages.join(" ")
  }
}

async function dispatch(method, params) {
  if (method === "status") return await status(params)
  if (method === "deactivate") {
    await stopDashboard(isRecord(params?.context) ? params.context : {})
    return { message: "Token Harness dashboard stopped." }
  }
  if (method === "install" || method === "update") return await install(params)
  if (method === "uninstall") return await uninstall(params)
  if (method === "configure") return await configure(params)
  if (method === "action") {
    const action = text(params?.action)
    if (action === "open") return await openDashboard(params)
    throw new Error(`Unknown Token Harness action: ${action || "missing"}`)
  }
  throw new Error(`Unknown plugin method: ${String(method)}`)
}

let input = ""
for await (const chunk of process.stdin) input += chunk
try {
  const request = JSON.parse(input || "{}")
  const result = await dispatch(request.method, request.params ?? {})
  process.stdout.write(JSON.stringify({ ok: true, result }))
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: compactError(error) }))
}
