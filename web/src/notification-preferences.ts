import { Capacitor } from "@capacitor/core"
import { useSyncExternalStore } from "react"
import { isDesktopShell } from "./desktopBridge"

/**
 * Which Session notifications this device shows. Stored per device, so a phone and a desktop can
 * differ. The operating system or browser permission stays the final word on top of this.
 */
export type NotificationPreferences = {
  /** Master switch for this device. Off means no Session notifications at all. */
  enabled: boolean
  /** A turn finished. */
  ready: boolean
  /** A turn ended with an error. */
  failed: boolean
  /** A permission request, a question or a recoverable error needs the user. */
  attention: boolean
}

export type NotificationPlatform = "desktop" | "android" | "web"

const STORAGE_KEY = "harness-remote.notifications.v1"
const listeners = new Set<() => void>()
let cached: NotificationPreferences | null = null

export function notificationPlatform(): NotificationPlatform {
  if (Capacitor.getPlatform() === "android") return "android"
  return isDesktopShell() ? "desktop" : "web"
}

/**
 * Installed apps notify by default. The web starts off: the browser asks for permission only when
 * the user turns notifications on, never as a surprise on page load.
 */
export function defaultNotificationPreferences(platform: NotificationPlatform = notificationPlatform()): NotificationPreferences {
  return { enabled: platform !== "web", ready: true, failed: true, attention: true }
}

export function normalizeNotificationPreferences(value: unknown, platform?: NotificationPlatform): NotificationPreferences {
  const defaults = defaultNotificationPreferences(platform)
  if (!value || typeof value !== "object") return defaults
  const candidate = value as Partial<Record<keyof NotificationPreferences, unknown>>
  const flag = (key: keyof NotificationPreferences) => typeof candidate[key] === "boolean" ? candidate[key] as boolean : defaults[key]
  return { enabled: flag("enabled"), ready: flag("ready"), failed: flag("failed"), attention: flag("attention") }
}

export function loadNotificationPreferences(): NotificationPreferences {
  if (cached) return cached
  let stored: unknown
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    stored = raw ? JSON.parse(raw) : undefined
  } catch {
    stored = undefined
  }
  cached = normalizeNotificationPreferences(stored)
  return cached
}

export function saveNotificationPreferences(next: NotificationPreferences): void {
  cached = normalizeNotificationPreferences(next)
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(cached)) } catch { /* private mode keeps it in memory */ }
  for (const listener of listeners) listener()
}

export function subscribeNotificationPreferences(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useNotificationPreferences(): NotificationPreferences {
  return useSyncExternalStore(subscribeNotificationPreferences, loadNotificationPreferences, loadNotificationPreferences)
}

/** Whether a given kind should be shown right now on this device. */
export function notificationKindEnabled(kind: "ready" | "failed" | "attention", preferences = loadNotificationPreferences()): boolean {
  return preferences.enabled && preferences[kind]
}

/** Test seam: forget the cached value so a test can change localStorage between cases. */
export function resetNotificationPreferencesCache(): void {
  cached = null
}
