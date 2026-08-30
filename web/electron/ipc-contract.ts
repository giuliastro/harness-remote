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

export type DesktopRequestRoute = {
  backend: BackendKind
  agentId?: string
}

export type DesktopRequest = {
  path: string
  method?: DesktopRequestMethod
  body?: unknown
  readTimeout?: number
  /** Harness routing within an already-approved machine endpoint. */
  route?: DesktopRequestRoute
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
  status?: number
}

export type DesktopRequestResult =
  | { ok: true; response: DesktopResponse }
  | { ok: false; error: DesktopTransportError }

export type DesktopEventSubscriptionOptions = {
  scope: "global" | "project"
  directory?: string
  /** Optional TaskDesk route within the already approved machine profile. */
  backend?: BackendKind
  agentId?: string
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

export function isDesktopMenuCommand(value: unknown): value is DesktopMenuCommand {
  return typeof value === "string" && (DESKTOP_MENU_COMMANDS as readonly string[]).includes(value)
}

/**
 * The renderer owns what the menu says and when each item applies. It is the side that knows the
 * language, the connected harness and the selected session. Main renders whatever it is handed and
 * echoes clicks back as command ids, so the platform menu and the in-app one stay one implementation
 * rather than two that drift.
 */
export type DesktopMenuItemDescriptor =
  | {
      kind: "item"
      command: DesktopMenuCommand
      label: string
      accelerator?: string
      enabled?: boolean
      checked?: boolean
    }
  | { kind: "separator" }

export type DesktopMenuDescriptor = {
  id: string
  label: string
  items: DesktopMenuItemDescriptor[]
}

export type DesktopMenuTemplate = DesktopMenuDescriptor[]

const MENU_LABEL_MAX_LENGTH = 80
const MENU_ACCELERATOR_MAX_LENGTH = 40
const MENU_MAX_MENUS = 12
const MENU_MAX_ITEMS = 40
/** Electron accelerators are a closed grammar; anything outside it either throws on
 *  `buildFromTemplate` or silently binds something nobody asked for. */
const ACCELERATOR_PATTERN = /^([A-Za-z0-9]+\+)*[A-Za-z0-9,.\/\\[\]`'-]+$/

/** Menu text crosses a process boundary, so it is validated like every other IPC payload rather
 *  than trusted: bounded, printable, and free of the control characters a native menu would render
 *  as garbage. */
function menuText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function parseMenuItem(value: unknown): DesktopMenuItemDescriptor | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<DesktopMenuItemDescriptor> & { kind?: unknown }
  if (candidate.kind === "separator") return { kind: "separator" }
  if (candidate.kind !== "item") return null
  const item = candidate as Partial<Extract<DesktopMenuItemDescriptor, { kind: "item" }>>
  if (!isDesktopMenuCommand(item.command)) return null
  if (!menuText(item.label, MENU_LABEL_MAX_LENGTH)) return null
  if (item.accelerator !== undefined) {
    if (!menuText(item.accelerator, MENU_ACCELERATOR_MAX_LENGTH)) return null
    if (!ACCELERATOR_PATTERN.test(item.accelerator)) return null
  }
  if (item.enabled !== undefined && typeof item.enabled !== "boolean") return null
  if (item.checked !== undefined && typeof item.checked !== "boolean") return null
  return {
    kind: "item",
    command: item.command,
    label: item.label,
    accelerator: item.accelerator,
    enabled: item.enabled,
    checked: item.checked
  }
}

/** Returns null rather than throwing on the first bad field: a malformed template must leave the
 *  menu that is already installed alone, not replace it with a half-built one. */
export function parseDesktopMenuTemplate(value: unknown): DesktopMenuTemplate | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MENU_MAX_MENUS) return null
  const template: DesktopMenuTemplate = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null
    const menu = entry as Partial<DesktopMenuDescriptor>
    if (!menuText(menu.id, MENU_LABEL_MAX_LENGTH) || !menuText(menu.label, MENU_LABEL_MAX_LENGTH)) return null
    if (!Array.isArray(menu.items) || menu.items.length === 0 || menu.items.length > MENU_MAX_ITEMS) return null
    const items: DesktopMenuItemDescriptor[] = []
    for (const rawItem of menu.items) {
      const item = parseMenuItem(rawItem)
      if (!item) return null
      items.push(item)
    }
    template.push({ id: menu.id, label: menu.label, items })
  }
  return template
}
