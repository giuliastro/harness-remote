import React, { useEffect, useMemo, useRef, useState } from "react"
import ReactDOM from "react-dom/client"
import { Capacitor } from "@capacitor/core"
import type { DesktopLocalRuntimeState } from "../electron/ipc-contract"
import { installAppPreferences } from "./appPreferences"
import { installCompletionAudioGuard } from "./completion-audio"
import { StandaloneUniversalWorkspace } from "./components/standalone-universal-workspace"
import {
  desktopLocalRuntimeState,
  isDesktopPlatform,
  retryDesktopLocalRuntime,
  syncDesktopProfiles
} from "./desktopBridge"
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
  DESKTOP_LOCAL_MACHINE_ID,
  isDesktopLocalMachine,
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

function localRuntimeMachine(state: DesktopLocalRuntimeState | null): WorkspaceMachine | null {
  if (state?.status !== "ready") return null
  return {
    id: DESKTOP_LOCAL_MACHINE_ID,
    name: "This computer",
    config: {
      backend: "opencode",
      host: state.machine.host,
      port: state.machine.port,
      // Credentials intentionally stay in Electron main. desktopBridge maps this loopback endpoint
      // to the main-owned volatile profile before any request or event subscription is dispatched.
      username: "",
      password: ""
    }
  }
}

function HarnessRemoteBoundary() {
  const [revision, setRevision] = useState(0)
  const persistedMachines = useMemo(loadWorkspaceMachines, [revision])
  const [localRuntime, setLocalRuntime] = useState<DesktopLocalRuntimeState | null>(null)
  const machines = useMemo(() => {
    const local = localRuntimeMachine(localRuntime)
    return local ? [local, ...persistedMachines.filter((machine) => !isDesktopLocalMachine(machine))] : persistedMachines
  }, [localRuntime, persistedMachines])
  const machinesRef = useRef(machines)
  machinesRef.current = machines
  const pairingInFlightRef = useRef(new Set<string>())
  const pairedGrantRef = useRef(new Set<string>())
  const [desktopReady, setDesktopReady] = useState(() => !isDesktopPlatform())
  const [desktopSyncError, setDesktopSyncError] = useState<Error | null>(null)
  const [pairingNotice, setPairingNotice] = useState<PairingNotice | null>(null)
  const [pairingScanBusy, setPairingScanBusy] = useState(false)

  // Persistent remote-machine profiles are still acknowledged before the workspace starts issuing
  // requests. The desktop-owned local runtime is intentionally absent from this snapshot: its
  // credentials live only in Electron main's volatile registry.
  useEffect(() => {
    if (!isDesktopPlatform()) return
    let cancelled = false
    void syncDesktopProfiles(persistedMachines).then(
      () => { if (!cancelled) setDesktopReady(true) },
      (error: unknown) => {
        if (!cancelled) setDesktopSyncError(error instanceof Error ? error : new Error("Desktop profile synchronization failed"))
      }
    )
    return () => { cancelled = true }
    // Initial bootstrap only. Later edits synchronize before revision exposes the new machine list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Main starts the embedded daemon independently so a missing local harness cannot block the app.
  // Poll its tiny public state: fast while starting, then slowly enough to notice an unexpected exit
  // and remove the stale loopback endpoint without turning this into another machine refresh loop.
  useEffect(() => {
    if (!isDesktopPlatform()) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const state = await desktopLocalRuntimeState()
        if (cancelled) return
        setLocalRuntime(state)
        timer = setTimeout(refresh, state?.status === "starting" ? 400 : 4_000)
      } catch (error) {
        if (cancelled) return
        setLocalRuntime({
          status: "unavailable",
          error: error instanceof Error ? error.message : "Local desktop runtime is unavailable."
        })
        timer = setTimeout(refresh, 4_000)
      }
    }
    void refresh()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])

  const persistMachines = (nextMachines: WorkspaceMachine[]) => {
    // Runtime-owned machines are projections, not settings. Even an edit/remove attempt from a stale
    // manager surface cannot serialize them or replace the main-process profile.
    const persistent = nextMachines.filter((machine) => !isDesktopLocalMachine(machine))
    persistWorkspaceMachines(persistent)
    if (!isDesktopPlatform()) {
      setRevision((value) => value + 1)
      return
    }
    void syncDesktopProfiles(persistent).then(
      () => setRevision((value) => value + 1),
      (error: unknown) => setDesktopSyncError(error instanceof Error ? error : new Error("Desktop profile synchronization failed"))
    )
  }

  async function retryLocalRuntime(): Promise<void> {
    setLocalRuntime({ status: "starting" })
    try {
      setLocalRuntime(await retryDesktopLocalRuntime())
    } catch (error) {
      setLocalRuntime({
        status: "unavailable",
        error: error instanceof Error ? error.message : "Local desktop runtime is unavailable."
      })
    }
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

  return (
    <>
      <StandaloneUniversalWorkspace
        machines={machines}
        onPersistMachines={persistMachines}
      />
      {isDesktopPlatform() && localRuntime?.status === "unavailable" ? (
        <div className="hr-machine-pairing-notice error" role="status" aria-live="polite">
          <span><strong>Local desktop runtime</strong>{localRuntime.error}</span>
          <button type="button" onClick={() => void retryLocalRuntime()}>Retry</button>
        </div>
      ) : null}
      {Capacitor.getPlatform() === "android" ? (
        <button
          type="button"
          className="uw-manager-button hr-machine-pairing-editor-action"
          data-machine-pairing-scan
          disabled={pairingScanBusy}
          onClick={() => void scanPairingQR()}
        >
          {pairingScanBusy ? "Opening scanner…" : "Scan QR code"}
        </button>
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