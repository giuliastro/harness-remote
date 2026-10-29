import { spawn } from "node:child_process"
import { accessSync, constants as fsConstants } from "node:fs"
import { mkdir, readFile, readdir, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { JsonFileStore } from "../json-file-store.js"

/**
 * Local plugin runtime for the machine daemon.
 *
 * A plugin is a directory with a `harness-plugin.json` manifest. Its backend entry is an ordinary
 * Node or Python program that speaks one JSON request on stdin and one JSON response on stdout. The
 * daemon never imports plugin code into its own process: a broken or slow plugin can only fail its
 * own request, and a plugin update cannot leave the daemon's module graph half-reloaded.
 *
 * The manifest supplies discovery metadata; the plugin's `status` method supplies everything that
 * depends on the machine (is the external app installed, which version, which views are useful).
 * That split is what lets Harness Remote detect a Token Harness install that happened outside the
 * application while keeping the UI declarative and safe.
 */

export const PLUGIN_MANIFEST_FILE = "harness-plugin.json"
export const PLUGIN_SURFACES = ["backend", "frontend"]
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const DEFAULT_STATUS_CACHE_MS = 120_000
const STATUS_TIMEOUT_MS = 90_000
const ACTION_TIMEOUT_MS = 300_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const STATUS_CONCURRENCY = 3
const STORAGE_CACHE_MS = 5 * 60_000
const STORAGE_SCAN_LIMIT = 10_000

function pluginError(code, message, options = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, options)
  return error
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function boundedString(value, maxLength = 2_000) {
  return typeof value === "string" ? value.slice(0, maxLength) : undefined
}

function pluginStateDefaults() {
  return { schemaVersion: 1, plugins: {} }
}

function sanitizeConfig(value) {
  if (!isRecord(value)) return {}
  const entries = Object.entries(value).filter(([key, item]) =>
    /^[A-Za-z0-9._:-]{1,160}$/.test(key)
    && (typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null)
  )
  const config = Object.fromEntries(entries)
  if (Buffer.byteLength(JSON.stringify(config), "utf8") > 64 * 1024) return {}
  return config
}

function sanitizeState(raw) {
  const state = pluginStateDefaults()
  if (!isRecord(raw) || !isRecord(raw.plugins)) return state
  for (const [id, value] of Object.entries(raw.plugins)) {
    if (!PLUGIN_ID.test(id) || !isRecord(value)) continue
    state.plugins[id] = {
      enabled: value.enabled === true,
      config: sanitizeConfig(value.config),
      ...(boundedString(value.installedAt, 80) ? { installedAt: boundedString(value.installedAt, 80) } : {}),
      ...(boundedString(value.updatedAt, 80) ? { updatedAt: boundedString(value.updatedAt, 80) } : {})
    }
  }
  return state
}

export function defaultPluginBuiltinDirectory() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "builtin")
}

export function pluginHostPaths(stateDirectory, { builtinDirectory } = {}) {
  if (typeof stateDirectory !== "string" || !stateDirectory.trim()) throw new Error("Plugin host requires a state directory")
  const pluginsDirectory = path.join(stateDirectory, "plugins")
  return {
    builtinDirectory: builtinDirectory ?? defaultPluginBuiltinDirectory(),
    pluginsDirectory,
    userDirectory: path.join(pluginsDirectory, "user"),
    dataDirectory: path.join(pluginsDirectory, "data"),
    stateFile: path.join(pluginsDirectory, "state.json")
  }
}

function commandCandidates(name, platform) {
  if (platform !== "win32") return [name]
  return [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name]
}

export function findOnPath(name, { environment = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (typeof name !== "string" || !/^[A-Za-z0-9._+-]+$/.test(name)) return null
  const directories = [
    ...String(environment.PATH ?? "").split(path.delimiter).filter(Boolean),
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
      try {
        accessSync(target, fsConstants.X_OK)
        return target
      } catch {
        // Try the next spelling or directory.
      }
    }
  }
  return null
}

function networkEnvironment(environment) {
  return {
    ...environment,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    CI: environment.CI ?? "1"
  }
}

