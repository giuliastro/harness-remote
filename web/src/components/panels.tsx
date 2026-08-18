import { useEffect, useMemo, useState } from "react"
import {
  ArrowLeftIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  FolderIcon,
  LoadingIcon,
  PlusIcon,
  ServerIcon,
  TestIcon
} from "../Icons"
import { copyToClipboard } from "../clipboard"
import {
  BACKEND_KINDS,
  backendDefaultPort,
  backendDefaultUsername,
  backendDisplayName,
  backendSetupCommand
} from "../backendSetup"
import type { Translator } from "../i18n"
import type { BackendKind, FileEntry, MachineSnapshot, ServerConfig } from "../types"

/** Breadcrumb pieces for an absolute path, POSIX or Windows, each carrying the path to browse to.
 *  Typing or pasting a deep path and then wanting to step back up one level is the common case, and
 *  a "parent folder" row alone makes that N clicks. */
export function pathSegments(path: string): Array<{ label: string; path: string }> {
  if (!path) return []
  const windows = /^[A-Za-z]:/.test(path)
  const parts = path.split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0) return [{ label: "/", path: "/" }]
  if (windows) {
    const segments = [{ label: parts[0], path: `${parts[0]}\\` }]
    let current = parts[0]
    for (const part of parts.slice(1)) {
      current = `${current}\\${part}`
      segments.push({ label: part, path: current })
    }
    return segments
  }
  const segments = [{ label: "/", path: "/" }]
  let current = ""
  for (const part of parts) {
    current = `${current}/${part}`
    segments.push({ label: part, path: current })
  }
  return segments
}

function CopyButton({ text, copyLabel, copiedLabel }: { text: string; copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className="btn-secondary compact"
      onClick={() => {
        void copyToClipboard(text)
        setCopied(true)
      }}
    >
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      {copied ? copiedLabel : copyLabel}
    </button>
  )
}

/**
 * Choosing where a new session runs. The old dialog dropped the user into whatever folder the
 * server happened to report and offered a flat list plus a "parent folder" row - no way to see
 * where you were, no way to type a path you already knew, and no shortcut to a project you had
 * opened ten minutes earlier. All three are here now, and the folder that will actually be used is
 * stated in full before the button that uses it.
 */
