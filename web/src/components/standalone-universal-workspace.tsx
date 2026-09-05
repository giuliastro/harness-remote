import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { App as CapacitorApp } from "@capacitor/app"
import { api } from "../api"
import { Capacitor } from "@capacitor/core"
import {
  isThemePreference,
  loadLanguage,
  loadThemePreference,
  persistLanguage,
  persistThemePreference,
  type ThemePreference
} from "../appPreferences"
import { ChatIcon, LoadingIcon, RefreshIcon, ServerIcon, SettingsIcon } from "../Icons"
import { createTranslator, languageOptions, type LanguageCode } from "../i18n"
import {
  createBurstLimiter,
  isStreamReconnecting,
  machinePollIntervalMs,
  MACHINE_LIVE_REFRESH_BURST_MS,
  MACHINE_RECONNECT_POLL_MS
} from "../machine-live-refresh"
import { discoverMachine, machineAgentStateLabel } from "../machineClient"
import {
  discoverAgentNativeSessions,
  nativeSessionSurfaceTarget,
  type NativeSessionLink,
  type NativeSessionRef,
  type NativeSessionSurfaceTarget
} from "../native-session-discovery"
import { migrateNativeSessionMachineStorage } from "../native-session-machine-id-migration"
import { nativeSessionTransferredContext } from "../native-session-prompt"
import type { NativeSessionRouteMachine } from "../native-session-routing"
import type { MachineSnapshot, Session } from "../types"
import { subscribeTaskDeskLiveEvents } from "../taskdesk-live-events"
import {
  createWorkspaceMachine,
  type WorkspaceMachine
} from "../workspaceMachines"
import { reuseList } from "../workspace-runtime-merge"
import { useDialogDismiss } from "../useDialogDismiss"
import { useTranslator } from "../useTranslator"
import { CommandPalette, type PaletteCommand } from "./shell"
import { NativeSessionActions } from "./native-session-actions"
import { NativeSessionHome } from "./native-session-home"
import { NativeSessionTitle } from "./native-session-rename"
import { NativeSessionObserver, type NativeSessionVisualState } from "./native-session-observer"
import "../taskdesk-workthreads.css"
import "../taskdesk-mobile-navigation.css"
import "../taskdesk-focus-layout.css"
import "../conversation-control-plane.css"

/** The 2.x shell persisted its sidebar width and this one did not, so a large monitor got the same
 *  rail as a laptop. Its own key: the two shells have different rails and different defaults. */
const RAIL_WIDTH_STORAGE_KEY = "harness-remote.sessionRailWidth.v1"
const RAIL_WIDTH_MIN = 260
const RAIL_WIDTH_MAX = 620
/** One arrow press. Wide enough to be worth pressing, small enough to land on an exact width. */
const RAIL_WIDTH_STEP = 16
// Mobile WebViews and freshly-started harnesses can transiently miss one daemon probe while an
// operation is starting. Retry once inside the same refresh, then require repeated misses before a
// machine that was already confirmed online is demoted to offline.
const MACHINE_DISCOVERY_RETRY_MS = 350
const MACHINE_OFFLINE_FAILURE_THRESHOLD = 3

async function discoverMachineWithRetry(config: WorkspaceMachine["config"]): Promise<MachineSnapshot | null> {
  const fresh = () => discoverMachine(config, { allowCachedOnTransportFailure: false })
  try {
    return await fresh()
  } catch {
    await new Promise<void>((resolve) => setTimeout(resolve, MACHINE_DISCOVERY_RETRY_MS))
    return fresh()
  }
}

function clampRailWidth(value: number): number {
  return Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, Math.round(value)))
}

function loadRailWidth(): number | null {
  try {
    const raw = Number(localStorage.getItem(RAIL_WIDTH_STORAGE_KEY))
    // No stored width means "use the stylesheet's responsive clamp", which is a better default than
    // any number this module could invent for a window it has not seen yet.
    return Number.isFinite(raw) && raw > 0 ? clampRailWidth(raw) : null
  } catch {
    return null
  }
}

type Props = {
  machines: WorkspaceMachine[]
  onPersistMachines: (machines: WorkspaceMachine[]) => void
}
type NativeMachineRuntime = {
  machine: WorkspaceMachine
  snapshot: MachineSnapshot | null
  state: "loading" | "online" | "offline"
  error?: string
  consecutiveFailures?: number
}


type MachineEditorProps = {
  machine: WorkspaceMachine
  isNew: boolean
  onCancel: () => void
  onSave: (machine: WorkspaceMachine) => void
}

