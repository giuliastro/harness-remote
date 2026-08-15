import { randomUUID } from "node:crypto"
import type { WebContents } from "electron"
import { baseUrl } from "../src/serverConfig.js"
import { parseSSEFrame, type ParsedOpenCodeEvent } from "../src/sse-parser.js"
import { ProfileRegistry, type ProfileRegistryChange } from "./profile-registry.js"
import type {
  DesktopEvent,
  DesktopEventMessage,
  DesktopEventStatus,
  DesktopEventSubscriptionOptions,
  DesktopProfile,
  DesktopSubscribeResult,
  IPC_CHANNELS
} from "./ipc-contract.js"

const INITIAL_RECONNECT_MS = 1_000
const MAX_RECONNECT_MS = 30_000
const STALL_TIMEOUT_MS = 30_000
const MAX_DIRECTORY_LENGTH = 4096

type ChannelNames = typeof IPC_CHANNELS

type ActiveSubscription = {
  id: string
  profileId: string
  owner: WebContents
  options: DesktopEventSubscriptionOptions
  connectTimer?: NodeJS.Timeout
  controller?: AbortController
  reader?: ReadableStreamDefaultReader<Uint8Array>
  reconnectTimer?: NodeJS.Timeout
  reconnectDelayMs: number
  closed: boolean
}

function authHeader(profile: DesktopProfile): string | undefined {
  if (!profile.username || !profile.password) return undefined
  return `Basic ${Buffer.from(`${profile.username}:${profile.password}`, "utf8").toString("base64")}`
}

function streamURL(profile: DesktopProfile, options: DesktopEventSubscriptionOptions): URL {
  const url = new URL(
    profile.backend === "opencode2"
      ? "/api/event"
      : options.scope === "global" ? "/global/event" : "/event",
    baseUrl(profile)
  )
  if (options.scope === "project" && options.directory) url.searchParams.set("directory", options.directory)
  return url
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Event stream failed"
}

export class DesktopEventTransport {
  private readonly subscriptions = new Map<string, ActiveSubscription>()

  constructor(private readonly registry: ProfileRegistry, private readonly channels: ChannelNames) {}
  async subscribe(owner: WebContents, profileId: string, options: DesktopEventSubscriptionOptions): Promise<DesktopSubscribeResult> {
    this.registry.get(profileId)
    if (!options || (options.scope !== "global" && options.scope !== "project") || (options.directory !== undefined && typeof options.directory !== "string")) {
      throw new Error("Event subscription options are invalid")
    }
    if (options.directory !== undefined && (options.directory.length > MAX_DIRECTORY_LENGTH || /[\u0000-\u001f\u007f]/.test(options.directory))) {
      throw new Error("Event subscription directory is invalid")
    }
    if (options.scope === "project" && !options.directory?.trim()) throw new Error("Project event directory is required")
    const subscription: ActiveSubscription = {
      id: randomUUID(),
      profileId,
      owner,
      options: { ...options },
      reconnectDelayMs: INITIAL_RECONNECT_MS,
      closed: false
    }
    this.subscriptions.set(subscription.id, subscription)
    this.queueConnect(subscription)
    return { subscriptionId: subscription.id }
  }

