import { isDesktopShell, notifyDesktopAttention } from "./desktopBridge"
import type { DesktopAttentionNotification, DesktopAttentionTarget } from "../electron/ipc-contract"

/**
 * One way to show a Session notification on desktop and web. Android is not handled here: its
 * native background service posts notifications even while the WebView is suspended.
 *
 * Electron goes through the main process, which shows a native notification, skips it while the
 * window is focused and focuses the window on click. The web uses the browser Notification API,
 * which only works while a Harness Remote tab is open; a click focuses that tab and opens the Session
 * through the same activation path.
 */
export type WebNotificationPermission = "granted" | "denied" | "default" | "unsupported"

const webActivationListeners = new Set<(target: DesktopAttentionTarget) => void>()

function browserNotifications(): typeof Notification | undefined {
  return typeof globalThis.Notification === "function" ? globalThis.Notification : undefined
}

export function webNotificationPermission(): WebNotificationPermission {
  const api = browserNotifications()
  if (!api) return "unsupported"
  return api.permission as WebNotificationPermission
}

/** Ask the browser for permission. Call this only from a user gesture (the Settings toggle). */
export async function requestWebNotificationPermission(): Promise<WebNotificationPermission> {
  const api = browserNotifications()
  if (!api) return "unsupported"
  if (api.permission !== "default") return api.permission as WebNotificationPermission
  try {
    return (await api.requestPermission()) as WebNotificationPermission
  } catch {
    return webNotificationPermission()
  }
}

/** The user is looking at this window right now. */
export function windowIsInFront(): boolean {
  if (typeof document === "undefined") return false
  return document.visibilityState === "visible" && (typeof document.hasFocus !== "function" || document.hasFocus())
}

export function showSessionNotification(notification: DesktopAttentionNotification): void {
  if (isDesktopShell()) {
    notifyDesktopAttention(notification)
    return
  }
  const api = browserNotifications()
  if (!api || api.permission !== "granted" || windowIsInFront()) return
  try {
    const shown = new api(notification.title, {
      body: notification.body,
      // One notification per Session: a newer outcome replaces the older one instead of stacking.
      tag: `${notification.target.machineID}:${notification.target.agentID}:${notification.target.sessionID}`
    })
    shown.onclick = () => {
      try { globalThis.focus?.() } catch { /* the browser may refuse; the activation still runs */ }
      shown.close()
      for (const listener of webActivationListeners) listener(notification.target)
    }
  } catch {
    // Some browsers only allow notifications from a service worker; the in-app rail still shows it.
  }
}

/** Clicks on browser notifications. Electron reports clicks through its own IPC channel. */
export function subscribeWebNotificationActivation(listener: (target: DesktopAttentionTarget) => void): () => void {
  webActivationListeners.add(listener)
  return () => { webActivationListeners.delete(listener) }
}
