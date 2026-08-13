import type { BackendKind } from "../src/types.js"

export const IPC_CHANNELS = Object.freeze({
  replaceProfiles: "desktop:profiles:replace",
  request: "desktop:request",
  subscribeEvents: "desktop:events:subscribe",
  unsubscribeEvents: "desktop:events:unsubscribe",
  notifyCompletion: "desktop:completion:notify",
  event: "desktop:events:event",
  menuCommand: "desktop:menu:command",
  setMenu: "desktop:menu:set"
})

export type DesktopProfileSyncResult = {
  revision: number
  acceptedProfileIDs: string[]
  changedProfileIDs: string[]
  removedProfileIDs: string[]
  unchangedProfileIDs: string[]
}

export type DesktopCompletionNotification = {
  title: string
  body: string
  overlayDescription: string
}

export type DesktopProfile = {
  id: string
  backend: BackendKind
  host: string
  port: number
  username: string
  password: string
  agentId?: string
}

export type DesktopRequestMethod = "GET" | "POST" | "PATCH" | "DELETE"

export type DesktopRequest = {
  path: string
  method?: DesktopRequestMethod
  body?: unknown
  readTimeout?: number
}

export type DesktopResponse = {
  status: number
  data: unknown
  headers: Record<string, string>
}

export type DesktopTransportError = {
  code:
    | "invalid-payload"
    | "unknown-profile"
    | "invalid-path"
    | "invalid-profile"
    | "timeout"
    | "connection"
    | "redirect"
    | "response-too-large"
    | "http"
    | "internal"
  message: string
}

export type DesktopRequestResult =
  | { ok: true; response: DesktopResponse }
  | { ok: false; error: DesktopTransportError }

export type DesktopEventSubscriptionOptions = {
  scope: "global" | "project"
  directory?: string
}

export type DesktopEvent = {
  name: string
  raw: string
  data: unknown
}

export type DesktopEventStatus =
  | { type: "connected" }
  | { type: "reconnecting"; delayMs: number }
  | { type: "connection-error"; error: string }
  | { type: "parse-error"; data: string }
  | { type: "closed" }

export type DesktopEventMessage =
  | { subscriptionId: string; kind: "event"; event: DesktopEvent }
  | { subscriptionId: string; kind: "status"; status: DesktopEventStatus }

export type DesktopSubscribeResult = { subscriptionId: string }

/**
 * The platform menu bar drives the renderer by sending one of these. They are the same identifiers
 * the in-app menu bar and the command palette use, so the packaged app and the browser build cannot
 * end up with two different notions of what "New session" does.
 */
export const DESKTOP_MENU_COMMANDS = [
  "session.new",
  "session.refresh",
  "session.rename",
  "session.delete",
  "session.stop",
  "session.undo",
  "session.redo",
  "focus.composer",
  "focus.search",
  "server.add",
  "server.settings",
  "view.palette",
  "view.inspector",
  "view.theme.system",
  "view.theme.light",
  "view.theme.dark",
  "help.open"
] as const

export type DesktopMenuCommand = (typeof DESKTOP_MENU_COMMANDS)[number]
