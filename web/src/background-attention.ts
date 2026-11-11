import { Capacitor, registerPlugin } from "@capacitor/core"
import { machineBaseUrl } from "./serverConfig.ts"
import { isDesktopLocalMachine, type WorkspaceMachine } from "./workspaceMachines.ts"

export type BackgroundAttentionMachine = {
  id: string
  name: string
  baseUrl: string
  username: string
  password: string
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
  setVisibleSession(options: { machineID?: string; agentID?: string; sessionID?: string }): Promise<BackgroundAttentionStatus>
}

const MAX_BACKGROUND_MACHINES = 6

const BackgroundAttention = registerPlugin<BackgroundAttentionNativePlugin>("BackgroundAttention")

function validBaseUrl(value: string): boolean {
  try {
    const endpoint = new URL(value)
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") return false
    if (!endpoint.hostname || !endpoint.port) return false
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return false
    return endpoint.pathname === "" || endpoint.pathname === "/"
  } catch {
    return false
  }
}

/**
 * Map paired machines to the only data the native service needs: an authenticated endpoint plus a
 * display name. Credentials stay inside the app-private payload; the service never logs them.
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
      username: machine.config.username ?? "",
      password: machine.config.password ?? ""
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
  } = {}
): Promise<BackgroundAttentionStatus | null> {
  const platform = options.platform ?? Capacitor.getPlatform()
  if (platform !== "android") return null
  const plugin = options.plugin ?? BackgroundAttention
  const targets = backgroundAttentionMachines(machines)
  await plugin.configure({ machines: targets })
  if (targets.length === 0) return plugin.stop()
  return plugin.start({ prompt: options.prompt === true })
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