function MachineEditor({ machine, isNew, onCancel, onSave }: MachineEditorProps) {
  const t = useTranslator()
  const [name, setName] = useState(machine.name)
  const [host, setHost] = useState(machine.config.host)
  const [port, setPort] = useState(String(machine.config.port))
  const [username, setUsername] = useState(machine.config.username)
  const [password, setPassword] = useState(machine.config.password)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  const validPort = Number(port) >= 1 && Number(port) <= 65_535
  const valid = Boolean(host.trim() && validPort)

  const nextMachine = (): WorkspaceMachine => ({
    ...machine,
    name: name.trim() || host.trim() || "Machine",
    config: {
      backend: "opencode",
      host: host.trim(),
      port: Number(port),
      username: username.trim(),
      password
    }
  })

  async function testConnection() {
    if (!valid || testing) return
    setTesting(true)
    setTestResult(null)
    try {
      const snapshot = await discoverMachine(nextMachine().config)
      if (!snapshot) {
        setTestResult({ ok: false, text: t("sf.notADaemon") })
      } else {
        const count = snapshot.agents.length
        setTestResult({ ok: true, text: t("sf.connectedTo", { name: snapshot.machine.name, count }) })
      }
    } catch (error) {
      setTestResult({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="uw-machine-editor">
      <div className="uw-machine-editor-grid">
        <label><span>{t("sf.fieldName")}</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("sf.machineNamePlaceholder")} /></label>
        {/* A phone keyboard capitalises the first letter by default, which silently turned `localhost`
            into `Localhost` and a username into a different username. Neither field is prose. */}
        <label><span>{t("sf.fieldHost")}</span><input value={host} onChange={(event) => setHost(event.target.value)} placeholder="192.168.1.20 or localhost" spellCheck={false} autoCapitalize="none" autoCorrect="off" /></label>
        <label><span>{t("sf.fieldPort")}</span><input value={port} onChange={(event) => setPort(event.target.value.replace(/\D/g, ""))} inputMode="numeric" /></label>
        <label><span>{t("sf.fieldUsername")}</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" spellCheck={false} autoCapitalize="none" autoCorrect="off" /></label>
        <label className="uw-machine-editor-wide"><span>{t("sf.fieldPassword")}</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
      </div>
      {testResult ? <div className={`uw-machine-test-result ${testResult.ok ? "ok" : "error"}`}>{testResult.text}</div> : null}
      <div className="uw-machine-editor-actions">
        <button type="button" className="uw-manager-button" onClick={onCancel}>{t("sf.cancel")}</button>
        <button type="button" className="uw-manager-button" disabled={!valid || testing} onClick={() => void testConnection()}>{testing ? t("sf.testing") : t("sf.testConnection")}</button>
        <button type="button" className="uw-manager-button primary" disabled={!valid} onClick={() => valid && onSave(nextMachine())}>{isNew ? t("sf.addMachineAction") : t("sf.saveMachine")}</button>
      </div>
    </div>
  )
}

function MachineManager({ machines, onClose, onPersist }: { machines: WorkspaceMachine[]; onClose: () => void; onPersist: (machines: WorkspaceMachine[]) => void }) {
  const t = useTranslator()
  const [editingID, setEditingID] = useState<string | null>(machines.length === 0 ? "new" : null)
  const [confirmRemoveID, setConfirmRemoveID] = useState<string | null>(null)
  const [snapshots, setSnapshots] = useState<Record<string, MachineSnapshot | null | undefined>>({})
  const dialogRef = useRef<HTMLElement>(null)
  const draft = useMemo(() => editingID === "new" ? createWorkspaceMachine() : machines.find((machine) => machine.id === editingID) || null, [editingID, machines])

  useEffect(() => {
    let cancelled = false
    setSnapshots({})
    void Promise.all(machines.map(async (machine) => {
      try { return [machine.id, await discoverMachine(machine.config)] as const }
      catch { return [machine.id, null] as const }
    })).then((entries) => {
      if (!cancelled) setSnapshots(Object.fromEntries(entries))
    })
    return () => { cancelled = true }
  }, [machines])

  useDialogDismiss(dialogRef, onClose)

  const save = (machine: WorkspaceMachine) => {
    if (editingID === "new") onPersist([...machines, machine])
    else onPersist(machines.map((candidate) => candidate.id === machine.id ? machine : candidate))
    setEditingID(null)
  }

  // window.confirm is a blocking native dialog that the Android WebView renders as a bare,
  // unstyled system alert on top of the app. An inline confirmation stays inside the product.
  const remove = (machine: WorkspaceMachine) => {
    onPersist(machines.filter((candidate) => candidate.id !== machine.id))
    setConfirmRemoveID(null)
    if (editingID === machine.id) setEditingID(null)
  }

  const availableCount = Object.values(snapshots).reduce((count, snapshot) => count + (snapshot?.agents.filter((agent) => agent.state === "available").length || 0), 0)

  return (
    <div className="uw-manager-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="uw-machine-manager" role="dialog" aria-modal="true" aria-label={t("sf.machines")} ref={dialogRef} onMouseDown={(event) => event.stopPropagation()}>
        <header className="uw-machine-manager-header">
          <div><h2>{t("sf.machines")}</h2><p>{t("sf.machinesSubtitle")}</p></div>
          <button type="button" className="uw-manager-close" onClick={onClose} aria-label={t("sf.close")}>×</button>
        </header>
        <div className="uw-machine-manager-body">
          {machines.length === 0 && editingID !== "new" ? <div className="uw-machine-manager-empty"><strong>{t("sf.noMachinesConfigured")}</strong><span>{t("sf.noMachinesBody")}</span></div> : null}
          {machines.map((machine) => {
            const snapshot = snapshots[machine.id]
            return (
              <div className="uw-machine-config-card" key={machine.id}>
                <div className="uw-machine-config-main">
                  <strong>{snapshot?.machine.name || machine.name}</strong>
                  <span>{machine.config.host}:{machine.config.port}</span>
                  <small>{snapshot === undefined ? t("sf.checkingAgents") : snapshot ? t("sf.agentsDetected", { count: snapshot.agents.length }) : t("sf.machineUnavailable")}</small>
                  {snapshot?.agents.length ? <div className="uw-machine-harness-list">{snapshot.agents.map((agent) => <span className="uw-machine-harness" key={agent.id}><i className={agent.state} aria-hidden="true" /><strong>{agent.label}</strong><small>{machineAgentStateLabel(agent.state)}{agent.processID ? ` · PID ${agent.processID}` : ""}</small></span>)}</div> : null}
                </div>
                <div className="uw-machine-config-actions">
                  {confirmRemoveID === machine.id ? (
                    <>
                      <span className="uw-machine-confirm" role="alert">{t("sf.removeQuestion", { name: machine.name })}</span>
                      <button type="button" className="uw-manager-button" onClick={() => setConfirmRemoveID(null)}>{t("sf.keep")}</button>
                      <button type="button" className="uw-manager-button danger" data-autofocus onClick={() => remove(machine)}>{t("sf.remove")}</button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="uw-manager-button" onClick={() => setEditingID(machine.id)}>{t("sf.edit")}</button>
                      <button type="button" className="uw-manager-button danger" onClick={() => setConfirmRemoveID(machine.id)}>{t("sf.remove")}</button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
          {draft ? <MachineEditor key={draft.id} machine={draft} isNew={editingID === "new"} onCancel={() => setEditingID(null)} onSave={save} /> : null}
        </div>
        <footer className="uw-machine-manager-footer"><span>{t("sf.managerFooter", { machines: machines.length, agents: availableCount })}</span><button type="button" className="uw-manager-button primary" onClick={() => setEditingID("new")}>+ {t("sf.addMachineAction")}</button></footer>
      </section>
    </div>
  )
}

function MobileSettingsPage({ onClose }: { onClose: () => void }) {
  const [language, setLanguage] = useState<LanguageCode>(loadLanguage)
  const [theme, setTheme] = useState<ThemePreference>(loadThemePreference)
  const t = useMemo(() => createTranslator(language), [language])
  const pageRef = useRef<HTMLElement>(null)
  useDialogDismiss(pageRef, onClose, { autoFocus: false })

  function changeLanguage(value: string) {
    const next = languageOptions.find((option) => option.code === value)?.code
    if (!next) return
    setLanguage(next)
    persistLanguage(next)
  }

  function changeTheme(value: string) {
    if (!isThemePreference(value)) return
    setTheme(value)
    persistThemePreference(value)
  }

  return (
    <div className="hr-session-settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="hr-mobile-settings-page hr-session-settings-page" role="dialog" aria-modal="true" aria-label={t("nav.settings")} ref={pageRef} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span>Harness Remote</span><h2>{t("nav.settings")}</h2></div>
          <button type="button" onClick={onClose} aria-label={t("action.close")}>×</button>
        </header>
        <div className="hr-mobile-settings-body">
          <div className="hr-mobile-settings-group">
            <span>{t("sf.interface")}</span>
            <label><strong>{t("settings.theme")}</strong><select value={theme} onChange={(event) => changeTheme(event.target.value)}><option value="system">{t("settings.themeSystem")}</option><option value="light">{t("settings.themeLight")}</option><option value="dark">{t("settings.themeDark")}</option></select></label>
            <label><strong>{t("settings.language")}</strong><select value={language} onChange={(event) => changeLanguage(event.target.value)}>{languageOptions.map((option) => <option value={option.code} key={option.code}>{option.label}</option>)}</select></label>
          </div>
          <p>{t("sf.appearanceShared")}</p>
        </div>
        <footer><button type="button" className="tdw-button primary" onClick={onClose}>{t("action.close")}</button></footer>
      </section>
    </div>
  )
}

function projectLabel(directory: string): string {
  const parts = directory.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || directory || "Unknown Project"
}
function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`
  return String(value)
}



function NativeSessionsWorkspace({
  machines,
  onManageMachines,
  onManageSettings,
  onAttentionCountChange
}: {
  machines: WorkspaceMachine[]
  onManageMachines: () => void
  onManageSettings: () => void
  onAttentionCountChange: (count: number) => void
}) {
  const t = useTranslator()
  const [runtimes, setRuntimes] = useState<NativeMachineRuntime[]>(() =>
    machines.map((machine) => ({ machine, snapshot: null, state: "loading", consecutiveFailures: 0 }))
  )
  const runtimesRef = useRef(runtimes)
  runtimesRef.current = runtimes
  const [loaded, setLoaded] = useState(machines.length === 0)
  const [refreshing, setRefreshing] = useState(false)
  const [revision, setRevision] = useState(0)
  // Which machines currently hold a live event stream. A streaming machine reports its own changes,
  // so it does not need the discovery timer; one that does not stream still does.
  const [liveMachines, setLiveMachines] = useState<Record<string, boolean>>({})
  const [reconnectingStreams, setReconnectingStreams] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<NativeSessionSurfaceTarget | null>(null)
  const [selectedState, setSelectedState] = useState<NativeSessionVisualState | undefined>(undefined)
  const [selectedLinks, setSelectedLinks] = useState<NativeSessionLink[]>([])
  const [lineageError, setLineageError] = useState<string | null>(null)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  // A native metadata mutation happens outside the discovery cycle. Machine polling can legitimately
  // return an identical snapshot, so the Session list needs an explicit signal to re-read its
  // Sessions after a rename or delete instead of waiting up to 30s for its own refresh.
  const [listRevision, setListRevision] = useState(0)
  // A successful DELETE is authoritative before the next Session-index read completes. Keep that
  // stale rail row as a disabled "Deleting..." tombstone instead of briefly presenting it as usable.
  const [deletingSessionKeys, setDeletingSessionKeys] = useState<Set<string>>(() => new Set())
  // Machines answering is only the first half of starting up; the Session list is the half the user
  // is actually waiting for. See the startup states below.
  const [sessionsDiscovered, setSessionsDiscovered] = useState(machines.length === 0)
  const [railWidth, setRailWidth] = useState<number | null>(loadRailWidth)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const refreshGeneration = useRef(0)

  useEffect(() => {
    if (railWidth === null) return
    try { localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, String(railWidth)) } catch { /* private mode keeps the session's width */ }
  }, [railWidth])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const resizeRail = useCallback((next: number) => {
    setRailWidth(clampRailWidth(next))
  }, [])

  const startRailDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const origin = event.currentTarget.parentElement?.getBoundingClientRect().left ?? 0
    const onMove = (move: globalThis.PointerEvent) => resizeRail(move.clientX - origin)
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      document.body.style.removeProperty("cursor")
      document.body.style.removeProperty("user-select")
    }
    // Without these the drag selects the transcript text it passes over, and the cursor flickers
    // back to the default every time the pointer leaves the 10px handle.
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }, [resizeRail])

  useEffect(() => {
    const generation = ++refreshGeneration.current
    let cancelled = false
    if (machines.length === 0) {
      setRuntimes([])
      setLoaded(true)
      setRefreshing(false)
      return
    }

    setRefreshing(true)
    setRuntimes((current) => reuseList(current, machines.map((machine) => {
      const previous = current.find((runtime) => runtime.machine.id === machine.id)
      return previous ? { ...previous, machine } : { machine, snapshot: null, state: "loading" }
    })))

    void Promise.all(machines.map(async (machine): Promise<NativeMachineRuntime> => {
      try {
        const snapshot = await discoverMachineWithRetry(machine.config)
        if (snapshot) migrateNativeSessionMachineStorage(machine.id, snapshot.machine.id)
        return snapshot
          ? { machine, snapshot, state: "online", consecutiveFailures: 0 }
          : { machine, snapshot: null, state: "offline", error: "This endpoint is not a Harness machine daemon.", consecutiveFailures: MACHINE_OFFLINE_FAILURE_THRESHOLD }
      } catch (reason) {
        const error = reason instanceof Error ? reason.message : String(reason)
        const previous = runtimesRef.current.find((runtime) => runtime.machine.id === machine.id)
        const sameEndpoint = previous?.machine.config.host === machine.config.host
          && previous?.machine.config.port === machine.config.port
          && previous?.machine.config.username === machine.config.username
        const consecutiveFailures = (previous?.consecutiveFailures || 0) + 1
        if (sameEndpoint && previous?.snapshot && consecutiveFailures < MACHINE_OFFLINE_FAILURE_THRESHOLD) {
          return {
            ...previous,
            machine,
            state: "online",
            error,
            consecutiveFailures
          }
        }
        return {
          machine,
          snapshot: null,
          state: "offline",
          error,
          consecutiveFailures
        }
      }
    })).then((next) => {
      if (!cancelled && refreshGeneration.current === generation) {
        setRuntimes((current) => reuseList(current, next))
      }
    }).finally(() => {
      if (!cancelled && refreshGeneration.current === generation) {
        setLoaded(true)
        setRefreshing(false)
      }
    })
    return () => { cancelled = true }
  }, [machines, revision])

  const reconnectingCount = runtimes.filter((runtime) =>
    runtime.state === "online" && Boolean(runtime.snapshot) && Boolean(runtime.error)
  ).length

  // Endpoint identity, not array identity: the parent rebuilds the machine list on every persist,
  // and re-subscribing on each render would tear down healthy streams.
  const streamEndpoints = machines
    .map((machine) => [machine.id, machine.config.host, machine.config.port, machine.config.username, machine.config.password].join("\u0000"))
    .join("\u0001")
  const streamTargets = useMemo(
    () => machines.map((machine) => ({ id: machine.id, config: machine.config })),
    // Deliberately keyed by the endpoint signature above, not by the array identity.
    [streamEndpoints]
  )

  useEffect(() => {
    if (streamTargets.length === 0) {
      setLiveMachines({})
      setReconnectingStreams({})
      return
    }
    const limiter = createBurstLimiter(MACHINE_LIVE_REFRESH_BURST_MS)
    const refresh = () => setRevision((value) => value + 1)
    const subscriptions = streamTargets.map(({ id, config }) => subscribeTaskDeskLiveEvents({
      config,
      onEvent: () => limiter.request(refresh),
      onStatus: (status) => {
        const connected = status.type === "connected"
        const reconnecting = isStreamReconnecting(status.type)
        setLiveMachines((current) => current[id] === connected ? current : { ...current, [id]: connected })
        setReconnectingStreams((current) => current[id] === reconnecting ? current : { ...current, [id]: reconnecting })
        // A stream that just came back was silent for however long it was down, so the snapshot it
        // would otherwise wait for the timer to fetch is already stale.
        if (connected) limiter.request(refresh)
      }
    }))
    return () => {
      limiter.cancel()
      for (const subscription of subscriptions) subscription.close()
    }
  }, [streamTargets])

  const reconnectingStreamCount = streamTargets.filter(({ id }) => reconnectingStreams[id]).length

  useEffect(() => {
    if (!loaded) return
    const interval = machinePollIntervalMs({
      reconnecting: reconnectingCount > 0 || reconnectingStreamCount > 0,
      machineCount: streamTargets.length,
      connectedStreamCount: streamTargets.filter(({ id }) => liveMachines[id]).length
    })
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setRevision((value) => value + 1)
    }, interval)
    const onVisibility = () => {
      if (document.visibilityState === "visible") setRevision((value) => value + 1)
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [loaded, reconnectingCount, reconnectingStreamCount, streamTargets, liveMachines])

  const onlineCount = runtimes.filter((runtime) => runtime.state === "online").length
  const loadingCount = runtimes.filter((runtime) => runtime.state === "loading").length
  const offlineCount = runtimes.filter((runtime) => runtime.state === "offline").length
  const selectedRuntime = selected
    ? runtimes.find((runtime) => runtime.snapshot?.machine.id === selected.machineID || runtime.machine.id === selected.machineID)
    : undefined
  const selectedMachine = selectedRuntime?.machine
  const selectedInteractionEnabled = Boolean(
    selectedRuntime?.state === "online"
    && selectedRuntime.snapshot
    && !selectedRuntime.error
    && sessionsDiscovered
  )
  const lastConnectionProbeRequest = useRef(0)
  const markSelectedMachineConnectionIssue = useCallback(() => {
    const machineID = selectedRuntime?.machine.id
    if (!machineID) return
    setRuntimes((current) => reuseList(current, current.map((runtime) => {
      if (runtime.machine.id !== machineID || !runtime.snapshot) return runtime
      return {
        ...runtime,
        state: "online",
        error: runtime.error || "Reconnecting to machine…",
        consecutiveFailures: Math.max(1, runtime.consecutiveFailures || 0)
      }
    })))
    const now = Date.now()
    if (now - lastConnectionProbeRequest.current >= MACHINE_RECONNECT_POLL_MS) {
      lastConnectionProbeRequest.current = now
      setRevision((value) => value + 1)
    }
  }, [selectedRuntime?.machine.id])
  const routeMachines = useMemo<NativeSessionRouteMachine[]>(() => {
    const byMachineID = new Map<string, NativeSessionRouteMachine>()
    for (const runtime of runtimes) {
      if (runtime.state !== "online" || !runtime.snapshot) continue
      const machineID = runtime.snapshot.machine.id
      if (byMachineID.has(machineID)) continue
      byMachineID.set(machineID, {
        machineID,
        label: runtime.machine.name || runtime.snapshot.machine.name || machineID,
        config: runtime.machine.config,
        agents: runtime.snapshot.agents
      })
    }
    return [...byMachineID.values()]
  }, [runtimes])
  const selectedProject = selected ? projectLabel(selected.directory) : undefined
  const selectedTokenCount = selected?.tokens
    ? (selected.tokens.input || 0) + (selected.tokens.output || 0) + (selected.tokens.reasoning || 0)
    : 0
  const selectedHasChanges = Boolean(selected?.summary && (
    selected.summary.files || selected.summary.additions || selected.summary.deletions
  ))
  const selectedTransferredContext = useMemo(() => {
    if (!selected) return ""
    const inMemory = selected.history?.length ? nativeSessionTransferredContext(selected) : ""
    if (inMemory) return inMemory
    return (Array.isArray(selectedLinks) ? selectedLinks : []).find((link) =>
      link.target.machineID === selected.machineID
      && link.target.agentID === selected.agentID
      && link.target.sessionID === selected.sessionID
    )?.transferredContext || ""
  }, [selected, selectedLinks])
  const selectedPermissionRules = selected?.permission || []
  const selectedRestrictionCount = selectedPermissionRules.filter((rule) => rule.action === "deny").length
  const selectedPolicyLabel = selectedPermissionRules.length
    ? selectedRestrictionCount === selectedPermissionRules.length
      ? t("sf.restrictionsLabel", { count: selectedRestrictionCount })
      : t("sf.policyRulesLabel", { count: selectedPermissionRules.length })
    : ""

  /**
   * Startup has two halves and the pane must not pretend the second one is over.
   *
   * "machines": still asking the configured machines whether they are there.
   * "sessions": they have answered and their Sessions are being read.
   * "ready": both are done - only now can the pane speak about opening a Session, or about none of
   * the machines being reachable, without contradicting the rail next to it.
   *
   * Only the first pass is a startup: once discovery has settled, the ten-second refresh keeps
   * `loaded` and `sessionsDiscovered` true, so a background cycle never throws the user back to a
   * waiting screen.
   */
  useEffect(() => {
    let cancelled = false
    setLineageError(null)
    if (!selected || !selectedRuntime || !selectedInteractionEnabled) {
      setSelectedLinks([])
      return () => { cancelled = true }
    }
    void api.listNativeSessionLinks(selectedRuntime.machine.config, selected.ref)
      .then(({ links }) => {
        if (!cancelled) setSelectedLinks(Array.isArray(links) ? links : [])
      })
      .catch(() => {
        if (!cancelled) {
          // Lineage is optional enrichment. A transient/read-only failure must never make a brand-new
          // Session look broken or contaminate its writable/model state. Explicit navigation to a
          // known link still reports its own actionable error in openLinkedSession().
          setSelectedLinks([])
        }
      })
    return () => { cancelled = true }
  }, [selected?.key, selectedRuntime?.machine.id, selectedInteractionEnabled, listRevision])

  async function openLinkedSession(ref: NativeSessionRef) {
    setLineageError(null)
    const runtime = runtimes.find((candidate) => candidate.snapshot?.machine.id === ref.machineID)
    const agent = runtime?.snapshot?.agents?.find((candidate) => candidate.id === ref.agentID)
    if (!runtime || !agent) {
      setLineageError("The linked machine or harness is currently offline.")
      return
    }
    try {
      const records = await discoverAgentNativeSessions(runtime.machine.config, agent)
      const record = records.find((candidate) => candidate.session.id === ref.sessionID)
      if (!record) throw new Error("The linked native Session is no longer available.")
      openSession(nativeSessionSurfaceTarget(ref.machineID, runtime.machine.config, record))
    } catch (reason) {
      setLineageError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  function linkedDestination(link: NativeSessionLink): { relation: string; ref: NativeSessionRef } {
    const currentIsTarget =
      link.target.machineID === selected?.machineID
      && link.target.agentID === selected?.agentID
      && link.target.sessionID === selected?.sessionID
    return currentIsTarget
      ? { relation: "Continued from", ref: link.source }
      : { relation: "Continues in", ref: link.target }
  }

  const startupPhase: "machines" | "sessions" | "ready" =
    !loaded || loadingCount > 0 ? "machines" : !sessionsDiscovered ? "sessions" : "ready"

  function openSession(target: NativeSessionSurfaceTarget) {
    setSelectedState(undefined)
    setSelected(target)
    setMobileDetailOpen(true)
  }

  const markSessionDeleting = useCallback((key: string) => {
    setDeletingSessionKeys((current) => {
      if (current.has(key)) return current
      const next = new Set(current)
      next.add(key)
      return next
    })
  }, [])

  const clearSessionDeleting = useCallback((key: string) => {
    setDeletingSessionKeys((current) => {
      if (!current.has(key)) return current
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }, [])

  function handleSessionDeleteStarted(key: string) {
    markSessionDeleting(key)
    // On phones return to the rail immediately, while the real DELETE is still in flight. The row
    // remains present, disabled and visibly deleting; desktop keeps the same selected Session behind
    // the modal. No machine refresh is involved in this transition.
    if (selected?.key === key) setMobileDetailOpen(false)
  }

  function handleSessionDeleteFailed(key: string) {
    clearSessionDeleting(key)
    // Restore the detail so the action panel can show the server error instead of leaving mobile on
    // the Session list with a deletion that never happened.
    if (selected?.key === key) setMobileDetailOpen(true)
  }

  function handleSessionDeleted(key: string) {
    // Session discovery is the only data that changed. Refreshing the whole machine here used to
    // light the global top-right spinner and could leave it spinning behind a perfectly valid DELETE.
    setListRevision((value) => value + 1)
    if (selected?.key !== key) return
    setSelected(null)
    setSelectedState(undefined)
    setMobileDetailOpen(false)
  }

  const handleSessionDeletionSettled = clearSessionDeleting

  function handleSessionRenamed(session: Session, title: string) {
    const nextTitle = session.title?.trim() || title
    setSelected((current) => current ? { ...current, title: nextTitle } : current)
    setListRevision((value) => value + 1)
  }

  const paletteCommands = useMemo<PaletteCommand[]>(() => [
    {
      id: "machines",
      group: "Workspace",
      label: t("sf.machines"),
      keywords: "server machine hosts",
      run: onManageMachines
    },
    {
      id: "settings",
      group: "Workspace",
      label: t("nav.settings"),
      keywords: "preferences appearance language",
      run: onManageSettings
    },
    {
      id: "refresh",
      group: "Sessions",
      label: t("sf.refresh"),
      keywords: "reload refresh sessions",
      run: () => setRevision((value) => value + 1)
    },
    ...(selected ? [{
      id: "back-to-sessions",
      group: "Sessions",
      label: t("sf.backToSessions"),
      keywords: "close current session list",
      run: () => setMobileDetailOpen(false)
    }] : [])
  ], [onManageMachines, onManageSettings, selected, t])

  return (
    <section className="tdw-shell hr-control-plane hr-native-workspace" aria-label={t("nav.sessions")}>
      <header className="tdw-topbar hr-topbar">
        <div className="tdw-brand hr-brand"><img className="tdw-logo hr-logo hr-app-icon" src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" width={32} height={32} /><div><strong>Harness Remote</strong><small>{t("sf.brandTagline")}</small></div></div>
        <div className="tdw-context-path" aria-label={t("sf.workspaceContext")}>
          <span>{selectedMachine?.name || t("sf.allMachines")}</span><b>/</b>
          <strong>{selectedProject || t("sf.nativeSessions")}</strong>
          {selected ? <><b>/</b><em>{selected.title}</em></> : null}
        </div>
        <div className="tdw-top-actions">
          <span className="tdw-machine-health">
            <i className={startupPhase !== "ready" || reconnectingCount > 0 ? "loading" : onlineCount > 0 ? "online" : "offline"} />
            {startupPhase === "machines"
              ? t("sf.connecting")
              : startupPhase === "sessions"
                ? t("sf.loadingSessions")
                : reconnectingCount > 0
                  ? t("sf.connecting")
                  : t("sf.machineCount", { online: onlineCount, total: machines.length })}
          </span>
          <button type="button" className="tdw-button secondary tdw-machines-button" onClick={onManageMachines}><ServerIcon size={15} /> {t("sf.machines")}</button>
          <button type="button" className="palette-hint" onClick={() => setPaletteOpen(true)} title="Command palette"><span>⌘K</span></button>
          <button type="button" className="tdw-icon-button" onClick={onManageSettings} title={t("nav.settings")} aria-label={t("nav.settings")}><SettingsIcon size={16} /></button>
          <button type="button" className="tdw-icon-button hr-refresh-button" onClick={() => setRevision((value) => value + 1)} title={t("sf.refresh")} aria-label={refreshing ? t("sf.refreshingMachines") : t("sf.refresh")} aria-busy={refreshing} disabled={refreshing}>
            {refreshing ? <LoadingIcon size={16} /> : <RefreshIcon size={16} />}
          </button>
        </div>
      </header>
      <div
        className="hr-native-workspace-body"
        style={railWidth === null ? undefined : { ["--hrsf-rail-width" as string]: `${railWidth}px` }}
      >
        <aside className="hr-native-workspace-list">
          <NativeSessionHome
            sources={runtimes}
            onOpen={openSession}
            refreshToken={listRevision}
            onAttentionCountChange={onAttentionCountChange}
            onDiscoveredChange={setSessionsDiscovered}
            selectedKey={selected?.key}
            selectedState={selectedState}
            deletingKeys={deletingSessionKeys}
            onDeletionSettled={handleSessionDeletionSettled}
          />
        </aside>
        {/* Ported from the 2.x shell, which persisted its sidebar width while this one did not, and
            made operable without a pointer: a drag-only divider is unreachable by keyboard. */}
        <div
          className="hr-rail-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("sf.resizeRail")}
          aria-valuenow={railWidth ?? undefined}
          aria-valuemin={RAIL_WIDTH_MIN}
          aria-valuemax={RAIL_WIDTH_MAX}
          tabIndex={0}
          onPointerDown={startRailDrag}
          onDoubleClick={() => {
            setRailWidth(null)
            try { localStorage.removeItem(RAIL_WIDTH_STORAGE_KEY) } catch { /* nothing to clear */ }
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
            event.preventDefault()
            const current = railWidth ?? (event.currentTarget.parentElement?.querySelector(".hr-native-workspace-list")?.getBoundingClientRect().width ?? RAIL_WIDTH_MIN)
            resizeRail(current + (event.key === "ArrowRight" ? RAIL_WIDTH_STEP : -RAIL_WIDTH_STEP))
          }}
        />
        <main className={`hr-native-workspace-detail${mobileDetailOpen ? " mobile-open" : ""}`}>
          {selected ? (
            <>
              <button type="button" className="tdw-mobile-back" onClick={() => setMobileDetailOpen(false)} aria-label={t("sf.backToSessions")}>← {t("nav.sessions")}</button>
              <header className="hr-native-workspace-session-header">
                <div className="hr-native-session-heading">
                  <div className="hr-native-session-eyebrow">
                    <span>{selected.agentLabel}</span>
                    {selected.nativeAgent ? <><i aria-hidden="true">/</i><span>{selected.nativeAgent}</span></> : null}
                    <i aria-hidden="true">/</i>
                    <span>{selectedMachine?.name || "Machine"}</span>
                    <i aria-hidden="true">/</i>
                    <strong>{selectedProject}</strong>
                  </div>
                  <NativeSessionTitle target={selected} onRenamed={handleSessionRenamed} />
                  <small title={selected.directory}>
                    {selected.external ? t("sf.startedInHarness") : t("sf.createdInHarnessRemote")}
                    {selected.directory ? ` · ${selected.directory}` : ""}
                  </small>
                </div>
                <div className="hr-native-workspace-session-actions">
                  {selected.nativeAgent || selectedPolicyLabel || selectedTokenCount || selectedHasChanges || Number(selected.cost) > 0 ? (
                    <div className="hr-native-session-stats" aria-label={t("sf.sessionStatistics")}>
                      {selected.nativeAgent ? <span title={t("sf.nativeAgentMode")}>{t("sf.agentLabel", { name: selected.nativeAgent })}</span> : null}
                      {selectedPolicyLabel ? <span title={t("sf.policySummary")}>{selectedPolicyLabel}</span> : null}
                      {selectedTokenCount ? <span title={t("sf.cumulativeTokens")}>{t("sf.tokensLabel", { count: compactNumber(selectedTokenCount) })}</span> : null}
                      {selectedHasChanges ? (
                        <span title={t("sf.changedFiles", { count: selected.summary?.files || 0 })}>
                          <b>+{selected.summary?.additions || 0}</b>
                          <i>−{selected.summary?.deletions || 0}</i>
                          <em>{t("sf.filesLabel", { count: selected.summary?.files || 0 })}</em>
                        </span>
                      ) : null}
                      {Number(selected.cost) > 0 ? <span title={t("sf.reportedCost")}>${Number(selected.cost).toFixed(2)}</span> : null}
                    </div>
                  ) : null}
                  <NativeSessionActions
                    target={selected}
                    onDeleteStarted={handleSessionDeleteStarted}
                    onDeleteFailed={handleSessionDeleteFailed}
                    onDeleted={handleSessionDeleted}
                  />
                  <code title={selected.sessionID}>{selected.sessionID}</code>
                </div>
              </header>
              {selectedLinks.length || selectedTransferredContext || lineageError ? (
                <section className="hr-session-lineage" aria-label="Linked Session history">
                  {selectedLinks.length ? (
                    <div className="hr-session-lineage-links">
                      {selectedLinks.map((link) => {
                        const destination = linkedDestination(link)
                        const machine = routeMachines.find((candidate) => candidate.machineID === destination.ref.machineID)
                        const agent = machine?.agents?.find((candidate) => candidate.id === destination.ref.agentID)
                        return (
                          <button
                            type="button"
                            className="hr-session-lineage-link"
                            key={`${link.source.machineID}:${link.source.agentID}:${link.source.sessionID}->${link.target.machineID}:${link.target.agentID}:${link.target.sessionID}`}
                            onClick={() => void openLinkedSession(destination.ref)}
                          >
                            <span>{destination.relation}</span>
                            <strong>{machine?.label || destination.ref.machineID} <i aria-hidden="true">/</i> {agent?.label || destination.ref.agentID}</strong>
                            <small>{destination.relation === "Continued from" ? "Open previous Session" : "Open next Session"} →</small>
                          </button>
                        )
                      })}
                    </div>
                  ) : null}
                  {selectedTransferredContext ? (
                    <details className="hr-session-transfer-context">
                      <summary>Transferred context <span>exactly what the new harness received</span></summary>
                      <pre>{selectedTransferredContext}</pre>
                    </details>
                  ) : null}
                  {lineageError ? <div className="hr-session-lineage-error" role="alert">{lineageError}</div> : null}
                </section>
              ) : null}
              <div className="hr-native-workspace-chat">
                <NativeSessionObserver
                  key={selected.key}
                  target={selected}
                  routes={routeMachines}
                  interactionEnabled={selectedInteractionEnabled}
                  onConnectionIssue={markSelectedMachineConnectionIssue}
                  onOpenSession={openSession}
                  onSessionRefresh={() => setListRevision((value) => value + 1)}
                  onStateChange={setSelectedState}
                />
              </div>
            </>
          ) : machines.length === 0 ? (
            <div className="hr-native-workspace-empty hr-native-startup">
              <ServerIcon size={28} />
              <span>Harness Remote 3.0</span>
              <strong>{t("sf.addFirstMachine")}</strong>
              <p>{t("sf.addFirstMachineBody")}</p>
              <button type="button" className="tdw-button primary" onClick={onManageMachines}><ServerIcon size={15} /> {t("sf.addMachine")}</button>
            </div>
          ) : startupPhase !== "ready" ? (
            /* One waiting state that names which half of startup is still running, held until both
               halves are done. It used to end as soon as the machines answered, so the pane invited
               the user to open a Session while the rail beside it was still empty and, for a moment,
               still showing the machine that had failed - which reads as a failed startup rather
               than one in progress. */
            <div className="hr-native-workspace-empty hr-native-startup connecting" role="status" aria-live="polite">
              <LoadingIcon size={28} />
              <span>{t("sf.preparing")}</span>
              <strong>{startupPhase === "machines" ? t("sf.connectingMachines") : t("sf.loadingSessions")}</strong>
              <p>{startupPhase === "machines" ? t("sf.connectingBody") : t("sf.loadingSessionsBody")}</p>
              <small>{startupPhase === "machines"
                ? t("sf.configuredMachines", { count: machines.length })
                : t("sf.onlineCount", { count: onlineCount })}</small>
            </div>
          ) : onlineCount === 0 ? (
            <div className="hr-native-workspace-empty hr-native-startup offline">
              <ServerIcon size={28} />
              <span>{t("sf.machinesUnavailable")}</span>
              <strong>{t("sf.couldNotConnect")}</strong>
              <p>{t("sf.offlineBody", { count: offlineCount })}</p>
              <div><button type="button" className="tdw-button secondary" onClick={onManageMachines}>{t("sf.manageMachines")}</button><button type="button" className="tdw-button primary" onClick={() => setRevision((value) => value + 1)}>{t("sf.retry")}</button></div>
            </div>
          ) : (
            <div className="hr-native-workspace-empty hr-native-startup ready">
              <ChatIcon size={28} />
              <span>Harness Remote 3.0</span>
              <strong>{t("sf.openNativeSession")}</strong>
              <p>{t("sf.openNativeSessionBody")}</p>
              <div className="hr-native-startup-facts"><span>{t("sf.onlineCount", { count: onlineCount })}</span>{offlineCount ? <span>{t("sf.offlineCount", { count: offlineCount })}</span> : null}<span>{t("sf.nativeSessionTruth")}</span></div>
            </div>
          )}
        </main>
      </div>
      {paletteOpen ? (
        <CommandPalette
          commands={paletteCommands}
          placeholder="Type a command…"
          emptyLabel="No matching commands"
          navigateHint="navigate"
          runHint="run"
          closeHint="close"
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}
    </section>
  )
}

export function StandaloneUniversalWorkspace({ machines, onPersistMachines }: Props) {
  const t = useTranslator()
  // With the chat full-screen on a phone the rail is invisible, so a Session asking for input had
  // no way of saying so. The counts already existed per machine and per project; only the badge
  // that carries them out of the rail was missing.
  const [attentionCount, setAttentionCount] = useState(0)
  const [managerOpen, setManagerOpen] = useState(machines.length === 0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const mobileSection = managerOpen ? "machines" : settingsOpen ? "settings" : "sessions"

  useEffect(() => {
    if (Capacitor.getPlatform() !== "android") return
    let disposed = false
    let handle: { remove: () => Promise<void> } | undefined
    void CapacitorApp.addListener("backButton", () => {
      const palette = document.querySelector<HTMLElement>(".palette-backdrop")
      if (palette) {
        palette.click()
        return
      }
      if (settingsOpen) {
        setSettingsOpen(false)
        return
      }
      if (managerOpen) {
        setManagerOpen(false)
        return
      }

      const modelPickerTrigger = document.querySelector<HTMLButtonElement>(".tdw-model-picker.open .tdw-model-trigger")
      if (modelPickerTrigger) {
        modelPickerTrigger.click()
        return
      }

      const modalClose = document.querySelector<HTMLButtonElement>(".tdw-modal-backdrop .tdw-modal header button")
      if (modalClose) {
        modalClose.click()
        return
      }

      const sessionActionDismiss = document.querySelector<HTMLButtonElement>(".hr-session-action-panel button[data-dismiss=\"session-actions\"]")
      if (sessionActionDismiss) {
        sessionActionDismiss.click()
        return
      }

      const mobileBack = document.querySelector<HTMLButtonElement>(".tdw-mobile-back")
      if (mobileBack && mobileBack.getClientRects().length > 0) {
        mobileBack.click()
        return
      }

      void CapacitorApp.exitApp()
    }).then((listener) => {
      if (disposed) void listener.remove()
      else handle = listener
    })
    return () => {
      disposed = true
      if (handle) void handle.remove()
    }
  }, [managerOpen, settingsOpen])

  function showSessions() {
    setManagerOpen(false)
    setSettingsOpen(false)
  }

  function showMachines() {
    setSettingsOpen(false)
    setManagerOpen(true)
  }

  function showSettings() {
    setManagerOpen(false)
    setSettingsOpen(true)
  }

  return (
    <div className="uw-standalone-host">
      <NativeSessionsWorkspace machines={machines} onManageMachines={showMachines} onManageSettings={showSettings} onAttentionCountChange={setAttentionCount} />
      {managerOpen ? <MachineManager machines={machines} onClose={() => setManagerOpen(false)} onPersist={onPersistMachines} /> : null}
      {settingsOpen ? <MobileSettingsPage onClose={() => setSettingsOpen(false)} /> : null}
      <nav className="hr-mobile-nav" aria-label={t("sf.mainNavigation")}>
        <button type="button" className={mobileSection === "sessions" ? "active" : ""} onClick={showSessions} aria-current={mobileSection === "sessions" ? "page" : undefined}><ChatIcon size={20} /><span>{t("nav.sessions")}</span>{attentionCount ? <b className="hr-mobile-nav-badge" aria-label={t("sf.attentionCount", { count: attentionCount })}>{attentionCount > 9 ? "9+" : attentionCount}</b> : null}</button>
        <button type="button" className={mobileSection === "machines" ? "active" : ""} onClick={showMachines} aria-current={mobileSection === "machines" ? "page" : undefined}><ServerIcon size={20} /><span>{t("sf.machines")}</span></button>
        <button type="button" className={mobileSection === "settings" ? "active" : ""} onClick={showSettings} aria-current={mobileSection === "settings" ? "page" : undefined}><SettingsIcon size={20} /><span>{t("nav.settings")}</span></button>
      </nav>
    </div>
  )
}
