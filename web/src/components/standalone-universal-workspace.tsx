import { useEffect, useMemo, useRef, useState } from "react"
import { App as CapacitorApp } from "@capacitor/app"
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
import { discoverMachine, machineAgentStateLabel } from "../machineClient"
import type { NativeSessionSurfaceTarget } from "../native-session-discovery"
import type { MachineSnapshot, Session } from "../types"
import {
  createWorkspaceMachine,
  type WorkspaceMachine
} from "../workspaceMachines"
import { reuseList } from "../workspace-runtime-merge"
import { useDialogDismiss } from "../useDialogDismiss"
import { NativeSessionActions } from "./native-session-actions"
import { NativeSessionHandoffControl } from "./native-session-handoff-control"
import { NativeSessionHome } from "./native-session-home"
import { NativeSessionObserver, type NativeSessionVisualState } from "./native-session-observer"
import "../taskdesk-workthreads.css"
import "../taskdesk-mobile-navigation.css"
import "../taskdesk-focus-layout.css"
import "../conversation-control-plane.css"

type Props = {
  machines: WorkspaceMachine[]
  onPersistMachines: (machines: WorkspaceMachine[]) => void
}
type NativeMachineRuntime = {
  machine: WorkspaceMachine
  snapshot: MachineSnapshot | null
  state: "loading" | "online" | "offline"
  error?: string
}


type MachineEditorProps = {
  machine: WorkspaceMachine
  isNew: boolean
  onCancel: () => void
  onSave: (machine: WorkspaceMachine) => void
}

function MachineEditor({ machine, isNew, onCancel, onSave }: MachineEditorProps) {
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
        setTestResult({ ok: false, text: "Connected, but this endpoint is not a Harness machine daemon." })
      } else {
        const count = snapshot.agents.length
        setTestResult({ ok: true, text: `Connected to ${snapshot.machine.name}. ${count} coding agent${count === 1 ? "" : "s"} discovered.` })
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
        <label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="My workstation" /></label>
        {/* A phone keyboard capitalises the first letter by default, which silently turned `localhost`
            into `Localhost` and a username into a different username. Neither field is prose. */}
        <label><span>Host</span><input value={host} onChange={(event) => setHost(event.target.value)} placeholder="192.168.1.20 or localhost" spellCheck={false} autoCapitalize="none" autoCorrect="off" /></label>
        <label><span>Port</span><input value={port} onChange={(event) => setPort(event.target.value.replace(/\D/g, ""))} inputMode="numeric" /></label>
        <label><span>Username</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" spellCheck={false} autoCapitalize="none" autoCorrect="off" /></label>
        <label className="uw-machine-editor-wide"><span>Password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
      </div>
      {testResult ? <div className={`uw-machine-test-result ${testResult.ok ? "ok" : "error"}`}>{testResult.text}</div> : null}
      <div className="uw-machine-editor-actions">
        <button type="button" className="uw-manager-button" onClick={onCancel}>Cancel</button>
        <button type="button" className="uw-manager-button" disabled={!valid || testing} onClick={() => void testConnection()}>{testing ? "Testing..." : "Test connection"}</button>
        <button type="button" className="uw-manager-button primary" disabled={!valid} onClick={() => valid && onSave(nextMachine())}>{isNew ? "Add machine" : "Save machine"}</button>
      </div>
    </div>
  )
}

