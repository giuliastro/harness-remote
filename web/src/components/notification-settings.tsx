import { useEffect, useState } from "react"
import type { Translator } from "../i18n"
import {
  notificationPlatform,
  saveNotificationPreferences,
  useNotificationPreferences,
  type NotificationPreferences
} from "../notification-preferences"
import { requestWebNotificationPermission, webNotificationPermission, type WebNotificationPermission } from "../user-notifications"

/**
 * Settings → Notifications. One master switch and one per kind, stored per device. On the web the
 * browser permission is requested only when the user turns notifications on here, and a blocked
 * permission is said plainly instead of leaving a switch that looks on but does nothing.
 */
export function NotificationSettingsGroup({ t }: { t: Translator }) {
  const preferences = useNotificationPreferences()
  const platform = notificationPlatform()
  const [permission, setPermission] = useState<WebNotificationPermission>(() =>
    platform === "web" ? webNotificationPermission() : "granted"
  )
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (platform !== "web") return
    // The user can change the site permission in the browser while Settings is open.
    const refresh = () => setPermission(webNotificationPermission())
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [platform])

  async function change(next: Partial<NotificationPreferences>) {
    const merged = { ...preferences, ...next }
    if (platform === "web" && next.enabled === true && webNotificationPermission() === "default") {
      setBusy(true)
      try {
        const answer = await requestWebNotificationPermission()
        setPermission(answer)
        if (answer !== "granted") merged.enabled = false
      } finally {
        setBusy(false)
      }
    }
    saveNotificationPreferences(merged)
  }

  const blocked = platform === "web" && permission === "denied"
  const unsupported = platform === "web" && permission === "unsupported"
  const kindsDisabled = !preferences.enabled || blocked || unsupported || busy
  const hint = platform === "web"
    ? t("settings.notificationsHintWeb")
    : platform === "android"
      ? t("settings.notificationsHintAndroid")
      : t("settings.notificationsHintDesktop")

  return (
    <div className="hr-mobile-settings-group" data-settings-notifications>
      <span>{t("settings.notificationsTitle")}</span>
      <label data-icon="notifications">
        <strong>{t("settings.notificationsEnabled")}</strong>
        <input
          type="checkbox"
          data-notifications-enabled
          checked={preferences.enabled && !blocked && !unsupported}
          disabled={busy || blocked || unsupported}
          onChange={(event) => void change({ enabled: event.target.checked })}
        />
      </label>
      <label data-icon="finished">
        <strong>{t("settings.notificationsReady")}</strong>
        <input type="checkbox" data-notifications-ready checked={preferences.ready} disabled={kindsDisabled} onChange={(event) => void change({ ready: event.target.checked })} />
      </label>
      <label data-icon="failed">
        <strong>{t("settings.notificationsFailed")}</strong>
        <input type="checkbox" data-notifications-failed checked={preferences.failed} disabled={kindsDisabled} onChange={(event) => void change({ failed: event.target.checked })} />
      </label>
      <label data-icon="attention">
        <strong>{t("settings.notificationsAttention")}</strong>
        <input type="checkbox" data-notifications-attention checked={preferences.attention} disabled={kindsDisabled} onChange={(event) => void change({ attention: event.target.checked })} />
      </label>
      <p role={blocked || unsupported ? "alert" : undefined}>
        {blocked ? t("settings.notificationsBlocked") : unsupported ? t("settings.notificationsUnsupported") : hint}
      </p>
    </div>
  )
}
