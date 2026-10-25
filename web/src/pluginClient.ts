import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { desktopRequestResult, isDesktopPlatform } from "./desktopBridge"
import { normalizePluginSnapshot, type PluginInfo, type PluginSnapshot } from "./plugins"
import { authHeader, hasCredentials, machineBaseUrl } from "./serverConfig"
import type { ServerConfig } from "./types"

export const PLUGINS_CHANGED_EVENT = "hr:plugins-changed"

const PLUGIN_CACHE_MS = 30_000
const UNSUPPORTED_CACHE_MS = 120_000
const LIST_TIMEOUT_MS = 120_000
const ACTION_TIMEOUT_MS = 300_000

type CacheEntry = {
  at: number
  snapshot: PluginSnapshot | null
  ttl: number
}

const cache = new Map<string, CacheEntry>()
const flights = new Map<string, Promise<PluginSnapshot | null>>()

export type PluginMutationAction = "install" | "update" | "uninstall" | "enable" | "disable" | "settings"

export type PluginMutationResult = {
  plugin?: PluginInfo
  message?: string
  ok?: boolean
}

function key(config: ServerConfig): string {
  return `${machineBaseUrl(config)}|${config.username || ""}`
}

function headers(config: ServerConfig, json = false): Record<string, string> {
  const result: Record<string, string> = { Accept: "application/json" }
  if (json) result["Content-Type"] = "application/json"
  if (hasCredentials(config)) result.Authorization = authHeader(config)
  return result
}

function responsePayload(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) } catch { return value }
}

function errorDetail(value: unknown, status?: number): string {
  const parsed = responsePayload(value)
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const error = (parsed as { error?: unknown }).error
    if (typeof error === "string" && error.trim()) return error.trim()
  }
  return status ? `Plugin request failed with HTTP ${status}` : "Plugin request failed"
}

function unsupportedStatus(status: number | undefined): boolean {
  return status === 404 || status === 405 || status === 501 || status === 503
}

async function pluginRequest(
  config: ServerConfig,
  path: string,
  options: { method?: "GET" | "POST" | "PATCH"; body?: unknown; timeoutMs?: number } = {}
): Promise<{ value: unknown; status: number }> {
  const method = options.method ?? "GET"
  const timeoutMs = options.timeoutMs ?? LIST_TIMEOUT_MS
  if (isDesktopPlatform()) {
    const result = await desktopRequestResult(config, {
      path,
      method,
      ...(options.body === undefined ? {} : { body: options.body }),
      readTimeout: timeoutMs
    })
    if (!result.ok) {
      if (result.error.code === "http") {
        const error = new Error(result.error.message || errorDetail(undefined, result.error.status))
        ;(error as Error & { status?: number }).status = result.error.status
        throw error
      }
      throw new Error(result.error.message)
    }
    return { value: result.response.data, status: 200 }
  }

  const target = `${machineBaseUrl(config)}${path}`
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.request({
      url: target,
      method,
      headers: headers(config, options.body !== undefined),
      ...(options.body === undefined ? {} : { data: options.body }),
      connectTimeout: 15_000,
      readTimeout: timeoutMs
    })
    if (response.status >= 400) {
      const error = new Error(errorDetail(response.data, response.status))
      ;(error as Error & { status?: number }).status = response.status
      throw error
    }
    return { value: response.data, status: response.status }
  }

  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(target, {
      method,
      headers: headers(config, options.body !== undefined),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal
    })
    let value: unknown = null
    try { value = await response.json() } catch { /* status carries the failure */ }
    if (!response.ok) {
      const error = new Error(errorDetail(value, response.status))
      ;(error as Error & { status?: number }).status = response.status
      throw error
    }
    return { value, status: response.status }
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Plugin request timed out")
    throw error
  } finally {
    globalThis.clearTimeout(timer)
  }
}

export async function listPlugins(config: ServerConfig, options: { refresh?: boolean } = {}): Promise<PluginSnapshot | null> {
  const cacheKey = key(config)
  const cached = cache.get(cacheKey)
  if (!options.refresh && cached && Date.now() - cached.at < cached.ttl) return cached.snapshot
  const active = flights.get(cacheKey)
  if (active) return await active
  const flight = (async () => {
    try {
      const { value } = await pluginRequest(config, `/v1/plugins${options.refresh ? "?refresh=1" : ""}`)
      const snapshot = normalizePluginSnapshot(value)
      cache.set(cacheKey, { at: Date.now(), snapshot, ttl: PLUGIN_CACHE_MS })
      return snapshot
    } catch (error) {
      const status = (error as Error & { status?: number }).status
      if (unsupportedStatus(status)) {
        cache.set(cacheKey, { at: Date.now(), snapshot: null, ttl: UNSUPPORTED_CACHE_MS })
        return null
      }
      throw error
    }
  })()
  flights.set(cacheKey, flight)
  try {
    return await flight
  } finally {
    if (flights.get(cacheKey) === flight) flights.delete(cacheKey)
  }
}

export async function runPluginAction(
  config: ServerConfig,
  pluginID: string,
  actionID: string
): Promise<{ message?: string; url?: string }> {
  const { value } = await pluginRequest(config, `/v1/plugins/${encodeURIComponent(pluginID)}/actions/${encodeURIComponent(actionID)}`, {
    method: "POST",
    body: {},
    timeoutMs: ACTION_TIMEOUT_MS
  })
  const record = responsePayload(value)
  if (!record || typeof record !== "object" || Array.isArray(record)) return {}
  const result = record as Record<string, unknown>
  return {
    ...(typeof result.message === "string" ? { message: result.message } : {}),
    ...(typeof result.url === "string" && /^https?:\/\//.test(result.url) ? { url: result.url } : {})
  }
}

export async function mutatePlugin(
  config: ServerConfig,
  pluginID: string,
  action: PluginMutationAction,
  options: { values?: Record<string, string | number | boolean>; notify?: boolean } = {}
): Promise<PluginMutationResult> {
  const path = action === "settings"
    ? `/v1/plugins/${encodeURIComponent(pluginID)}/settings`
    : `/v1/plugins/${encodeURIComponent(pluginID)}/${action}`
  const { value } = await pluginRequest(config, path, {
    method: action === "settings" ? "PATCH" : "POST",
    ...(action === "settings" ? { body: { values: options.values ?? {} } } : {}),
    timeoutMs: ACTION_TIMEOUT_MS
  })
  cache.delete(key(config))
  if (options.notify !== false) notifyPluginsChanged()
  const record = responsePayload(value)
  if (!record || typeof record !== "object" || Array.isArray(record)) return {}
  const result = record as Record<string, unknown>
  return {
    ...(typeof result.message === "string" ? { message: result.message } : {}),
    ...(result.ok === true ? { ok: true } : {})
  }
}

export function invalidatePluginCache(config: ServerConfig): void {
  cache.delete(key(config))
}

export function notifyPluginsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PLUGINS_CHANGED_EVENT))
}

export function pluginCacheKey(config: ServerConfig): string {
  return key(config)
}