export function NewSessionDialog({
  t,
  path,
  items,
  loading,
  error,
  creating,
  recentDirectories,
  onBrowse,
  onCreate,
  onUseServerDefault,
  onClose
}: {
  t: Translator
  path: string
  items: FileEntry[]
  loading: boolean
  error: string | null
  creating: boolean
  recentDirectories: string[]
  onBrowse: (path: string) => void
  onCreate: (directory: string) => void
  onUseServerDefault: () => void
  onClose: () => void
}) {
  const [typedPath, setTypedPath] = useState("")
  const segments = useMemo(() => pathSegments(path), [path])

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal-card wizard fade-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="wizard-header">
          <div className="wizard-header-text">
            <h2 id="new-session-title">{t('sessions.newSessionTitle')}</h2>
            <p className="subtle">{t('sessions.projectDirectoryDefault')}</p>
          </div>
          <button type="button" className="btn-icon btn-ghost" onClick={onClose} aria-label={t('session.cancel')}>
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="wizard-body">
          {recentDirectories.length > 0 && (
            <div className="field">
              <span className="eyebrow">{t('sessions.recentProjects')}</span>
              <div className="recent-projects">
                {recentDirectories.map((directory) => (
                  <button
                    key={directory}
                    type="button"
                    className={`recent-project${directory === path ? " selected" : ""}`}
                    onClick={() => onBrowse(directory)}
                    title={directory}
                  >
                    <FolderIcon size={14} />
                    <span>{directory}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="field">
            <span className="eyebrow">{t('sessions.browseFolders')}</span>
            <div className="path-breadcrumb" aria-label={t('sessions.browseFolders')}>
              {segments.map((segment, index) => (
                <span key={segment.path} style={{ display: "inline-flex", alignItems: "center" }}>
                  {index > 0 && <span className="path-breadcrumb-sep" aria-hidden="true">/</span>}
                  <button type="button" onClick={() => onBrowse(segment.path)}>{segment.label}</button>
                </span>
              ))}
            </div>
            <div className="folder-list">
              {loading ? (
                <div className="empty-state compact">
                  <LoadingIcon size={24} />
                  <p>{t('sessions.folderPickerLoading')}</p>
                </div>
              ) : items.length === 0 ? (
                <p className="subtle model-empty">{t('sessions.folderPickerEmpty')}</p>
              ) : (
                items.map((item) => (
                  <button key={item.absolute} type="button" className="folder-row" onClick={() => onBrowse(item.absolute)}>
                    <FolderIcon size={15} />
                    <span>{item.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="field">
            <span>{t('sessions.typePathLabel')}</span>
            <div className="inline-actions">
              <input
                value={typedPath}
                onChange={(event) => setTypedPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return
                  event.preventDefault()
                  if (typedPath.trim()) onBrowse(typedPath.trim())
                }}
                placeholder={t('sessions.typePathPlaceholder')}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="none"
                autoComplete="off"
                style={{ flex: "1 1 14rem" }}
              />
              <button
                type="button"
                className="btn-secondary"
                disabled={!typedPath.trim()}
                onClick={() => onBrowse(typedPath.trim())}
              >
                {t('sessions.goToPath')}
              </button>
            </div>
          </div>

          <div className="folder-picker-current">
            <span className="eyebrow">{t('sessions.projectDirectoryLabel')}</span>
            <strong>{path || t('detail.loadingProject')}</strong>
          </div>

          {error && <div className="error fade-in">✗ {error}</div>}
        </div>

        <div className="wizard-footer">
          <button type="button" className="btn-ghost" onClick={onUseServerDefault} disabled={creating}>
            {t('sessions.useServerDefault')}
          </button>
          <span className="spacer" />
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t('session.cancel')}
          </button>
          <button type="button" className="btn-primary" onClick={() => onCreate(path)} disabled={creating || !path}>
            {creating ? <LoadingIcon size={15} /> : <PlusIcon size={15} />}
            {creating ? t('sessions.creating') : t('sessions.useThisFolder')}
          </button>
        </div>
      </section>
    </div>
  )
}

type WizardStep = "harness" | "address" | "credentials"
const WIZARD_STEPS: WizardStep[] = ["harness", "address", "credentials"]

/**
 * Adding a server used to mean creating a blank profile and then filling in a five-field form with
 * no explanation of what any harness expects, no idea which port is right, and no way to know that
 * something also has to be started on the other machine. The wizard asks the three questions in the
 * order they matter, defaults the port and username from the harness, and shows the finished
 * command to run on the host before asking for credentials that cannot work without it.
 */
export function ConnectServerWizard({
  t,
  initialName,
  onCancel,
  onSave,
  onTest,
  onDiscover
}: {
  t: Translator
  initialName: string
  onCancel: () => void
  onSave: (name: string, config: ServerConfig) => void
  onTest: (config: ServerConfig) => Promise<{ ok: boolean; message: string }>
  onDiscover?: (config: ServerConfig) => Promise<MachineSnapshot | null>
}) {
  const [step, setStep] = useState<WizardStep>("harness")
  const [backend, setBackend] = useState<BackendKind>("opencode")
  const [name, setName] = useState(initialName)
  const [nameEdited, setNameEdited] = useState(false)
  const [host, setHost] = useState("")
  const [port, setPort] = useState(backendDefaultPort("opencode"))
  const [username, setUsername] = useState(backendDefaultUsername("opencode"))
  const [password, setPassword] = useState("")
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [machine, setMachine] = useState<MachineSnapshot | null>(null)
  const [agentId, setAgentId] = useState("")

  const config: ServerConfig = {
    backend,
    host: host.trim(),
    port,
    username: username.trim(),
    password,
    agentId: agentId || undefined
  }
  const discoveryConfig: ServerConfig = { backend, host: host.trim(), port, username: username.trim(), password }
  const command = backendSetupCommand(backend, { port, username, password })
  const stepIndex = WIZARD_STEPS.indexOf(step)
  const canLeaveAddress = Boolean(host.trim()) && port > 0
  const canSave = canLeaveAddress && Boolean(username.trim()) && (!machine || Boolean(agentId))

  function chooseBackend(next: BackendKind) {
    setBackend(next)
    setPort(backendDefaultPort(next))
    setUsername(backendDefaultUsername(next))
    if (!nameEdited) setName(`${backendDisplayName(next)} server`)
    setTestResult(null)
    setMachine(null)
    setAgentId("")
    setStep("address")
  }

  async function test() {
    setTesting(true)
    setTestResult(null)
    setMachine(null)
    setAgentId("")
    try {
      const discover = onDiscover ?? (async (candidate: ServerConfig) => {
        const { discoverMachine } = await import("../machineClient")
        return discoverMachine(candidate)
      })

      let discovered: MachineSnapshot | null = null
      try {
        discovered = await discover(discoveryConfig)
      } catch {
        // A daemon with bad credentials and an unreachable host will be explained by the ordinary
        // backend health test below. Legacy servers intentionally return null from discovery.
      }

      if (discovered) {
        const available = discovered.agents.filter((agent) => agent.state === "available" || agent.state === "configured")
        const preferred = available.find((agent) => agent.backend === backend)
        setMachine(discovered)
        setAgentId(preferred?.id ?? "")
        if (preferred && !nameEdited) setName(`${discovered.machine.name} · ${preferred.label}`)
        setTestResult({
          ok: Boolean(preferred),
          message: preferred
            ? `${t('connection.connected')} · ${discovered.machine.name}`
            : `${discovered.machine.name} · ${t('detail.unavailable')}`
        })
        return
      }

      setTestResult(await onTest(discoveryConfig))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal-card wizard fade-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-server-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="wizard-header">
          <div className="wizard-header-text">
            <h2 id="connect-server-title">{t('connect.title')}</h2>
            <p className="subtle">{t('connect.subtitle')}</p>
          </div>
          <button type="button" className="btn-icon btn-ghost wizard-close" onClick={onCancel} aria-label={t('session.cancel')}>
            <CloseIcon size={16} />
          </button>
        </div>

        {/* The steps double as navigation. A failed test is usually the address or the port rather
            than the password, and stepping back one screen at a time to check made that a chore. */}
        <ol className="wizard-steps">
          {WIZARD_STEPS.map((candidate, index) => {
            const reachable = candidate !== "credentials" || canLeaveAddress
            return (
              <li
                key={candidate}
                className={`wizard-step${candidate === step ? " active" : index < stepIndex ? " done" : ""}`}
              >
                <button
                  type="button"
                  className="wizard-step-button"
                  onClick={() => setStep(candidate)}
                  disabled={!reachable}
                  aria-current={candidate === step ? "step" : undefined}
                >
                  <span className="wizard-step-index" aria-hidden="true">{index < stepIndex ? "✓" : index + 1}</span>
                  {t(`connect.step.${candidate}`)}
                </button>
                {index < WIZARD_STEPS.length - 1 && <span className="wizard-step-divider" aria-hidden="true" />}
              </li>
            )
          })}
        </ol>

        <div className="wizard-body">
          {step === "harness" && (
            <div className="choice-grid">
              {BACKEND_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={`choice-card${backend === kind ? " selected" : ""}`}
                  aria-pressed={backend === kind}
                  onClick={() => chooseBackend(kind)}
                >
                  <strong>
                    <span className={`harness-badge harness-${kind}`}>{backendDisplayName(kind)}</span>
                  </strong>
                  <small>{t(`connect.harness.${kind}`)}</small>
                </button>
              ))}
            </div>
          )}

          {step === "address" && (
            <>
              <label className="field">
                <span>{t('settings.serverName')}</span>
                <input
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value)
                    setNameEdited(true)
                  }}
                  autoComplete="off"
                />
              </label>
              <div className="form-grid">
                <label className="field">
                  <span>{t('settings.host')}</span>
                  <input
                    value={host}
                    onChange={(event) => setHost(event.target.value)}
                    placeholder={t('settings.hostPlaceholder')}
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </label>
                <label className="field">
                  <span>{t('settings.port')}</span>
                  <input
                    value={port || ""}
                    onChange={(event) => {
                      const value = event.target.value.trim()
                      if (value === "" || /^\d+$/.test(value)) setPort(value === "" ? 0 : Number(value))
                    }}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="off"
                  />
                </label>
              </div>
              <p className="field-hint">{t('connect.addressHint')}</p>
              <div className="code-callout">
                <div className="code-callout-head">
                  <span className="eyebrow">{t('connect.runOnHost')}</span>
                  <CopyButton text={command} copyLabel={t('connect.copyCommand')} copiedLabel={t('connect.copied')} />
                </div>
                <pre>{command}</pre>
              </div>
            </>
          )}

          {step === "credentials" && (
            <>
              <div className="form-grid">
                <label className="field">
                  <span>{t('settings.username')}</span>
                  <input
                    value={username}
                    onChange={(event) => {
                      setUsername(event.target.value)
                      setTestResult(null)
                      setMachine(null)
                      setAgentId("")
                    }}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    autoComplete="username"
                  />
                </label>
                <label className="field">
                  <span>{t('settings.password')}</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value)
                      setTestResult(null)
                      setMachine(null)
                      setAgentId("")
                    }}
                    placeholder={t('settings.passwordPlaceholder')}
                    autoComplete="current-password"
                  />
                </label>
              </div>
              <p className="field-hint">{t('connect.credentialsHint')}</p>

              {machine && (
                <label className="field fade-in">
                  <span>{t('detail.agentTitle')} · {machine.machine.name}</span>
                  <select
                    value={agentId}
                    onChange={(event) => {
                      const nextID = event.target.value
                      setAgentId(nextID)
                      const next = machine.agents.find((agent) => agent.id === nextID)
                      if (next && !nameEdited) setName(`${machine.machine.name} · ${next.label}`)
                    }}
                  >
                    {machine.agents.filter((agent) => agent.backend === backend).map((agent) => (
                      <option
                        key={agent.id}
                        value={agent.id}
                        disabled={agent.state !== "available" && agent.state !== "configured"}
                      >
                        {agent.label}{agent.state === "unavailable" ? ` · ${t('detail.unavailable')}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
        </div>

        {/* Outside the scrolling body on purpose. Testing the connection is the first thing anyone
            does on this step, and with a keyboard open the body is only a couple of lines tall, so a
            test button living at the end of it scrolled out of sight and came to rest against the
            save button, which is the one press you do not want to hit by accident. */}
        {step === "credentials" && (
          <div className="wizard-test">
            <button type="button" className="btn-secondary" onClick={() => void test()} disabled={testing || !canLeaveAddress || !username.trim()}>
              {testing ? <LoadingIcon size={15} /> : <TestIcon size={15} />}
              {testing ? t('settings.testing') : t('settings.test')}
            </button>
            {testResult && (
              <div className={`notice ${testResult.ok ? "success" : "error"} fade-in`}>
                {testResult.ok ? "✓ " : "✗ "}
                {testResult.message}
              </div>
            )}
          </div>
        )}

        <div className="wizard-footer">
          {step !== "harness" && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setStep(WIZARD_STEPS[Math.max(0, stepIndex - 1)])}
            >
              <ArrowLeftIcon size={15} />
              {t('connect.back')}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn-secondary" onClick={onCancel}>
            {t('session.cancel')}
          </button>
          {step === "credentials" ? (
            <button type="button" className="btn-primary" onClick={() => onSave(name, config)} disabled={!canSave}>
              <ServerIcon size={15} />
              {t('connect.save')}
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              onClick={() => setStep(step === "harness" ? "address" : "credentials")}
              disabled={step === "address" && !canLeaveAddress}
            >
              {t('connect.next')}
            </button>
          )}
        </div>
      </section>
    </div>
  )
}
