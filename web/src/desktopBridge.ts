import type {
  DesktopCompletionNotification,
  DesktopEvent,
  DesktopEventStatus,
  DesktopEventSubscriptionOptions,
  DesktopMenuCommand,
  DesktopMenuTemplate,
  DesktopProfile,
  DesktopProfileSyncResult,
  DesktopRequest,
  DesktopRequestResult,
  DesktopResponse
} from "../electron/ipc-contract"
import { normalizeServerConfig } from "./serverConfig"
import type { ServerConfig } from "./types"

export type DesktopPlatform = { isDesktop: true; os: string; usesNativeMenu?: boolean }
export type DesktopBridgeAPI = {
  readonly platform: Readonly<{ readonly isDesktop: true; readonly os: string; readonly usesNativeMenu?: boolean }>
  replaceProfiles(profiles: DesktopProfile[], revision: number): Promise<DesktopProfileSyncResult>
  request(profileId: string, request: DesktopRequest): Promise<DesktopRequestResult>
  subscribeEvents(
    profileId: string,
    options: DesktopEventSubscriptionOptions,
    onEvent: (event: DesktopEvent) => void,
    onStatus?: (status: DesktopEventStatus) => void
  ): Promise<string>
  unsubscribeEvents(subscriptionId: string): Promise<void>
  notifyCompletion(notification: DesktopCompletionNotification): Promise<void>
  onMenuCommand(callback: (command: DesktopMenuCommand) => void): () => void
  setApplicationMenu(template: DesktopMenuTemplate): Promise<boolean>
}
declare global {
  interface Window {
    readonly harnessDesktop?: DesktopBridgeAPI
  }
}

const acknowledgedProfiles: DesktopProfile[] = []
let acknowledgedRevision = 0
let pendingProfiles: DesktopProfile[] | undefined
let synchronization: Promise<DesktopProfileSyncResult> | undefined
let synchronizationError: Error | undefined
let nextRevision = 0
let hasSynchronized = false

export type DesktopSubscription = { close(): void }

function bridge(): Window["harnessDesktop"] | undefined {
  return typeof window !== "undefined" ? window.harnessDesktop : undefined
}

function emptySyncResult(): DesktopProfileSyncResult {
  return {
    revision: acknowledgedRevision,
    acceptedProfileIDs: acknowledgedProfiles.map((profile) => profile.id),
    changedProfileIDs: [],
    removedProfileIDs: [],
    unchangedProfileIDs: acknowledgedProfiles.map((profile) => profile.id)
  }
}

function sameProfile(left: DesktopProfile, right: DesktopProfile): boolean {
  return left.id === right.id
    && left.backend === right.backend
    && left.host === right.host
    && left.port === right.port
    && left.username === right.username
    && left.password === right.password
    && left.agentId === right.agentId
}

function sameSnapshot(left: DesktopProfile[], right: DesktopProfile[]): boolean {
  return left.length === right.length && left.every((profile, index) => sameProfile(profile, right[index]))
}

export type DesktopProfileSource = {
  id: string
  config: ServerConfig
}

/**
 * Electron authorizes machine endpoints, not individual harness routes. Keep one stable registry
 * entry per WorkspaceMachine and pass backend/agentId separately with each request/subscription.
 */
export function toDesktopProfiles(profiles: readonly DesktopProfileSource[]): DesktopProfile[] {
  return profiles.flatMap((profile) => {
    const normalized = normalizeServerConfig({ ...profile.config, backend: "opencode", agentId: undefined })
    if (!normalized) return []
    return [{
      id: profile.id,
      backend: "opencode",
      host: normalized.host,
      port: normalized.port,
      username: normalized.username,
      password: normalized.password
    }]
  })
}

export function desktopProfileSyncRevision(): number {
  return acknowledgedRevision
}

export function desktopProfileSyncError(): Error | undefined {
  return synchronizationError
}

export async function awaitDesktopProfileSync(): Promise<DesktopProfileSyncResult> {
  return synchronization ?? emptySyncResult()
}

async function drainSynchronization(): Promise<DesktopProfileSyncResult> {
  const api = bridge()
  if (!api) return emptySyncResult()
  let result = emptySyncResult()
  while (pendingProfiles !== undefined) {
    const payload = pendingProfiles
    pendingProfiles = undefined
    if (hasSynchronized && sameSnapshot(payload, acknowledgedProfiles)) {
      result = emptySyncResult()
      continue
    }
    const revision = ++nextRevision
    result = await api.replaceProfiles(payload, revision)
    acknowledgedProfiles.length = 0
    acknowledgedProfiles.push(...payload)
    acknowledgedRevision = result.revision
    hasSynchronized = true
    synchronizationError = undefined
  }
  return result
}

