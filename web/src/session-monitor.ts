import { Capacitor, registerPlugin, type PermissionState, type PluginListenerHandle } from "@capacitor/core"
import { notifyPreferencesChanged } from "./appPreferences"
import type { Translator } from "./i18n"
import { nativeSessionConfig } from "./native-session-discovery"
import { authHeader, baseUrl, hasCredentials, routingHeaders } from "./serverConfig"
import type { MachineAgentHost, ServerConfig } from "./types"

export type SessionMonitorTarget = {
  machineID: string
  agentID: string
  agentLabel: string
  machineName: string
  statusUrl: string
  sessionsUrl: string
  authorization: string
  backend: string
}

export type SessionMonitorTexts = {
  channelName: string
  channelDescription: string
  serviceChannelName: string
  serviceTitle: string
  serviceText: string
  finished: string
  attention: string
  untitled: string
}

/** `session` is the Session's listing row as the service read it (JSON), when it had one. */
export type SessionMonitorTap = { machineID: string; agentID: string; sessionID: string; session?: string }

export interface SessionMonitorPlugin {
  configure(options: {
    enabled: boolean
    intervalSeconds: number
    keepAwake: boolean
    texts: SessionMonitorTexts
    targets: SessionMonitorTarget[]
    hideNeedles?: string[]
  }): Promise<{ running: boolean }>
  status(): Promise<{ running: boolean; ignoringBatteryOptimizations: boolean; notificationsEnabled: boolean }>
  requestBatteryExemption(): Promise<{ ignoringBatteryOptimizations: boolean }>
  openAppSettings(): Promise<void>
  setFocusedSession(options: { machineID?: string; agentID?: string; sessionID?: string }): Promise<void>
  checkPermissions(): Promise<{ notifications: PermissionState }>
  requestPermissions(options?: { permissions: ["notifications"] }): Promise<{ notifications: PermissionState }>
  addListener(event: "notificationTap", callback: (tap: SessionMonitorTap) => void): Promise<PluginListenerHandle>
}

const SessionMonitor = registerPlugin<SessionMonitorPlugin>("SessionMonitor")

export function isSessionMonitorSupported(): boolean {
  return Capacitor.getPlatform() === "android"
}

export type SessionMonitorPrefs = { enabled: boolean; intervalSeconds: number; keepAwake: boolean }

export const SESSION_MONITOR_INTERVALS = [15, 30, 60, 120, 300] as const
export const SESSION_MONITOR_DEFAULTS: SessionMonitorPrefs = { enabled: false, intervalSeconds: 30, keepAwake: true }
export const SESSION_MONITOR_STORAGE_KEY = "harness-remote.session-monitor.v1"

export function loadSessionMonitorPrefs(): SessionMonitorPrefs {
  try {
    const raw = localStorage.getItem(SESSION_MONITOR_STORAGE_KEY)
    if (!raw) return { ...SESSION_MONITOR_DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<Record<keyof SessionMonitorPrefs, unknown>> | null
    if (!parsed || typeof parsed !== "object") return { ...SESSION_MONITOR_DEFAULTS }
    const interval = (SESSION_MONITOR_INTERVALS as readonly number[]).find((value) => value === parsed.intervalSeconds)
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : SESSION_MONITOR_DEFAULTS.enabled,
      intervalSeconds: interval ?? SESSION_MONITOR_DEFAULTS.intervalSeconds,
      keepAwake: typeof parsed.keepAwake === "boolean" ? parsed.keepAwake : SESSION_MONITOR_DEFAULTS.keepAwake
    }
  } catch {
    return { ...SESSION_MONITOR_DEFAULTS }
  }
}

