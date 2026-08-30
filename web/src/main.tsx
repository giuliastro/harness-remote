import React, { useEffect, useMemo, useState } from "react"
import ReactDOM from "react-dom/client"
import { Capacitor } from "@capacitor/core"
import { installAppPreferences } from "./appPreferences"
import { installCompletionAudioGuard } from "./completion-audio"
import { StandaloneUniversalWorkspace } from "./components/standalone-universal-workspace"
import { syncDesktopProfiles, isDesktopPlatform } from "./desktopBridge"
import { ErrorBoundary } from "./ErrorBoundary"
import { SERVER_STORAGE_KEYS } from "./storageKeys"
import {
  loadWorkspaceMachines,
  persistWorkspaceMachines,
  type WorkspaceMachine
} from "./workspaceMachines"
import "./styles.css"
import "./taskdesk-theme.css"
import "./universal-workspace.css"
import "./universal-workspace-readable.css"
import "./universal-workspace-readable-fixes.css"
import "./taskdesk-v3.css"
import "./taskdesk-v3-unified.css"
import "./taskdesk-run-review.css"
import "./v3-polish.css"
import "./conversation-control-plane-overrides.css"
import "./conversation-control-plane-mobile-polish.css"
import "./v3-mobile-regression-fixes.css"
import "./v3-mobile-landscape-grid-fix.css"
import "./v3-mobile-workspace-switcher-polish.css"
import "./v3-mobile-a11y-fix.css"
import "./v3-mobile-product-parity.css"
import "./session-first-navigation.css"
import "./session-first-workbench.css"
import "./session-handoff-routing.css"
// Loaded last: the ported controls refine rules the sheets above already set, and settling those
// ties by load order is what keeps the port free of `!important`.
import "./beautiful-ui-controls.css"

installAppPreferences()
installCompletionAudioGuard()


function HarnessRemoteBoundary() {
  const [revision, setRevision] = useState(0)
  const machines = useMemo(loadWorkspaceMachines, [revision])
  const [desktopReady, setDesktopReady] = useState(() => !isDesktopPlatform())
  const [desktopSyncError, setDesktopSyncError] = useState<Error | null>(null)

  // The Session-first workspace talks to the daemon immediately on mount. Electron must therefore
  // acknowledge the stable WorkspaceMachine allowlist before the workspace is allowed to discover
  // /v1/machine; otherwise the first request fails locally as "Unknown desktop server profile".
  useEffect(() => {
    if (!isDesktopPlatform()) return
    let cancelled = false
    void syncDesktopProfiles(machines).then(
      () => { if (!cancelled) setDesktopReady(true) },
      (error: unknown) => {
        if (!cancelled) setDesktopSyncError(error instanceof Error ? error : new Error("Desktop profile synchronization failed"))
      }
    )
    return () => { cancelled = true }
    // Initial bootstrap only. Later edits synchronize before revision exposes the new machine list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const persistMachines = (nextMachines: WorkspaceMachine[]) => {
    persistWorkspaceMachines(nextMachines)
    if (!isDesktopPlatform()) {
      setRevision((value) => value + 1)
      return
    }
    void syncDesktopProfiles(nextMachines).then(
      () => setRevision((value) => value + 1),
      (error: unknown) => setDesktopSyncError(error instanceof Error ? error : new Error("Desktop profile synchronization failed"))
    )
  }

  if (desktopSyncError) throw desktopSyncError
  if (!desktopReady) {
    return (
      <div className="uw-standalone-host" aria-busy="true">
        <div className="hr-native-workspace-empty hr-native-startup connecting" role="status">
          Preparing desktop connection…
        </div>
      </div>
    )
  }

  return (
    <StandaloneUniversalWorkspace
      machines={machines}
      onPersistMachines={persistMachines}
    />
  )
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary resetKeys={SERVER_STORAGE_KEYS}>
      <HarnessRemoteBoundary />
    </ErrorBoundary>
  </React.StrictMode>
)

if (import.meta.env.DEV && !Capacitor.isNativePlatform() && !window.harnessDesktop?.platform.isDesktop) {
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.getRegistrations().then((registrations) =>
      Promise.all(registrations.map((registration) => registration.unregister()))
    )
  }
  if ("caches" in window) {
    void caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith("harness-remote-")).map((key) => caches.delete(key)))
    )
  }
}

if (import.meta.env.PROD && !Capacitor.isNativePlatform() && !window.harnessDesktop?.platform.isDesktop && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const base = import.meta.env.BASE_URL
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {})
  })
}