  unsubscribe(owner: WebContents, subscriptionId: string): void {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription || subscription.owner !== owner) return
    this.close(subscription)
  }

  closeAll(): void {
    for (const subscription of [...this.subscriptions.values()]) this.close(subscription)
  }

  closeForOwner(owner: WebContents): void {
    for (const subscription of [...this.subscriptions.values()]) {
      if (subscription.owner === owner) this.close(subscription)
    }
  }

  private publish(subscription: ActiveSubscription, message: DesktopEventMessage): void {
    if (subscription.closed || subscription.owner.isDestroyed()) return
    subscription.owner.send(this.channels.event, message)
  }

  private publishStatus(subscription: ActiveSubscription, status: DesktopEventStatus): void {
    this.publish(subscription, { subscriptionId: subscription.id, kind: "status", status })
  }

  private publishEvent(subscription: ActiveSubscription, event: Extract<ParsedOpenCodeEvent, { ok: true }>): void {
    const payload: DesktopEvent = { name: event.name, raw: event.raw, data: event.data }
    this.publish(subscription, { subscriptionId: subscription.id, kind: "event", event: payload })
  }

  applyRegistryChange(change: ProfileRegistryChange): void {
    for (const subscription of [...this.subscriptions.values()]) {
      if (change.removedProfileIDs.includes(subscription.profileId)) {
        this.close(subscription)
      } else if (change.changedProfileIDs.includes(subscription.profileId)) {
        this.restart(subscription)
      }
    }
  }

  private queueConnect(subscription: ActiveSubscription): void {
    if (subscription.closed || subscription.connectTimer !== undefined) return
    subscription.connectTimer = setTimeout(() => {
      subscription.connectTimer = undefined
      void this.connect(subscription)
    }, 0)
  }

  private restart(subscription: ActiveSubscription): void {
    if (subscription.closed) return
    clearTimeout(subscription.connectTimer)
    subscription.connectTimer = undefined
    clearTimeout(subscription.reconnectTimer)
    subscription.reconnectTimer = undefined
    subscription.controller?.abort()
    void subscription.reader?.cancel().catch(() => undefined)
    subscription.controller = undefined
    subscription.reader = undefined
    subscription.reconnectDelayMs = INITIAL_RECONNECT_MS
    this.queueConnect(subscription)
  }

  private scheduleReconnect(subscription: ActiveSubscription): void {
    if (subscription.closed || subscription.reconnectTimer !== undefined) return
    const delayMs = subscription.reconnectDelayMs
    subscription.reconnectDelayMs = Math.min(MAX_RECONNECT_MS, delayMs * 2)
    this.publishStatus(subscription, { type: "reconnecting", delayMs })
    subscription.reconnectTimer = setTimeout(() => {
      subscription.reconnectTimer = undefined
      void this.connect(subscription)
    }, delayMs)
  }

  private async connect(subscription: ActiveSubscription): Promise<void> {
    if (subscription.closed || this.subscriptions.get(subscription.id) !== subscription) return
    let profile: DesktopProfile
    try {
      profile = this.registry.get(subscription.profileId)
    } catch {
      this.close(subscription)
      return
    }
    const controller = new AbortController()
    subscription.controller = controller
    let response: Response
    try {
      const headers: Record<string, string> = { Accept: "text/event-stream" }
      const authorization = authHeader(profile)
      if (authorization) headers.Authorization = authorization
      response = await fetch(streamURL(profile, subscription.options), { headers, redirect: "manual", signal: controller.signal })
      if (response.status >= 300 && response.status < 400) throw new Error("Server redirect was rejected")
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const contentType = response.headers.get("content-type") ?? ""
      if (!contentType.toLowerCase().includes("text/event-stream")) {
        throw new Error(`Expected text/event-stream, received ${contentType || "no content type"}`)
      }
      subscription.reconnectDelayMs = INITIAL_RECONNECT_MS
      this.publishStatus(subscription, { type: "connected" })
      const reader = response.body.getReader()
      subscription.reader = reader
      const decoder = new TextDecoder()
      let buffer = ""
      let stallTimer: ReturnType<typeof setTimeout> | undefined
      const disarmStall = () => {
        if (stallTimer !== undefined) clearTimeout(stallTimer)
        stallTimer = undefined
      }
      const armStall = () => {
        disarmStall()
        stallTimer = setTimeout(() => {
          stallTimer = undefined
          controller.abort()
          void reader.cancel().catch(() => undefined)
        }, STALL_TIMEOUT_MS)
      }
      try {
        while (!subscription.closed && subscription.controller === controller) {
          armStall()
          const { done, value } = await reader.read()
          disarmStall()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.search(/\r?\n\r?\n/)
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "")
            this.forwardFrame(subscription, parseSSEFrame(frame))
            boundary = buffer.search(/\r?\n\r?\n/)
          }
        }
        buffer += decoder.decode()
        if (buffer.trim()) this.forwardFrame(subscription, parseSSEFrame(buffer))
      } finally {
        disarmStall()
        reader.releaseLock()
        if (subscription.reader === reader) subscription.reader = undefined
      }
    } catch (error) {
      if (!subscription.closed && subscription.controller === controller && !(error instanceof DOMException && error.name === "AbortError")) {
        this.publishStatus(subscription, { type: "connection-error", error: errorMessage(error) })
      }
    }
    if (subscription.controller === controller) subscription.controller = undefined
    if (!subscription.closed && this.subscriptions.get(subscription.id) === subscription) this.scheduleReconnect(subscription)
  }

  private forwardFrame(subscription: ActiveSubscription, event: ParsedOpenCodeEvent | null): void {
    if (!event) return
    if (event.ok) this.publishEvent(subscription, event)
    else this.publishStatus(subscription, { type: "parse-error", data: event.raw })
  }

  private close(subscription: ActiveSubscription): void {
    if (subscription.closed) return
    this.publishStatus(subscription, { type: "closed" })
    subscription.closed = true
    clearTimeout(subscription.connectTimer)
    subscription.connectTimer = undefined
    clearTimeout(subscription.reconnectTimer)
    subscription.reconnectTimer = undefined
    subscription.controller?.abort()
    void subscription.reader?.cancel().catch(() => undefined)
    subscription.controller = undefined
    subscription.reader = undefined
    this.subscriptions.delete(subscription.id)
  }
}