export function syncDesktopProfiles(profiles: readonly DesktopProfileSource[]): Promise<DesktopProfileSyncResult> {
  const api = bridge()
  if (!api) return Promise.resolve(emptySyncResult())
  const payload = toDesktopProfiles(profiles)
  if (hasSynchronized && sameSnapshot(payload, acknowledgedProfiles) && !synchronization) return Promise.resolve(emptySyncResult())
  pendingProfiles = payload
  if (!synchronization) {
    synchronization = drainSynchronization().catch((error: unknown) => {
      synchronizationError = error instanceof Error ? error : new Error("Desktop profile synchronization failed")
      throw synchronizationError
    }).finally(() => {
      synchronization = undefined
    })
  }
  return synchronization
}

export function desktopPlatform(): DesktopPlatform | null {
  const value = bridge()?.platform
  return value?.isDesktop ? value : null
}

export function isDesktopPlatform(): boolean {
  return desktopPlatform() !== null
}

export function isAndroidPlatform(platform: string): boolean {
  return platform === "android"
}

function desktopMachineIdentity(config: ServerConfig): string | null {
  const normalized = normalizeServerConfig({ ...config, backend: "opencode", agentId: undefined })
  if (!normalized) return null
  return JSON.stringify([
    normalized.host,
    normalized.port,
    normalized.username,
    normalized.password
  ])
}

export function desktopProfileID(config: ServerConfig): string | null {
  const identity = desktopMachineIdentity(config)
  if (!identity) return null
  return acknowledgedProfiles.find((candidate) => desktopMachineIdentity(candidate) === identity)?.id ?? null
}

export function notifyDesktopCompletion(notification: DesktopCompletionNotification): void {
  void bridge()?.notifyCompletion(notification).catch(() => undefined)
}

export function subscribeDesktopMenuCommands(callback: (command: DesktopMenuCommand) => void): () => void {
  return bridge()?.onMenuCommand(callback) ?? (() => undefined)
}

/** True only where the platform draws the menu itself, which today means macOS. Everywhere else,
 *  the browser, Windows and Linux, the app draws its own menu bar and binds its own accelerators. */
export function desktopUsesNativeMenu(): boolean {
  return desktopPlatform()?.usesNativeMenu === true
}

export function setDesktopApplicationMenu(template: DesktopMenuTemplate): void {
  void bridge()?.setApplicationMenu(template).catch(() => undefined)
}

export async function desktopRequestResult(config: ServerConfig, request: DesktopRequest): Promise<DesktopRequestResult> {
  const api = bridge()
  if (!api) return { ok: false, error: { code: "connection", message: "Desktop transport is unavailable" } }
  try {
    await awaitDesktopProfileSync()
  } catch {
    return { ok: false, error: { code: "internal", message: "Desktop profile synchronization failed" } }
  }
  const profileId = desktopProfileID(config)
  if (!profileId) return { ok: false, error: { code: "unknown-profile", message: "Unknown desktop server profile" } }
  return await api.request(profileId, {
    ...request,
    route: {
      backend: config.backend,
      ...(config.agentId?.trim() ? { agentId: config.agentId.trim() } : {})
    }
  })
}

export async function desktopRequest(config: ServerConfig, request: DesktopRequest): Promise<DesktopResponse> {
  const result = await desktopRequestResult(config, request)
  if (!result.ok) throw new Error(result.error.message)
  return result.response
}

export function createDesktopOpenCodeEventSubscription(options: {
  config: ServerConfig
  scope: "global" | "project"
  directory?: string
  onEvent: (event: DesktopEvent) => void
  onStatus?: (status: DesktopEventStatus) => void
}): DesktopSubscription {
  const api = bridge()
  let closed = false
  let subscriptionID: string | undefined
  void (async () => {
    if (!api) {
      options.onStatus?.({ type: "connection-error", error: "Desktop transport is unavailable" })
      return
    }
    try {
      await awaitDesktopProfileSync()
      const profileId = desktopProfileID(options.config)
      if (!profileId) throw new Error("Unknown desktop server profile")
      const id = await api.subscribeEvents(
        profileId,
        {
          scope: options.scope,
          directory: options.directory,
          backend: options.config.backend,
          agentId: options.config.agentId
        },
        options.onEvent,
        options.onStatus
      )
      if (closed) await api.unsubscribeEvents(id)
      else subscriptionID = id
    } catch (error) {
      if (!closed) options.onStatus?.({ type: "connection-error", error: error instanceof Error ? error.message : "Event stream failed" })
    }
  })()
  return {
    close() {
      if (closed) return
      closed = true
      if (subscriptionID) void api?.unsubscribeEvents(subscriptionID).catch(() => undefined)
    }
  }
}