function parseManifest(raw, directory, builtIn) {
  if (!isRecord(raw)) throw new Error("Manifest must be a JSON object")
  const id = boundedString(raw.id, 64)
  const name = boundedString(raw.name, 120)
  const version = boundedString(raw.version, 40)
  const runtime = isRecord(raw.runtime) ? raw.runtime : null
  if (!id || !PLUGIN_ID.test(id)) throw new Error("Manifest id is missing or invalid")
  if (!name) throw new Error("Manifest name is missing")
  if (!version) throw new Error("Manifest version is missing")
  if (!runtime || (runtime.kind !== "node" && runtime.kind !== "python")) throw new Error("Manifest runtime.kind must be node or python")
  const entry = boundedString(runtime.entry, 400)
  if (!entry) throw new Error("Manifest runtime.entry is missing")
  const entryPath = path.resolve(directory, entry)
  if (entryPath !== directory && !entryPath.startsWith(`${directory}${path.sep}`)) throw new Error("Plugin entry escapes its directory")
  return {
    id,
    name,
    version,
    description: boundedString(raw.description, 1_000) ?? "",
    vendor: boundedString(raw.vendor, 160),
    homepage: boundedString(raw.homepage, 500),
    license: boundedString(raw.license, 80),
    icon: boundedString(raw.icon, 80) ?? "puzzle",
    builtIn,
    autoEnableWhenReady: raw.autoEnableWhenReady !== false,
    surfaces: Array.isArray(raw.surfaces)
      ? raw.surfaces.filter((surface) => PLUGIN_SURFACES.includes(surface))
      : ["backend", "frontend"],
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.filter((item) => typeof item === "string").slice(0, 32).map((item) => item.slice(0, 80)) : [],
    permissions: Array.isArray(raw.permissions) ? raw.permissions.filter((item) => typeof item === "string").slice(0, 32).map((item) => item.slice(0, 80)) : [],
    order: Number.isFinite(raw.order) ? Number(raw.order) : 100,
    directory,
    entryPath,
    runtime: {
      kind: runtime.kind,
      deactivateOnDisable: runtime.deactivateOnDisable === true,
      ...(Number.isFinite(runtime.timeoutMs) && runtime.timeoutMs > 0
        ? { timeoutMs: Math.min(Number(runtime.timeoutMs), ACTION_TIMEOUT_MS) }
        : {})
    },
    manifestPath: path.join(directory, PLUGIN_MANIFEST_FILE)
  }
}

async function readManifest(directory, builtIn) {
  const manifestPath = path.join(directory, PLUGIN_MANIFEST_FILE)
  const raw = JSON.parse(await readFile(manifestPath, "utf8"))
  return parseManifest(raw, directory, builtIn)
}

function manifestSummary(manifest) {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    vendor: manifest.vendor,
    homepage: manifest.homepage,
    license: manifest.license,
    icon: manifest.icon,
    builtIn: manifest.builtIn,
    surfaces: manifest.surfaces,
    capabilities: manifest.capabilities,
    permissions: manifest.permissions,
    runtime: { kind: manifest.runtime.kind }
  }
}

function normalizeAction(value, fallbackLabel) {
  if (!isRecord(value) || value.available !== true) {
    return { available: false, label: fallbackLabel }
  }
  return {
    available: true,
    label: boundedString(value.label, 160) ?? fallbackLabel,
    ...(boundedString(value.reason, 500) ? { reason: boundedString(value.reason, 500) } : {})
  }
}

function normalizeCustomActions(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => isRecord(item) && typeof item.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id))
    .slice(0, 8)
    .map((item) => ({
      id: item.id,
      label: boundedString(item.label, 160) ?? item.id,
      style: ["primary", "secondary", "danger"].includes(item.style) ? item.style : "secondary"
    }))
}

function normalizeActions(value) {
  const actions = isRecord(value) ? value : {}
  return {
    install: normalizeAction(actions.install, "Install"),
    update: normalizeAction(actions.update, "Update"),
    uninstall: normalizeAction(actions.uninstall, "Uninstall"),
    custom: normalizeCustomActions(actions.custom)
  }
}

