import { Capacitor, registerPlugin } from "@capacitor/core"
import { machineBaseUrl } from "./serverConfig.ts"
import { isDesktopLocalMachine, type WorkspaceMachine } from "./workspaceMachines.ts"

export type BackgroundAttentionMachine = {
  id: string
  name: string
  baseUrl: string
  username: string
  password: string
  remoteMachineID?: string
  remoteDnsName?: string
  remotePin?: string
}

export type BackgroundAttentionStatus = {
  supported: boolean
  running: boolean
  configuredMachines: number
  connectedMachines: number
  notificationPermission: boolean
  batteryExempt: boolean
  manufacturer: string
  lastError: string
}

export type VisibleNativeSession = {
  machineID: string
  agentID: string
  sessionID: string
}

export type BackgroundAttentionNativePlugin = {
  configure(options: { machines: BackgroundAttentionMachine[] }): Promise<BackgroundAttentionStatus>
  start(options: { prompt?: boolean }): Promise<BackgroundAttentionStatus>
  stop(): Promise<BackgroundAttentionStatus>
  status(): Promise<BackgroundAttentionStatus>
  restoreNotification(): Promise<BackgroundAttentionStatus>
  setVisibleSession(options: { machineID?: string; agentID?: string; sessionID?: string }): Promise<BackgroundAttentionStatus>
  setNotificationKinds?(options: { ready: boolean; failed: boolean; attention: boolean }): Promise<BackgroundAttentionStatus>
}

export type BackgroundNotificationPreferences = { enabled: boolean; ready: boolean; failed: boolean; attention: boolean }

const MAX_BACKGROUND_MACHINES = 6

const BackgroundAttention = registerPlugin<BackgroundAttentionNativePlugin>("BackgroundAttention")

function validBaseUrl(value: string): boolean {
  try {
    const endpoint = new URL(value)
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") return false
    // `new URL` drops a default port (https:443, http:80), so an empty port is valid here.
    if (!endpoint.hostname) return false
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return false
    return endpoint.pathname === "" || endpoint.pathname === "/"
  } catch {
    return false
  }
}

/**
 * Map paired machines to the only data the native service needs. Legacy LAN profiles use Basic
 * auth; E1 remote profiles pass their pinned machine identity and use signed device-key requests.
 */
export function backgroundAttentionMachines(
  machines: readonly WorkspaceMachine[]
): BackgroundAttentionMachine[] {
  const result: BackgroundAttentionMachine[] = []
  const seenIDs = new Set<string>()
  const seenEndpoints = new Set<string>()
  for (const machine of machines) {
    if (result.length >= MAX_BACKGROUND_MACHINES) break
    if (isDesktopLocalMachine(machine)) continue
    const id = machine.id.trim()
    if (!id || seenIDs.has(id)) continue
    const baseUrl = machineBaseUrl(machine.config)
    if (!validBaseUrl(baseUrl) || seenEndpoints.has(baseUrl)) continue
    seenIDs.add(id)
    seenEndpoints.add(baseUrl)
    result.push({
      id,
      name: machine.name.trim() || machine.config.host,
      baseUrl,
      username: machine.config.remote ? "" : (machine.config.username ?? ""),
      password: machine.config.remote ? "" : (machine.config.password ?? ""),
      ...(machine.config.remote ? {
        remoteMachineID: machine.config.remote.machineID,
        remoteDnsName: machine.config.remote.dnsName,
        remotePin: machine.config.remote.pin
      } : {})
    })
  }
  return result
}

/**
 * Android-only handoff to the native foreground service. `prompt` is true only for a user-driven
 * pairing, so an app launch never surprises someone with a permission dialog; a launch still resumes
 * an already granted service.
 */
export async function syncBackgroundAttention(
  machines: readonly WorkspaceMachine[],
  options: {
    platform?: string
    prompt?: boolean
    plugin?: BackgroundAttentionNativePlugin
    /** Settings → Notifications. Off stops the service: it exists only to deliver notifications. */
    preferences?: BackgroundNotificationPreferences
  } = {}
): Promise<BackgroundAttentionStatus | null> {
  const platform = options.platform ?? Capacitor.getPlatform()
  if (platform !== "android") return null
  const plugin = options.plugin ?? BackgroundAttention
  const preferences = options.preferences
  const targets = preferences && !preferences.enabled ? [] : backgroundAttentionMachines(machines)
  await plugin.configure({ machines: targets })
  if (targets.length === 0) return plugin.stop()
  if (preferences && plugin.setNotificationKinds) {
    await plugin.setNotificationKinds({ ready: preferences.ready, failed: preferences.failed, attention: preferences.attention })
  }
  return plugin.start({ prompt: options.prompt === true })
}

/**
 * Re-post the foreground-service notification after the user or an OEM surface hid it. The service
 * keeps running without the notification on some HyperOS builds, so opening the app was previously
 * the only accidental way to get it back.
 */
export async function restoreBackgroundAttentionNotification(
  options: {
    platform?: string
    plugin?: Pick<BackgroundAttentionNativePlugin, "restoreNotification">
  } = {}
): Promise<BackgroundAttentionStatus | null> {
  const platform = options.platform ?? Capacitor.getPlatform()
  if (platform !== "android") return null
  const plugin = options.plugin ?? BackgroundAttention
  return plugin.restoreNotification()
}

/**
 * The selected Session key is the existing `machineID:agentID:sessionID` identity. Native machine
 * ids, agent ids and native Session ids do not contain the separator, so only the first and last
 * colon are structural.
 */
export function selectedNativeSessionFromKey(key: string | null | undefined): VisibleNativeSession | null {
  if (!key) return null
  const first = key.indexOf(":")
  const last = key.lastIndexOf(":")
  if (first <= 0 || last <= first + 1 || last >= key.length - 1) return null
  const machineID = key.slice(0, first).trim()
  const agentID = key.slice(first + 1, last).trim()
  const sessionID = key.slice(last + 1).trim()
  return machineID && agentID && sessionID ? { machineID, agentID, sessionID } : null
}

/** Tell the native service which Session is on screen. Foreground/background itself is tracked by
 * the Android plugin lifecycle, so a paused app can still receive completion notifications. */
export async function syncVisibleNativeSession(
  session: VisibleNativeSession | null,
  options: {
    platform?: string
    plugin?: Pick<BackgroundAttentionNativePlugin, "setVisibleSession">
  } = {}
): Promise<BackgroundAttentionStatus | null> {
  const platform = options.platform ?? Capacitor.getPlatform()
  if (platform !== "android") return null
  const plugin = options.plugin ?? BackgroundAttention
  return plugin.setVisibleSession(session ? { ...session } : {})
}