function MachineManager({ machines, onClose, onPersist }: { machines: WorkspaceMachine[]; onClose: () => void; onPersist: (machines: WorkspaceMachine[]) => void }) {
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
      <section className="uw-machine-manager" role="dialog" aria-modal="true" aria-label="Machines" ref={dialogRef} onMouseDown={(event) => event.stopPropagation()}>
        <header className="uw-machine-manager-header">
          <div><h2>Machines</h2><p>Connect the computers where your repositories, coding agents, credentials and model access already live.</p></div>
          <button type="button" className="uw-manager-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="uw-machine-manager-body">
          {machines.length === 0 && editingID !== "new" ? <div className="uw-machine-manager-empty"><strong>No machines configured</strong><span>Add a Harness Remote daemon to discover its projects and coding agents.</span></div> : null}
          {machines.map((machine) => {
            const snapshot = snapshots[machine.id]
            return (
              <div className="uw-machine-config-card" key={machine.id}>
                <div className="uw-machine-config-main">
                  <strong>{snapshot?.machine.name || machine.name}</strong>
                  <span>{machine.config.host}:{machine.config.port}</span>
                  <small>{snapshot === undefined ? "Checking coding agents..." : snapshot ? `${snapshot.agents.length} coding agent${snapshot.agents.length === 1 ? "" : "s"} detected` : "Machine unavailable"}</small>
                  {snapshot?.agents.length ? <div className="uw-machine-harness-list">{snapshot.agents.map((agent) => <span className="uw-machine-harness" key={agent.id}><i className={agent.state} aria-hidden="true" /><strong>{agent.label}</strong><small>{machineAgentStateLabel(agent.state)}{agent.processID ? ` · PID ${agent.processID}` : ""}</small></span>)}</div> : null}
                </div>
                <div className="uw-machine-config-actions">
                  {confirmRemoveID === machine.id ? (
                    <>
                      <span className="uw-machine-confirm" role="alert">Remove {machine.name}?</span>
                      <button type="button" className="uw-manager-button" onClick={() => setConfirmRemoveID(null)}>Keep</button>
                      <button type="button" className="uw-manager-button danger" data-autofocus onClick={() => remove(machine)}>Remove</button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="uw-manager-button" onClick={() => setEditingID(machine.id)}>Edit</button>
                      <button type="button" className="uw-manager-button danger" onClick={() => setConfirmRemoveID(machine.id)}>Remove</button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
          {draft ? <MachineEditor key={draft.id} machine={draft} isNew={editingID === "new"} onCancel={() => setEditingID(null)} onSave={save} /> : null}
        </div>
        <footer className="uw-machine-manager-footer"><span>{machines.length} machine{machines.length === 1 ? "" : "s"} configured · {availableCount} coding agent{availableCount === 1 ? "" : "s"} running</span><button type="button" className="uw-manager-button primary" onClick={() => setEditingID("new")}>+ Add machine</button></footer>
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
            <span>Interface</span>
            <label><strong>{t("settings.theme")}</strong><select value={theme} onChange={(event) => changeTheme(event.target.value)}><option value="system">{t("settings.themeSystem")}</option><option value="light">{t("settings.themeLight")}</option><option value="dark">{t("settings.themeDark")}</option></select></label>
            <label><strong>{t("settings.language")}</strong><select value={language} onChange={(event) => changeLanguage(event.target.value)}>{languageOptions.map((option) => <option value={option.code} key={option.code}>{option.label}</option>)}</select></label>
          </div>
          <p>Appearance and language are shared across Harness Remote on this device.</p>
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
  onManageSettings
}: {
  machines: WorkspaceMachine[]
  onManageMachines: () => void
  onManageSettings: () => void
}) {
  const [runtimes, setRuntimes] = useState<NativeMachineRuntime[]>(() =>
    machines.map((machine) => ({ machine, snapshot: null, state: "loading" }))
  )
  const [loaded, setLoaded] = useState(machines.length === 0)
  const [refreshing, setRefreshing] = useState(false)
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<NativeSessionSurfaceTarget | null>(null)
  const [selectedState, setSelectedState] = useState<NativeSessionVisualState | undefined>(undefined)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  // A native metadata mutation happens outside the discovery cycle. Machine polling can legitimately
  // return an identical snapshot, so the Session list needs an explicit signal to re-read its
  // Sessions after a rename or delete instead of waiting up to 30s for its own refresh.
  const [listRevision, setListRevision] = useState(0)
  const refreshGeneration = useRef(0)

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
        const snapshot = await discoverMachine(machine.config)
        return snapshot
          ? { machine, snapshot, state: "online" }
          : { machine, snapshot: null, state: "offline", error: "This endpoint is not a Harness machine daemon." }
      } catch (reason) {
        return {
          machine,
          snapshot: null,
          state: "offline",
          error: reason instanceof Error ? reason.message : String(reason)
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

  useEffect(() => {
    if (!loaded) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setRevision((value) => value + 1)
    }, 10_000)
    const onVisibility = () => {
      if (document.visibilityState === "visible") setRevision((value) => value + 1)
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [loaded])

  const onlineCount = runtimes.filter((runtime) => runtime.state === "online").length
  const loadingCount = runtimes.filter((runtime) => runtime.state === "loading").length
  const offlineCount = runtimes.filter((runtime) => runtime.state === "offline").length
  const selectedRuntime = selected ? runtimes.find((runtime) => runtime.machine.id === selected.machineID) : undefined
  const selectedMachine = selectedRuntime?.machine
  const selectedProject = selected ? projectLabel(selected.directory) : undefined
  const selectedTokenCount = selected?.tokens
    ? (selected.tokens.input || 0) + (selected.tokens.output || 0) + (selected.tokens.reasoning || 0)
    : 0
  const selectedHasChanges = Boolean(selected?.summary && (
    selected.summary.files || selected.summary.additions || selected.summary.deletions
  ))
  const selectedPermissionRules = selected?.permission || []
  const selectedRestrictionCount = selectedPermissionRules.filter((rule) => rule.action === "deny").length
  const selectedPolicyLabel = selectedPermissionRules.length
    ? selectedRestrictionCount === selectedPermissionRules.length
      ? `${selectedRestrictionCount} restrictions`
      : `${selectedPermissionRules.length} policy rules`
    : ""

  function openSession(target: NativeSessionSurfaceTarget) {
    setSelectedState(undefined)
    setSelected(target)
    setMobileDetailOpen(true)
  }

  function handleSessionDeleted(key: string) {
    setListRevision((value) => value + 1)
    if (selected?.key !== key) return
    setSelected(null)
    setSelectedState(undefined)
    setMobileDetailOpen(false)
    setRevision((value) => value + 1)
  }

  function handleSessionRenamed(session: Session, title: string) {
    const nextTitle = session.title?.trim() || title
    setSelected((current) => current ? { ...current, title: nextTitle } : current)
    setListRevision((value) => value + 1)
  }

  return (
    <section className="tdw-shell hr-control-plane hr-native-workspace" aria-label="Sessions">
      <header className="tdw-topbar hr-topbar">
        <div className="tdw-brand hr-brand"><img className="tdw-logo hr-logo hr-app-icon" src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" width={32} height={32} /><div><strong>Harness Remote</strong><small>Native coding-agent Sessions, anywhere.</small></div></div>
        <div className="tdw-context-path" aria-label="Current workspace context">
          <span>{selectedMachine?.name || "All machines"}</span><b>/</b>
          <strong>{selectedProject || "Native Sessions"}</strong>
          {selected ? <><b>/</b><em>{selected.title}</em></> : null}
        </div>
        <div className="tdw-top-actions">
          <span className="tdw-machine-health">
            <i className={onlineCount > 0 ? "online" : loadingCount > 0 ? "loading" : "offline"} />
            {loadingCount && !loaded ? "Connecting" : `${onlineCount}/${machines.length} machines`}
          </span>
          <button type="button" className="tdw-button secondary tdw-machines-button" onClick={onManageMachines}><ServerIcon size={15} /> Machines</button>
          <button type="button" className="tdw-icon-button" onClick={onManageSettings} title="Settings" aria-label="Settings"><SettingsIcon size={16} /></button>
          <button type="button" className="tdw-icon-button hr-refresh-button" onClick={() => setRevision((value) => value + 1)} title="Refresh" aria-label={refreshing ? "Refreshing machines" : "Refresh"} aria-busy={refreshing} disabled={refreshing}>
            {refreshing ? <LoadingIcon size={16} /> : <RefreshIcon size={16} />}
          </button>
        </div>
      </header>
      <div className="hr-native-workspace-body">
        <aside className="hr-native-workspace-list">
          <NativeSessionHome sources={runtimes} onOpen={openSession} refreshToken={listRevision} selectedKey={selected?.key} selectedState={selectedState} />
        </aside>
        <main className={`hr-native-workspace-detail${mobileDetailOpen ? " mobile-open" : ""}`}>
          {selected ? (
            <>
              <button type="button" className="tdw-mobile-back" onClick={() => setMobileDetailOpen(false)} aria-label="Back to Sessions">← Sessions</button>
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
                  <h1>{selected.title}</h1>
                  <small title={selected.directory}>
                    {selected.external ? "Started in the native harness" : "Created in Harness Remote"}
                    {selected.directory ? ` · ${selected.directory}` : ""}
                  </small>
                </div>
                <div className="hr-native-workspace-session-actions">
                  {selected.nativeAgent || selectedPolicyLabel || selectedTokenCount || selectedHasChanges || Number(selected.cost) > 0 ? (
                    <div className="hr-native-session-stats" aria-label="Native Session statistics">
                      {selected.nativeAgent ? <span title="Native coding-agent mode">Agent {selected.nativeAgent}</span> : null}
                      {selectedPolicyLabel ? <span title="Native Session policy summary">{selectedPolicyLabel}</span> : null}
                      {selectedTokenCount ? <span title="Cumulative native Session tokens">{compactNumber(selectedTokenCount)} tokens</span> : null}
                      {selectedHasChanges ? (
                        <span title={`${selected.summary?.files || 0} changed files`}>
                          <b>+{selected.summary?.additions || 0}</b>
                          <i>−{selected.summary?.deletions || 0}</i>
                          <em>{selected.summary?.files || 0} files</em>
                        </span>
                      ) : null}
                      {Number(selected.cost) > 0 ? <span title="Reported native Session cost">${Number(selected.cost).toFixed(2)}</span> : null}
                    </div>
                  ) : null}
                  <NativeSessionActions target={selected} onRenamed={handleSessionRenamed} onDeleted={handleSessionDeleted} />
                  <NativeSessionHandoffControl source={selected} agents={selectedRuntime?.snapshot?.agents || []} onOpen={openSession} />
                  <code title={selected.sessionID}>{selected.sessionID}</code>
                </div>
              </header>
              <div className="hr-native-workspace-chat">
                <NativeSessionObserver key={selected.key} target={selected} onStateChange={setSelectedState} />
              </div>
            </>
          ) : machines.length === 0 ? (
            <div className="hr-native-workspace-empty hr-native-startup">
              <ServerIcon size={28} />
              <span>Harness Remote 3.0</span>
              <strong>Add your first machine</strong>
              <p>Connect the computer that runs Codex, Claude, OpenCode, OMP or PI. Its native Sessions will appear here directly.</p>
              <button type="button" className="tdw-button primary" onClick={onManageMachines}><ServerIcon size={15} /> Add machine</button>
            </div>
          ) : !loaded || (onlineCount === 0 && loadingCount > 0) ? (
            <div className="hr-native-workspace-empty hr-native-startup connecting" role="status" aria-live="polite">
              <LoadingIcon size={28} />
              <span>Preparing Harness Remote</span>
              <strong>Connecting to your machines…</strong>
              <p>Discovering Projects, installed coding agents and native Sessions. An ACP harness may need a few seconds to start.</p>
              <small>{machines.length} configured machine{machines.length === 1 ? "" : "s"}</small>
            </div>
          ) : onlineCount === 0 ? (
            <div className="hr-native-workspace-empty hr-native-startup offline">
              <ServerIcon size={28} />
              <span>Machines unavailable</span>
              <strong>Harness Remote could not connect</strong>
              <p>{offlineCount} configured machine{offlineCount === 1 ? " is" : "s are"} offline. Check the daemon, network and saved credentials; the configurations remain saved.</p>
              <div><button type="button" className="tdw-button secondary" onClick={onManageMachines}>Manage machines</button><button type="button" className="tdw-button primary" onClick={() => setRevision((value) => value + 1)}>Retry</button></div>
            </div>
          ) : (
            <div className="hr-native-workspace-empty hr-native-startup ready">
              <ChatIcon size={28} />
              <span>Harness Remote 3.0</span>
              <strong>Open a native Session</strong>
              <p>Select a Session from the left, or start a new one inside a Project. You will continue the same Session owned by its coding agent.</p>
              <div className="hr-native-startup-facts"><span>{onlineCount} online</span>{offlineCount ? <span>{offlineCount} offline</span> : null}<span>Native Session truth</span></div>
            </div>
          )}
        </main>
      </div>
    </section>
  )
}

export function StandaloneUniversalWorkspace({ machines, onPersistMachines }: Props) {
  const [managerOpen, setManagerOpen] = useState(machines.length === 0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const mobileSection = managerOpen ? "machines" : settingsOpen ? "settings" : "sessions"

  useEffect(() => {
    if (Capacitor.getPlatform() !== "android") return
    let disposed = false
    let handle: { remove: () => Promise<void> } | undefined
    void CapacitorApp.addListener("backButton", () => {
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
      <NativeSessionsWorkspace machines={machines} onManageMachines={showMachines} onManageSettings={showSettings} />
      {managerOpen ? <MachineManager machines={machines} onClose={() => setManagerOpen(false)} onPersist={onPersistMachines} /> : null}
      {settingsOpen ? <MobileSettingsPage onClose={() => setSettingsOpen(false)} /> : null}
      <nav className="hr-mobile-nav" aria-label="Main navigation">
        <button type="button" className={mobileSection === "sessions" ? "active" : ""} onClick={showSessions} aria-current={mobileSection === "sessions" ? "page" : undefined}><ChatIcon size={20} /><span>Sessions</span></button>
        <button type="button" className={mobileSection === "machines" ? "active" : ""} onClick={showMachines} aria-current={mobileSection === "machines" ? "page" : undefined}><ServerIcon size={20} /><span>Machines</span></button>
        <button type="button" className={mobileSection === "settings" ? "active" : ""} onClick={showSettings} aria-current={mobileSection === "settings" ? "page" : undefined}><SettingsIcon size={20} /><span>Settings</span></button>
      </nav>
    </div>
  )
}