function normalizeDiagnostics(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => isRecord(item) && typeof item.message === "string")
    .slice(0, 24)
    .map((item) => ({
      severity: ["error", "warning", "info"].includes(item.severity) ? item.severity : "info",
      message: item.message.slice(0, 1_000),
      ...(boundedString(item.detail, 1_000) ? { detail: boundedString(item.detail, 1_000) } : {})
    }))
}

function boundedNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function normalizeTone(value) {
  return ["good", "warn", "danger", "muted"].includes(value) ? value : undefined
}

function normalizeMeter(value, index) {
  if (!isRecord(value)) return null
  const remaining = boundedNumber(value.remainingPercent)
  return {
    id: boundedString(value.id, 120) ?? `meter-${index}`,
    harness: boundedString(value.harness, 80),
    harnessLabel: boundedString(value.harnessLabel, 120) ?? boundedString(value.harness, 80) ?? "Harness",
    label: boundedString(value.label, 160) ?? "Window",
    scope: boundedString(value.scope, 80) ?? "unknown",
    state: boundedString(value.state, 40) ?? "unknown",
    remainingPercent: remaining === null ? null : Math.min(100, Math.max(0, remaining)),
    usedPercent: (() => {
      const used = boundedNumber(value.usedPercent)
      return used === null ? null : Math.min(100, Math.max(0, used))
    })(),
    resetsAt: boundedString(value.resetsAt, 80) ?? null,
    source: boundedString(value.source, 80),
    confidence: boundedString(value.confidence, 80),
    detail: boundedString(value.detail, 800),
    tone: normalizeTone(value.tone)
  }
}

function normalizeStat(value, index) {
  if (!isRecord(value)) return null
  const numeric = boundedNumber(value.value)
  return {
    id: boundedString(value.id, 120) ?? `stat-${index}`,
    label: boundedString(value.label, 160) ?? "Statistic",
    value: numeric ?? boundedString(value.value, 160) ?? "—",
    unit: boundedString(value.unit, 40),
    format: ["number", "text", "percent"].includes(value.format) ? value.format : numeric === null ? "text" : "number",
    detail: boundedString(value.detail, 800)
  }
}

function normalizeChart(value) {
  if (!isRecord(value) || !Array.isArray(value.points)) return null
  const points = value.points
    .filter((point) => isRecord(point) && boundedNumber(point.value) !== null)
    .slice(0, 90)
    .map((point, index) => ({
      label: boundedString(point.label, 80) ?? String(index + 1),
      value: boundedNumber(point.value) ?? 0
    }))
  if (points.length === 0) return null
  return {
    title: boundedString(value.title, 160),
    unit: boundedString(value.unit, 40),
    points
  }
}

function normalizeHarnessSummary(value, index) {
  if (!isRecord(value)) return null
  const remaining = boundedNumber(value.remainingPercent)
  return {
    harnessId: boundedString(value.harnessId, 80) ?? `harness-${index}`,
    label: boundedString(value.label, 120) ?? "Harness",
    state: boundedString(value.state, 40) ?? "unknown",
    remainingPercent: remaining === null ? null : Math.min(100, Math.max(0, remaining)),
    detail: boundedString(value.detail, 800)
  }
}

function normalizeContributions(value) {
  if (!isRecord(value)) return {}
  const contributions = {}
  if (isRecord(value.home)) {
    contributions.home = {
      title: boundedString(value.home.title, 160) ?? "Plugin",
      subtitle: boundedString(value.home.subtitle, 800),
      footnote: boundedString(value.home.footnote, 1_000),
      harnesses: Array.isArray(value.home.harnesses)
        ? value.home.harnesses.map(normalizeHarnessSummary).filter(Boolean).slice(0, 16)
        : [],
      meters: Array.isArray(value.home.meters)
        ? value.home.meters.map(normalizeMeter).filter(Boolean).slice(0, 24)
        : [],
      stats: Array.isArray(value.home.stats)
        ? value.home.stats.map(normalizeStat).filter(Boolean).slice(0, 12)
        : [],
      chart: normalizeChart(value.home.chart)
    }
  }
  return contributions
}

