import { useEffect, useMemo, useState } from "react"
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
import { ChatIcon, ServerIcon, SettingsIcon } from "../Icons"
import { createTranslator, languageOptions, type LanguageCode } from "../i18n"
import { discoverMachine } from "../machineClient"
import type { MachineSnapshot } from "../types"
import {
  createWorkspaceMachine,
  type WorkspaceMachine
} from "../workspaceMachines"
import { ConversationWorkspace } from "./conversation-workspace"

type Props = {
  machines: WorkspaceMachine[]
  onPersistMachines: (machines: WorkspaceMachine[]) => void
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
        <label><span>Host</span><input value={host} onChange={(event) => setHost(event.target.value)} placeholder="192.168.1.20 or localhost" spellCheck={false} /></label>
        <label><span>Port</span><input value={port} onChange={(event) => setPort(event.target.value.replace(/\D/g, ""))} inputMode="numeric" /></label>
        <label><span>Username</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label>
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
  const [snapshots, setSnapshots] = useState<Record<string, MachineSnapshot | null | undefined>>({})
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

  const save = (machine: WorkspaceMachine) => {
    if (editingID === "new") onPersist([...machines, machine])
    else onPersist(machines.map((candidate) => candidate.id === machine.id ? machine : candidate))
    setEditingID(null)
  }

  const remove = (machine: WorkspaceMachine) => {
    if (!window.confirm(`Remove "${machine.name}" from Harness Remote?`)) return
    onPersist(machines.filter((candidate) => candidate.id !== machine.id))
    if (editingID === machine.id) setEditingID(null)
  }

  const availableCount = Object.values(snapshots).reduce((count, snapshot) => count + (snapshot?.agents.filter((agent) => agent.state === "available").length || 0), 0)

  return (
    <div className="uw-manager-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="uw-machine-manager" role="dialog" aria-modal="true" aria-label="Machines" onMouseDown={(event) => event.stopPropagation()}>
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
                  {snapshot?.agents.length ? <div className="uw-machine-harness-list">{snapshot.agents.map((agent) => <span className="uw-machine-harness" key={agent.id}><i className={agent.state} /><strong>{agent.label}</strong><small>{agent.state}{agent.processID ? ` · PID ${agent.processID}` : ""}</small></span>)}</div> : null}
                </div>
                <div className="uw-machine-config-actions"><button type="button" className="uw-manager-button" onClick={() => setEditingID(machine.id)}>Edit</button><button type="button" className="uw-manager-button danger" onClick={() => remove(machine)}>Remove</button></div>
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
    <section className="hr-mobile-settings-page" aria-label={t("nav.settings")}>
      <header>
        <div><span>Harness Remote</span><h2>{t("nav.settings")}</h2></div>
        <button type="button" onClick={onClose} aria-label={t("action.close")}>×</button>
      </header>
      <div className="hr-mobile-settings-body">
        <div className="hr-mobile-settings-group">
          <span>Appearance</span>
          <label><strong>{t("settings.theme")}</strong><select value={theme} onChange={(event) => changeTheme(event.target.value)}><option value="system">{t("settings.themeSystem")}</option><option value="light">{t("settings.themeLight")}</option><option value="dark">{t("settings.themeDark")}</option></select></label>
          <label><strong>{t("settings.language")}</strong><select value={language} onChange={(event) => changeLanguage(event.target.value)}>{languageOptions.map((option) => <option value={option.code} key={option.code}>{option.label}</option>)}</select></label>
        </div>
        <p>Appearance and language are shared across Harness Remote on this device.</p>
      </div>
    </section>
  )
}

export function StandaloneUniversalWorkspace({ machines, onPersistMachines }: Props) {
  const [managerOpen, setManagerOpen] = useState(machines.length === 0)
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false)
  const [activeMachineID, setActiveMachineID] = useState(machines[0]?.id || "")
  const activeID = machines.some((machine) => machine.id === activeMachineID) ? activeMachineID : machines[0]?.id || ""
  const mobileSection = managerOpen ? "machines" : mobileSettingsOpen ? "settings" : "conversations"

  useEffect(() => {
    if (Capacitor.getPlatform() !== "android") return
    let disposed = false
    let handle: { remove: () => Promise<void> } | undefined
    void CapacitorApp.addListener("backButton", () => {
      if (mobileSettingsOpen) {
        setMobileSettingsOpen(false)
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

      const drawerScrim = document.querySelector<HTMLButtonElement>(".tdw-task-drawer-scrim")
      if (drawerScrim && drawerScrim.getClientRects().length > 0) {
        drawerScrim.click()
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
  }, [managerOpen, mobileSettingsOpen])

  function showConversations() {
    setManagerOpen(false)
    setMobileSettingsOpen(false)
  }

  function showMachines() {
    setMobileSettingsOpen(false)
    setManagerOpen(true)
  }

  function showSettings() {
    setManagerOpen(false)
    setMobileSettingsOpen(true)
  }

  return (
    <div className="uw-standalone-host">
      <ConversationWorkspace
        machines={machines}
        activeMachineID={activeID}
        onActiveMachineID={setActiveMachineID}
        onManageMachines={showMachines}
      />
      {managerOpen ? <MachineManager machines={machines} onClose={() => setManagerOpen(false)} onPersist={(nextMachines) => {
        onPersistMachines(nextMachines)
        if (!nextMachines.some((machine) => machine.id === activeID)) setActiveMachineID(nextMachines[0]?.id || "")
      }} /> : null}
      {mobileSettingsOpen ? <MobileSettingsPage onClose={() => setMobileSettingsOpen(false)} /> : null}
      <nav className="hr-mobile-nav" aria-label="Main navigation">
        <button type="button" className={mobileSection === "conversations" ? "active" : ""} onClick={showConversations} aria-current={mobileSection === "conversations" ? "page" : undefined}><ChatIcon size={20} /><span>Conversations</span></button>
        <button type="button" className={mobileSection === "machines" ? "active" : ""} onClick={showMachines} aria-current={mobileSection === "machines" ? "page" : undefined}><ServerIcon size={20} /><span>Machines</span></button>
        <button type="button" className={mobileSection === "settings" ? "active" : ""} onClick={showSettings} aria-current={mobileSection === "settings" ? "page" : undefined}><SettingsIcon size={20} /><span>Settings</span></button>
      </nav>
    </div>
  )
}
