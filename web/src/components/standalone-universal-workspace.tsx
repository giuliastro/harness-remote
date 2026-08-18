import { useMemo, useState, type ReactNode } from "react"
import { discoverMachine } from "../machineClient"
import {
  createWorkspaceMachine,
  type WorkspaceMachine
} from "../workspaceMachines"
import { UniversalWorkspace } from "./universal-workspace"

type Props = {
  machines: WorkspaceMachine[]
  onPersistMachines: (machines: WorkspaceMachine[]) => void
  legacyView: ReactNode
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
        setTestResult({
          ok: true,
          text: `Connected to ${snapshot.machine.name}. ${count} harness${count === 1 ? "" : "es"} discovered.`
        })
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
        <label>
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="My workstation" />
        </label>
        <label>
          <span>Host</span>
          <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="192.168.1.20 or localhost" spellCheck={false} />
        </label>
        <label>
          <span>Port</span>
          <input value={port} onChange={(event) => setPort(event.target.value.replace(/\D/g, ""))} inputMode="numeric" />
        </label>
        <label>
          <span>Username</span>
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
        </label>
        <label className="uw-machine-editor-wide">
          <span>Password</span>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
        </label>
      </div>

      {testResult ? (
        <div className={`uw-machine-test-result ${testResult.ok ? "ok" : "error"}`}>{testResult.text}</div>
      ) : null}

      <div className="uw-machine-editor-actions">
        <button type="button" className="uw-manager-button" onClick={onCancel}>Cancel</button>
        <button type="button" className="uw-manager-button" disabled={!valid || testing} onClick={() => void testConnection()}>
          {testing ? "Testing..." : "Test connection"}
        </button>
        <button type="button" className="uw-manager-button primary" disabled={!valid} onClick={() => valid && onSave(nextMachine())}>
          {isNew ? "Add machine" : "Save machine"}
        </button>
      </div>
    </div>
  )
}

function MachineManager({
  machines,
  onClose,
  onPersist
}: {
  machines: WorkspaceMachine[]
  onClose: () => void
  onPersist: (machines: WorkspaceMachine[]) => void
}) {
  const [editingID, setEditingID] = useState<string | null>(machines.length === 0 ? "new" : null)
  const draft = useMemo(() => editingID === "new"
    ? createWorkspaceMachine()
    : machines.find((machine) => machine.id === editingID) || null, [editingID, machines])

  const save = (machine: WorkspaceMachine) => {
    if (editingID === "new") onPersist([...machines, machine])
    else onPersist(machines.map((candidate) => candidate.id === machine.id ? machine : candidate))
    setEditingID(null)
  }

  const remove = (machine: WorkspaceMachine) => {
    if (!window.confirm(`Remove "${machine.name}" from this workspace?`)) return
    onPersist(machines.filter((candidate) => candidate.id !== machine.id))
    if (editingID === machine.id) setEditingID(null)
  }

  return (
    <div className="uw-manager-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="uw-machine-manager" role="dialog" aria-modal="true" aria-label="Machines" onMouseDown={(event) => event.stopPropagation()}>
        <header className="uw-machine-manager-header">
          <div>
            <h2>Machines</h2>
            <p>Configure the machine daemons aggregated by Universal Workspace. Classic connections are separate.</p>
          </div>
          <button type="button" className="uw-manager-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="uw-machine-manager-body">
          {machines.length === 0 && editingID !== "new" ? (
            <div className="uw-machine-manager-empty">
              <strong>No machines configured</strong>
              <span>Add a Harness machine daemon to start aggregating native sessions.</span>
            </div>
          ) : null}

          {machines.map((machine) => (
            <div className="uw-machine-config-card" key={machine.id}>
              <div className="uw-machine-config-main">
                <strong>{machine.name}</strong>
                <span>{machine.config.host}:{machine.config.port}</span>
                <small>{machine.config.username || "No username"}</small>
              </div>
              <div className="uw-machine-config-actions">
                <button type="button" className="uw-manager-button" onClick={() => setEditingID(machine.id)}>Edit</button>
                <button type="button" className="uw-manager-button danger" onClick={() => remove(machine)}>Remove</button>
              </div>
            </div>
          ))}

          {draft ? (
            <MachineEditor
              key={draft.id}
              machine={draft}
              isNew={editingID === "new"}
              onCancel={() => setEditingID(null)}
              onSave={save}
            />
          ) : null}
        </div>

        <footer className="uw-machine-manager-footer">
          <span>{machines.length} machine{machines.length === 1 ? "" : "s"} configured</span>
          <button type="button" className="uw-manager-button primary" onClick={() => setEditingID("new")}>+ Add machine</button>
        </footer>
      </section>
    </div>
  )
}

export function StandaloneUniversalWorkspace({ machines, onPersistMachines, legacyView }: Props) {
  const [managerOpen, setManagerOpen] = useState(machines.length === 0)
  const [activeMachineID, setActiveMachineID] = useState(machines[0]?.id || "")

  const activeID = machines.some((machine) => machine.id === activeMachineID)
    ? activeMachineID
    : machines[0]?.id || ""

  return (
    <div className="uw-standalone-host">
      <UniversalWorkspace
        profiles={machines}
        activeProfileID={activeID}
        onPersistProfiles={(nextMachines, nextActiveID) => {
          onPersistMachines(nextMachines as WorkspaceMachine[])
          setActiveMachineID(nextActiveID)
        }}
        legacyView={legacyView}
      />

      <button type="button" className="uw-machine-manager-trigger" onClick={() => setManagerOpen(true)} title="Manage machines">
        Machines
        <span>{machines.length}</span>
      </button>

      {managerOpen ? (
        <MachineManager
          machines={machines}
          onClose={() => setManagerOpen(false)}
          onPersist={(nextMachines) => {
            onPersistMachines(nextMachines)
            if (!nextMachines.some((machine) => machine.id === activeID)) setActiveMachineID(nextMachines[0]?.id || "")
          }}
        />
      ) : null}
    </div>
  )
}