export function persistSessionMonitorPrefs(prefs: SessionMonitorPrefs): void {
  try {
    localStorage.setItem(SESSION_MONITOR_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Storage can be unavailable; the in-memory state still applies for this run.
  }
  notifyPreferencesChanged()
}

export function sessionMonitorTarget(
  machineID: string,
  machineName: string,
  base: ServerConfig,
  agent: MachineAgentHost
): SessionMonitorTarget {
  const config = nativeSessionConfig(base, agent)
  const root = baseUrl(config)
  return {
    machineID,
    agentID: agent.id,
    agentLabel: agent.label || agent.id,
    machineName,
    statusUrl: `${root}/session/status`,
    sessionsUrl: `${root}/experimental/session`,
    authorization: hasCredentials(config) ? authHeader(config) : "",
    backend: routingHeaders(config, { preflight: false })["X-Harness-Backend"] ?? ""
  }
}

export function sessionMonitorTexts(t: Translator): SessionMonitorTexts {
  return {
    channelName: t("monitor.channelName"),
    channelDescription: t("monitor.channelDescription"),
    serviceChannelName: t("monitor.serviceChannelName"),
    serviceTitle: t("monitor.serviceTitle"),
    serviceText: t("monitor.serviceText", { count: "{count}" }),
    finished: t("monitor.finished", { agent: "{agent}" }),
    attention: t("monitor.attention", { agent: "{agent}" }),
    untitled: t("monitor.untitled")
  }
}

export async function configureSessionMonitor(
  prefs: SessionMonitorPrefs,
  targets: SessionMonitorTarget[],
  texts: SessionMonitorTexts,
  hideNeedles: string[] = []
): Promise<void> {
  if (!isSessionMonitorSupported()) return
  const enabled = prefs.enabled && targets.length > 0
  try {
    await SessionMonitor.configure({
      enabled,
      intervalSeconds: prefs.intervalSeconds,
      keepAwake: prefs.keepAwake,
      texts,
      // Machine credentials reach native storage only while the user has the monitor switched on.
      targets: enabled ? targets : [],
      hideNeedles: enabled ? hideNeedles : []
    })
  } catch (reason) {
    console.warn("Session monitor configure failed", reason instanceof Error ? reason.message : "unknown error")
  }
}

/** Stop the native service regardless of which screen is mounted. */
export async function stopSessionMonitor(): Promise<void> {
  if (!isSessionMonitorSupported()) return
  try {
    await SessionMonitor.configure({ enabled: false, intervalSeconds: 30, keepAwake: false, texts: {} as SessionMonitorTexts, targets: [] })
  } catch {
    // Already stopped or unavailable.
  }
}

export async function requestSessionMonitorPermission(): Promise<boolean> {
  if (!isSessionMonitorSupported()) return false
  try {
    const current = await SessionMonitor.checkPermissions()
    if (current.notifications === "granted") return true
    const next = await SessionMonitor.requestPermissions({ permissions: ["notifications"] })
    return next.notifications === "granted"
  } catch {
    return false
  }
}

export async function sessionMonitorStatus(): Promise<{
  running: boolean
  ignoringBatteryOptimizations: boolean
  notificationsEnabled: boolean
}> {
  const fallback = { running: false, ignoringBatteryOptimizations: false, notificationsEnabled: false }
  if (!isSessionMonitorSupported()) return fallback
  try {
    return await SessionMonitor.status()
  } catch {
    return fallback
  }
}

export async function requestSessionMonitorBatteryExemption(): Promise<boolean> {
  if (!isSessionMonitorSupported()) return false
  try {
    return (await SessionMonitor.requestBatteryExemption()).ignoringBatteryOptimizations
  } catch {
    return false
  }
}

export async function openSessionMonitorAppSettings(): Promise<void> {
  if (!isSessionMonitorSupported()) return
  try {
    await SessionMonitor.openAppSettings()
  } catch {
    // Nothing else to do when the system settings screen cannot be opened.
  }
}

export async function setSessionMonitorFocus(
  target: { machineID: string; agentID: string; sessionID: string } | null
): Promise<void> {
  if (!isSessionMonitorSupported()) return
  try {
    await SessionMonitor.setFocusedSession(target ?? {})
  } catch {
    // Focus only suppresses a notification; losing it is harmless.
  }
}

export function subscribeSessionMonitorTap(callback: (tap: SessionMonitorTap) => void): () => void {
  if (!isSessionMonitorSupported()) return () => {}
  let disposed = false
  let handle: PluginListenerHandle | null = null
  void SessionMonitor.addListener("notificationTap", callback).then((added) => {
    if (disposed) void added.remove()
    else handle = added
  }).catch(() => {})
  return () => {
    disposed = true
    if (handle) {
      void handle.remove()
      handle = null
    }
  }
}