function normalizeSettings(value) {
  if (!isRecord(value) || !Array.isArray(value.sections)) return null
  return {
    sections: value.sections
      .filter((section) => isRecord(section) && typeof section.id === "string" && Array.isArray(section.fields))
      .slice(0, 12)
      .map((section) => ({
        id: section.id.slice(0, 80),
        title: boundedString(section.title, 160) ?? section.id,
        description: boundedString(section.description, 800),
        fields: section.fields
          .filter((field) => isRecord(field) && typeof field.id === "string" && ["toggle", "select", "text"].includes(field.type))
          .slice(0, 32)
          .map((field) => ({
            id: field.id.slice(0, 120),
            type: field.type,
            label: boundedString(field.label, 160) ?? field.id,
            description: boundedString(field.description, 800),
            value: field.value,
            stateLabel: boundedString(field.stateLabel, 160),
            help: boundedString(field.help, 800),
            disabled: field.disabled === true,
            options: Array.isArray(field.options)
              ? field.options
                .filter((option) => isRecord(option) && (typeof option.value === "string" || typeof option.value === "number"))
                .slice(0, 48)
                .map((option) => ({
                  value: String(option.value),
                  label: boundedString(option.label, 160) ?? String(option.value)
                }))
              : undefined
          }))
      }))
  }
}

/**
 * A status payload is data, not code: keep only the shapes the renderer understands and bound every
 * string. A user-installed plugin must not be able to grow the daemon's response or smuggle an
 * unexpected field into the renderer's declarative contribution surface.
 */
function normalizeStatus(value) {
  if (!isRecord(value)) throw new Error("Plugin status response must be an object")
  const dependencyValue = isRecord(value.dependency) ? value.dependency : null
  const dependency = dependencyValue
    ? {
      state: ["missing", "external", "managed"].includes(dependencyValue.state) ? dependencyValue.state : "missing",
      name: boundedString(dependencyValue.name, 160) ?? "dependency",
      version: boundedString(dependencyValue.version, 80) ?? null,
      path: boundedString(dependencyValue.path, 2_000) ?? null,
      manager: boundedString(dependencyValue.manager, 80) ?? null,
      compatible: dependencyValue.compatible !== false,
      supportsObserve: dependencyValue.supportsObserve === true,
      detail: boundedString(dependencyValue.detail, 1_000)
    }
    : null
  return {
    ready: value.ready === true,
    dependency,
    actions: normalizeActions(value.actions),
    contributions: normalizeContributions(value.contributions),
    settings: normalizeSettings(value.settings),
    diagnostics: normalizeDiagnostics(value.diagnostics),
    ...(boundedString(value.message, 2_000) ? { message: boundedString(value.message, 2_000) } : {})
  }
}

function statusState(status, enabled) {
  if (status.ready !== true) return "available"
  if (!enabled) return "disabled"
  return "active"
}

export class PluginHost {
  #manifests
  #state
  #stateWrite = Promise.resolve()
  #statusCache = new Map()
  #storageCache = new Map()
  #listQueue = Promise.resolve()
  #closed = false
  #store

  constructor({
    stateDirectory,
    builtinDirectory,
    userDirectory,
    dataDirectory,
    stateFile,
    environment = process.env,
    home = os.homedir(),
    platform = process.platform,
    arch = process.arch,
    warn = (message) => process.stderr.write(`[plugins] ${message}\n`),
    statusCacheMs = DEFAULT_STATUS_CACHE_MS
  } = {}) {
    const paths = pluginHostPaths(stateDirectory, { builtinDirectory })
    this.paths = {
      ...paths,
      ...(userDirectory ? { userDirectory } : {}),
      ...(dataDirectory ? { dataDirectory } : {}),
      ...(stateFile ? { stateFile } : {})
    }
    this.environment = environment
    this.home = home
    this.platform = platform
    this.arch = arch
    this.warn = warn
    this.statusCacheMs = statusCacheMs
    this.#store = new JsonFileStore({ filePath: this.paths.stateFile, stateDirectory: this.paths.pluginsDirectory, warn })
  }

  get statePath() {
    return this.paths.stateFile
  }

  async #loadState() {
    if (this.#state) return this.#state
    const raw = await this.#store.read()
    this.#state = sanitizeState(raw)
    return this.#state
  }

