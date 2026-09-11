import React, { useEffect, useMemo, useRef, useState } from "react"
import ReactDOM from "react-dom/client"
import { Capacitor } from "@capacitor/core"
import { installAppPreferences } from "./appPreferences"
import { installCompletionAudioGuard } from "./completion-audio"
import { StandaloneUniversalWorkspace } from "./components/standalone-universal-workspace"
import { syncDesktopProfiles, isDesktopPlatform } from "./desktopBridge"
import { ErrorBoundary } from "./ErrorBoundary"
import {
  claimMachinePairing,
  scanAndroidMachinePairing,
  subscribeAndroidMachinePairing,
  upsertPairedMachine,
  type MachinePairingActivation
} from "./machine-pairing"
import { SERVER_STORAGE_KEYS } from "./storageKeys"
import {
  loadWorkspaceMachines,
  persistWorkspaceMachines,
  type WorkspaceMachine
} from "./workspaceMachines"
import "./styles.css"
import "./taskdesk-theme.css"
import "./universal-workspace-readable-fixes.css"
import "./taskdesk-v3-unified.css"
import "./conversation-control-plane-overrides.css"
import "./conversation-control-plane-mobile-polish.css"
import "./v3-mobile-regression-fixes.css"
import "./v3-mobile-landscape-grid-fix.css"
import "./v3-mobile-workspace-switcher-polish.css"
import "./v3-mobile-a11y-fix.css"
import "./v3-mobile-product-parity.css"
import "./session-first-navigation.css"
import "./session-first-workbench.css"
import "./conversation-base.css"
import "./session-first-centering-fix.css"
import "./session-handoff-routing.css"
import "./machine-pairing.css"
// Loaded last: the ported controls refine rules the sheets above already set, and settling those
// ties by load order is what keeps the port free of `!important`.
import "./beautiful-ui-controls.css"

installAppPreferences()
installCompletionAudioGuard()

type PairingNotice = {
  kind: "working" | "success" | "error"
  text: string
}

function HarnessRemoteBoundary() {
  const [revision, setRevision] = useState(0)
  const machines = useMemo(loadWorkspaceMachines, [revision])
  const machinesRef = useRef(machines)
  machinesRef.current = machines
  const pairingInFlightRef = useRef(new Set<string>())
  const pairedGrantRef = useRef(new Set<string>())
  const [desktopReady, setDesktopReady] = useState(() => !isDesktopPlatform())
  const [desktopSyncError, setDesktopSyncError] = useState<Error | null>(null)
  const [pairingNotice, setPairingNotice] = useState<PairingNotice | null>(null)
  const [pairingScanBusy, setPairingScanBusy] = useState(false)

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

  async function claimPairingActivation(activation: MachinePairingActivation): Promise<void> {
    const grantKey = `${activation.endpoint}\u0000${activation.token}`
    if (pairedGrantRef.current.has(grantKey) || pairingInFlightRef.current.has(grantKey)) return
    pairingInFlightRef.current.add(grantKey)
    setPairingNotice({ kind: "working", text: "Connecting to this machine…" })
    try {
      const paired = await claimMachinePairing(activation)
      pairedGrantRef.current.add(grantKey)
      const nextMachines = upsertPairedMachine(machinesRef.current, paired)
      machinesRef.current = nextMachines
      persistMachines(nextMachines)
      setPairingNotice({ kind: "success", text: `${paired.name} is connected.` })
    } catch (error) {
      // A transport failure does not imply the daemon consumed the grant. A re-scan therefore gets
      // another chance until the server itself reports used/expired.
      setPairingNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "Machine pairing failed."
      })
    } finally {
      pairingInFlightRef.current.delete(grantKey)
    }
  }

  useEffect(() => subscribeAndroidMachinePairing((activation) => {
    void claimPairingActivation(activation)
  }), [])

  async function scanPairingQR(): Promise<void> {
    if (pairingScanBusy) return
    setPairingScanBusy(true)
    try {
      const activation = await scanAndroidMachinePairing()
      if (activation) await claimPairingActivation(activation)
    } catch (error) {
      setPairingNotice({
        kind: "error",
        text: error instanceof Error ? error.message : "QR pairing failed."
      })
    } finally {
      setPairingScanBusy(false)
    }
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

  const showFirstRunScanner = machines.length === 0 && Capacitor.getPlatform() === "android"

  return (
    <>
      <StandaloneUniversalWorkspace
        machines={machines}
        onPersistMachines={persistMachines}
      />
      {showFirstRunScanner ? (
        <section className="hr-machine-pairing-first-run" aria-label="Quick machine pairing">
          <span>
            <strong>Quick setup</strong>
            Scan the QR code shown by the Harness Remote daemon on your computer, or enter the connection details manually.
          </span>
          <button type="button" className="tdw-button primary" disabled={pairingScanBusy} onClick={() => void scanPairingQR()}>
            {pairingScanBusy ? "Opening scanner…" : "Scan QR code"}
          </button>
        </section>
      ) : null}
      {pairingNotice ? (
        <div
          className={`hr-machine-pairing-notice ${pairingNotice.kind}`}
          role={pairingNotice.kind === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          <span><strong>Machine pairing</strong>{pairingNotice.text}</span>
          <button type="button" onClick={() => setPairingNotice(null)} aria-label="Dismiss machine pairing status">×</button>
        </div>
      ) : null}
    </>
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