  #updateState(change) {
    const operation = async () => {
      const current = await this.#loadState()
      const next = sanitizeState(change(structuredClone(current)))
      this.#state = next
      await this.#store.write(next, { pretty: true })
      return next
    }
    this.#stateWrite = this.#stateWrite.then(operation, operation)
    return this.#stateWrite
  }

  async #loadManifests() {
    if (this.#manifests) return this.#manifests
    const found = []
    const seen = new Set()
    for (const { directory, builtIn } of [
      { directory: this.paths.builtinDirectory, builtIn: true },
      { directory: this.paths.userDirectory, builtIn: false }
    ]) {
      let entries = []
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if (error?.code !== "ENOENT") this.warn(`Cannot read plugin directory ${directory}: ${error.message}`)
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue
        const pluginDirectory = path.join(directory, entry.name)
        try {
          const manifest = await readManifest(pluginDirectory, builtIn)
          if (seen.has(manifest.id)) {
            if (!builtIn) this.warn(`Ignoring user plugin ${manifest.id}: a built-in plugin already provides it`)
            continue
          }
          await stat(manifest.entryPath)
          seen.add(manifest.id)
          found.push(manifest)
        } catch (error) {
          this.warn(`Ignoring plugin at ${pluginDirectory}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    found.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    this.#manifests = found
    return found
  }

  async manifests() {
    return (await this.#loadManifests()).map(manifestSummary)
  }

  async #manifest(id) {
    const manifest = (await this.#loadManifests()).find((candidate) => candidate.id === id)
    if (!manifest) throw pluginError("unknown_plugin", `Unknown plugin: ${id}`)
    return manifest
  }

  #dataDirectory(id) {
    const directory = path.join(this.paths.dataDirectory, id)
    return directory
  }

  async #storageUsage(id) {
    const cached = this.#storageCache.get(id)
    if (cached && Date.now() - cached.at < STORAGE_CACHE_MS) return cached.value
    const pending = [this.#dataDirectory(id)]
    let bytes = 0
    let visited = 0
    let complete = true
    while (pending.length && visited < STORAGE_SCAN_LIMIT) {
      const directory = pending.pop()
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if (error?.code !== "ENOENT") complete = false
        continue
      }
      for (const entry of entries) {
        if (++visited > STORAGE_SCAN_LIMIT) {
          complete = false
          break
        }
        const target = path.join(directory, entry.name)
        // Never follow links outside the plugin's managed data directory.
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) pending.push(target)
        else if (entry.isFile()) {
          try { bytes += (await stat(target)).size } catch { complete = false }
        }
      }
    }
    if (pending.length) complete = false
    const value = { bytes, complete }
    this.#storageCache.set(id, { at: Date.now(), value })
    return value
  }

  async #context(manifest, record) {
    const dataDirectory = this.#dataDirectory(manifest.id)
    await mkdir(dataDirectory, { recursive: true })
    return {
      pluginId: manifest.id,
      pluginDirectory: manifest.directory,
      pluginDataDirectory: dataDirectory,
      managedRuntimeDirectory: path.join(dataDirectory, "runtime"),
      stateDirectory: this.paths.pluginsDirectory,
      home: this.home,
      platform: this.platform,
      arch: this.arch,
      installedByHarnessRemote: record?.enabled === true && Boolean(record?.installedAt)
    }
  }

  #pythonCommand() {
    return findOnPath("python3", { environment: this.environment, home: this.home, platform: this.platform })
      ?? findOnPath("python", { environment: this.environment, home: this.home, platform: this.platform })
  }

  #commandFor(manifest) {
    if (manifest.runtime.kind === "python") {
      const python = this.#pythonCommand()
      if (!python) throw pluginError("plugin_runtime_missing", "Python 3 is not available on this machine")
      return { command: python, args: [manifest.entryPath], env: networkEnvironment(this.environment) }
    }
    const env = networkEnvironment(this.environment)
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1"
    return { command: process.execPath, args: [manifest.entryPath], env }
  }

  async #invoke(manifest, method, params, timeoutMs) {
    if (this.#closed) throw pluginError("plugin_closed", "The plugin host is shutting down")
    const invocation = this.#commandFor(manifest)
    const request = JSON.stringify({ schemaVersion: 1, method, params })
    return await new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(invocation.command, invocation.args, {
          cwd: manifest.directory,
          env: {
            ...invocation.env,
            HARNESS_REMOTE_PLUGIN_ID: manifest.id,
            HARNESS_REMOTE_PLUGIN_DATA: this.#dataDirectory(manifest.id),
            HARNESS_REMOTE_PLUGIN_ROOT: manifest.directory
          },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        })
      } catch (error) {
        reject(pluginError("plugin_spawn_failed", `Cannot start ${manifest.name}: ${error instanceof Error ? error.message : String(error)}`))
        return
      }
      const stdout = []
      const stderr = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false
      let forceKill
      const finish = (error, payload) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(forceKill)
        if (error) reject(error)
        else resolve(payload)
      }
      const timer = setTimeout(() => {
        child.kill("SIGTERM")
        forceKill = setTimeout(() => child.kill("SIGKILL"), 2_000)
        finish(pluginError("plugin_timeout", `${manifest.name} did not answer within ${Math.round(timeoutMs / 1_000)}s`))
      }, timeoutMs)
      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > MAX_OUTPUT_BYTES) {
          child.kill("SIGKILL")
          finish(pluginError("plugin_output_too_large", `${manifest.name} produced too much output`))
          return
        }
        stdout.push(chunk)
      })
      child.stderr.on("data", (chunk) => {
        if (stderrBytes >= 64 * 1024) return
        stderrBytes += chunk.byteLength
        stderr.push(chunk)
      })
      child.once("error", (error) => {
        finish(pluginError("plugin_spawn_failed", `Cannot start ${manifest.name}: ${error.message}`))
      })
      child.once("close", (code) => {
        if (settled) return
        const out = Buffer.concat(stdout).toString("utf8").trim()
        const err = Buffer.concat(stderr).toString("utf8").trim()
        let payload
        try {
          payload = JSON.parse(out)
        } catch {
          const detail = err || out.slice(0, 500) || `exit code ${String(code)}`
          finish(pluginError("plugin_invalid_response", `${manifest.name} returned an unreadable response: ${detail}`, { stderr: err.slice(0, 4_000) }))
          return
        }
        if (!isRecord(payload)) {
          finish(pluginError("plugin_invalid_response", `${manifest.name} returned an invalid response`))
          return
        }
        if (payload.ok !== true) {
          const message = boundedString(payload.error, 2_000) ?? err.slice(0, 2_000) ?? "Plugin method failed"
          finish(pluginError("plugin_method_failed", message, { stderr: err.slice(0, 4_000) }))
          return
        }
        finish(undefined, payload.result)
      })
      child.stdin.once("error", () => undefined)
      child.stdin.end(request)
    })
  }

  async #status(manifest, enabled, { refresh = false } = {}) {
    const cached = this.#statusCache.get(manifest.id)
    if (!refresh && cached && cached.enabled === enabled && Date.now() - cached.at < this.statusCacheMs) {
      return cached.value
    }
    const state = await this.#loadState()
    const record = state.plugins[manifest.id]
    const context = await this.#context(manifest, record)
    const timeoutMs = manifest.runtime.timeoutMs ?? STATUS_TIMEOUT_MS
    const value = normalizeStatus(await this.#invoke(manifest, "status", {
      enabled,
      config: record?.config ?? {},
      context
    }, timeoutMs))
    this.#statusCache.set(manifest.id, { at: Date.now(), enabled, value })
    return value
  }

  #item(manifest, status, enabled) {
    return {
      ...manifestSummary(manifest),
      enabled,
      ready: status.ready === true,
      state: statusState(status, enabled),
      dependency: status.dependency,
      actions: status.actions,
      contributions: status.contributions,
      settings: status.settings,
      diagnostics: status.diagnostics,
      ...(status.message ? { message: status.message } : {}),
      checkedAt: new Date().toISOString()
    }
  }

  async #itemFor(manifest, { refresh = false } = {}) {
    const state = await this.#loadState()
    const record = state.plugins[manifest.id]
    // A directory placed on disk must not execute user-supplied code during catalogue discovery.
    // The explicit Enable action is the trust boundary for user plugins.
    if (!manifest.builtIn && record?.enabled !== true) {
      return { ...this.#item(manifest, normalizeStatus({
        ready: true,
        dependency: null,
        actions: {},
        contributions: {},
        settings: null,
        diagnostics: [],
        message: "Enable this plugin to run its local code and inspect its dependency."
      }), false), storage: await this.#storageUsage(manifest.id) }
    }
    const shouldAutoEnable = manifest.builtIn && record === undefined && manifest.autoEnableWhenReady
    let enabled = shouldAutoEnable ? true : record?.enabled === true
    let status
    try {
      status = await this.#status(manifest, enabled, { refresh })
    } catch (error) {
      status = normalizeStatus({
        ready: false,
        dependency: null,
        diagnostics: [{ severity: "error", message: error instanceof Error ? error.message : String(error) }],
        actions: {}
      })
      enabled = record?.enabled === true
    }
    if (shouldAutoEnable) enabled = status.ready === true
    if (shouldAutoEnable && status.ready === true) {
      await this.#updateState((next) => {
        next.plugins[manifest.id] = {
          ...(next.plugins[manifest.id] ?? {}),
          enabled: true,
          config: next.plugins[manifest.id]?.config ?? {},
          installedAt: next.plugins[manifest.id]?.installedAt
        }
        return next
      })
      enabled = true
    }
    return { ...this.#item(manifest, status, enabled), storage: await this.#storageUsage(manifest.id) }
  }

  async list({ refresh = false } = {}) {
    if (this.#closed) throw pluginError("plugin_closed", "The plugin host is shutting down")
    // Status can probe a real CLI for up to tens of seconds. Two surfaces refreshing together must
    // not start two native quota probes or two observe processes; queue the second behind the first.
    const operation = this.#listQueue.then(async () => {
      const manifests = await this.#loadManifests()
      const plugins = new Array(manifests.length)
      for (let start = 0; start < manifests.length; start += STATUS_CONCURRENCY) {
        await Promise.all(manifests.slice(start, start + STATUS_CONCURRENCY).map(async (manifest, offset) => {
          plugins[start + offset] = await this.#itemFor(manifest, { refresh })
        }))
      }
      return { plugins, generatedAt: new Date().toISOString() }
    })
    this.#listQueue = operation.catch(() => undefined)
    return await operation
  }

  async detail(id, { refresh = false } = {}) {
    const manifest = await this.#manifest(id)
    return await this.#itemFor(manifest, { refresh })
  }

  #invalidate(id) {
    this.#statusCache.delete(id)
    this.#storageCache.delete(id)
  }

  async #runLifecycle(id, method) {
    const manifest = await this.#manifest(id)
    const state = await this.#loadState()
    const record = state.plugins[id]
    const context = await this.#context(manifest, record)
    const timeoutMs = method === "uninstall" ? STATUS_TIMEOUT_MS : ACTION_TIMEOUT_MS
    const result = await this.#invoke(manifest, method, {
      config: record?.config ?? {},
      context
    }, manifest.runtime.timeoutMs && method === "status" ? manifest.runtime.timeoutMs : timeoutMs)
    const now = new Date().toISOString()
    await this.#updateState((next) => {
      const current = next.plugins[id] ?? { enabled: false, config: {} }
      if (method === "install" || method === "update") {
        next.plugins[id] = {
          ...current,
          enabled: true,
          config: current.config ?? {},
          installedAt: current.installedAt ?? now,
          updatedAt: now
        }
      } else if (method === "uninstall") {
        next.plugins[id] = { ...current, enabled: false, updatedAt: now }
      }
      return next
    })
    this.#invalidate(id)
    return {
      plugin: await this.#itemFor(manifest, { refresh: true }),
      message: isRecord(result) && typeof result.message === "string" ? result.message.slice(0, 1_000) : undefined
    }
  }

  async install(id) {
    return await this.#runLifecycle(id, "install")
  }

  async update(id) {
    return await this.#runLifecycle(id, "update")
  }

  async uninstall(id) {
    return await this.#runLifecycle(id, "uninstall")
  }

  async enable(id) {
    const manifest = await this.#manifest(id)
    const status = await this.#status(manifest, false, { refresh: true })
    if (status.ready !== true) {
      throw pluginError("plugin_not_ready", `${manifest.name} is not installed on this machine yet`)
    }
    const now = new Date().toISOString()
    await this.#updateState((next) => {
      const current = next.plugins[id] ?? { enabled: false, config: {} }
      next.plugins[id] = { ...current, enabled: true, updatedAt: now }
      return next
    })
    this.#invalidate(id)
    return {
      plugin: await this.#itemFor(manifest, { refresh: true }),
      message: `${manifest.name} enabled`
    }
  }

  async disable(id) {
    const manifest = await this.#manifest(id)
    const wasEnabled = (await this.#loadState()).plugins[id]?.enabled === true
    const now = new Date().toISOString()
    await this.#updateState((next) => {
      const current = next.plugins[id] ?? { enabled: false, config: {} }
      next.plugins[id] = { ...current, enabled: false, updatedAt: now }
      return next
    })
    if (wasEnabled && manifest.runtime.deactivateOnDisable) {
      const state = await this.#loadState()
      try {
        await this.#invoke(manifest, "deactivate", {
          config: state.plugins[id]?.config ?? {},
          context: await this.#context(manifest, state.plugins[id])
        }, 10_000)
      } catch (error) {
        this.warn(`Cannot deactivate ${manifest.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.#invalidate(id)
    return {
      plugin: await this.#itemFor(manifest, { refresh: true }),
      message: `${manifest.name} disabled`
    }
  }

  async configure(id, values) {
    const manifest = await this.#manifest(id)
    if (!isRecord(values) || Object.keys(values).length === 0) throw pluginError("invalid_request", "At least one setting is required")
    const state = await this.#loadState()
    const record = state.plugins[id]
    if (record?.enabled !== true) throw pluginError("plugin_disabled", `${manifest.name} is disabled`)
    const context = await this.#context(manifest, record)
    const result = await this.#invoke(manifest, "configure", {
      values: sanitizeConfig(values),
      config: record.config ?? {},
      context
    }, ACTION_TIMEOUT_MS)
    if (isRecord(result) && isRecord(result.config)) {
      const config = sanitizeConfig(result.config)
      await this.#updateState((next) => {
        const current = next.plugins[id] ?? { enabled: true, config: {} }
        next.plugins[id] = { ...current, config }
        return next
      })
    }
    this.#invalidate(id)
    return {
      ok: true,
      ...(isRecord(result) && typeof result.message === "string" ? { message: result.message.slice(0, 1_000) } : {})
    }
  }

  async runAction(id, actionId, params = {}) {
    const manifest = await this.#manifest(id)
    if (typeof actionId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(actionId)) {
      throw pluginError("invalid_request", "Plugin action id is invalid")
    }
    const state = await this.#loadState()
    const record = state.plugins[id]
    if (record?.enabled !== true) throw pluginError("plugin_disabled", `${manifest.name} is disabled`)
    const status = await this.#status(manifest, true)
    if (!status.actions.custom.some((action) => action.id === actionId)) {
      throw pluginError("invalid_request", `Unknown or unavailable action: ${actionId}`)
    }
    const context = await this.#context(manifest, record)
    const result = await this.#invoke(manifest, "action", {
      action: actionId,
      config: record?.config ?? {},
      context,
      ...(isRecord(params) ? params : {})
    }, 120_000)
    return {
      ok: true,
      ...(isRecord(result) && typeof result.message === "string" ? { message: result.message.slice(0, 1_000) } : {}),
      ...(isRecord(result) && typeof result.url === "string" && /^https?:\/\//.test(result.url)
        ? { url: result.url.slice(0, 2_000) }
        : {})
    }
  }

  async close() {
    this.#closed = true
    this.#statusCache.clear()
    this.#storageCache.clear()
    this.#listQueue = Promise.resolve()
    await this.#stateWrite.catch(() => undefined)
  }
}
