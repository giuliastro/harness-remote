import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { createPortal } from "react-dom"
import { AlertIcon, LoadingIcon, PuzzleIcon, RefreshIcon, ServerIcon } from "../Icons"
import { harnessIconUrl } from "../harness-icons"
import { mutatePlugin, runPluginAction } from "../pluginClient"
import {
  activePlugins,
  pluginIsActive,
  pluginToneClass,
  type PluginInfo,
  type PluginSnapshot
} from "../plugins"
import { usePluginSnapshot } from "../usePluginSnapshot"
import { useDialogDismiss } from "../useDialogDismiss"
import { useLanguage, useTranslator } from "../useTranslator"
import type { Translator } from "../i18n"
import type { WorkspaceMachine } from "../workspaceMachines"
import {
  PluginDashboardContent,
  PluginDiagnostics,
  PluginIcon,
  PluginSettingsForm,
  PluginStateBadge
} from "./plugin-widgets"
import { isDesktopLocalMachine } from "../workspaceMachines"

type PluginNotice = { kind: "success" | "error"; text: string; url?: string }
const STORAGE_WARNING_BYTES = 512 * 1024 * 1024

function formatStorage(bytes: number, language: string): string {
  if (bytes < 1024) return `${bytes} B`
  const unit = bytes < 1024 * 1024 ? "KB" : bytes < 1024 * 1024 * 1024 ? "MB" : "GB"
  const divisor = unit === "KB" ? 1024 : unit === "MB" ? 1024 * 1024 : 1024 * 1024 * 1024
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(bytes / divisor)} ${unit}`
}

function openDashboardURL(url: string, machine: WorkspaceMachine): void {
  if (isDesktopLocalMachine(machine)) window.open(url, "_blank", "noopener,noreferrer")
}

function NoticeLink({ notice, machine, t }: { notice: PluginNotice; machine: WorkspaceMachine; t: ReturnType<typeof useTranslator> }) {
  if (!notice.url) return null
  return isDesktopLocalMachine(machine)
    ? <a className="hr-plugin-notice-link" href={notice.url} target="_blank" rel="noreferrer">{t("plugins.openDashboard")}</a>
    : <code className="hr-plugin-notice-url" title={notice.url}>{notice.url}</code>
}

function pluginMachineName(machine: WorkspaceMachine | undefined): string {
  return machine?.name || "This machine"
}

function dependencyLabel(plugin: PluginInfo, t: Translator): string {
  if (!plugin.dependency || plugin.dependency.state === "missing") return t("plugins.notInstalled")
  return plugin.dependency.state === "managed" ? t("plugins.managed") : t("plugins.detected")
}

function formatCheckedAt(value: string, language: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(date)
}

function PluginPopover({
  plugin,
  plugins,
  machine,
  snapshot,
  onSelectPlugin,
  onClose,
  onOpenPlugins,
  onRefresh,
  refreshing,
  focusHarness,
  anchor
}: {
  plugin: PluginInfo
  plugins: PluginInfo[]
  machine: WorkspaceMachine
  snapshot: PluginSnapshot | null
  onSelectPlugin: (id: string) => void
  onClose: () => void
  onOpenPlugins: () => void
  onRefresh: () => void
  refreshing: boolean
  focusHarness?: string
  anchor: { top: number; right: number }
}) {
  const t = useTranslator()
  const language = useLanguage()
  const popoverRef = useRef<HTMLElement>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [actionNotice, setActionNotice] = useState<PluginNotice | null>(null)
  const openAction = plugin.actions.custom.find((action) => action.id === "open")
  useDialogDismiss(popoverRef, onClose, { autoFocus: false })
  async function launchTokenHarness() {
    setActionBusy(true)
    setActionNotice(null)
    try {
      const result = await runPluginAction(machine.config, plugin.id, "open")
      if (result.url) openDashboardURL(result.url, machine)
      setActionNotice({
        kind: "success",
        text: t("plugins.tokenHarnessOpenedOn", { name: machine.name }),
        ...(result.url ? { url: result.url } : {})
      })
    } catch (reason) {
      setActionNotice({ kind: "error", text: reason instanceof Error ? reason.message : t("plugins.actionFailed") })
    } finally {
      setActionBusy(false)
    }
  }
  useEffect(() => {
    const close = () => onClose()
    window.addEventListener("resize", close)
    return () => {
      window.removeEventListener("resize", close)
    }
  }, [onClose])
  const style = {
    ["--hr-plugin-popover-top" as string]: `${anchor.top}px`,
    ["--hr-plugin-popover-right" as string]: `${anchor.right}px`
  } as CSSProperties
  return createPortal(
    <>
      <button type="button" className="hr-plugin-popover-backdrop" aria-label={t("plugins.close")} onClick={onClose} />
      <section
        className="hr-plugin-popover"
        ref={popoverRef}
        role="dialog"
        aria-label={`${plugin.name} · ${t("plugins.allowance")}`}
        style={style}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="hr-plugin-popover-head">
          <div className="hr-plugin-popover-title">
            <PluginIcon plugin={plugin} size={20} />
            <div>
              <strong>{plugin.name}</strong>
              <span>{machine.name} · {formatCheckedAt(snapshot?.generatedAt ?? plugin.checkedAt, language)}</span>
            </div>
          </div>
          <div className="hr-plugin-popover-tools">
            <button type="button" className="tdw-icon-button" onClick={onRefresh} disabled={refreshing} aria-label={t("plugins.refresh")} title={t("plugins.refresh")}>
              {refreshing ? <LoadingIcon size={15} /> : <RefreshIcon size={15} />}
            </button>
            <button type="button" className="tdw-icon-button" onClick={onClose} aria-label={t("plugins.close")}>×</button>
          </div>
        </header>
        {plugins.length > 1 ? (
          <div className="hr-plugin-popover-tabs" role="tablist" aria-label={t("plugins.title")}>
            {plugins.map((candidate) => (
              <button
                type="button"
                role="tab"
                aria-selected={candidate.id === plugin.id}
                className={candidate.id === plugin.id ? "active" : ""}
                key={candidate.id}
                onClick={() => onSelectPlugin(candidate.id)}
              >
                <PluginIcon plugin={candidate} size={13} />
                {candidate.name}
              </button>
            ))}
          </div>
        ) : null}
        <div className="hr-plugin-popover-body">
          <PluginDashboardContent
            plugin={plugin}
            machine={machine}
            onChanged={onRefresh}
            showWindow={false}
            routingFirst
            compact
            focusHarness={focusHarness}
          />
        </div>
        {actionNotice ? (
          <p className={`hr-plugin-popover-status ${actionNotice.kind}`} role={actionNotice.kind === "error" ? "alert" : "status"}>
            {actionNotice.text}
            {actionNotice.url ? <> <NoticeLink notice={actionNotice} machine={machine} t={t} /></> : null}
          </p>
        ) : null}
        <footer className="hr-plugin-popover-footer">
          <span>{plugin.dependency ? `${dependencyLabel(plugin, t)}${plugin.dependency.version ? ` · v${plugin.dependency.version}` : ""}` : t("plugins.notInstalled")}</span>
          <div className="hr-plugin-popover-actions">
            {openAction ? (
              <button type="button" className="tdw-button secondary" disabled={actionBusy} onClick={() => void launchTokenHarness()}>
                {actionBusy ? <LoadingIcon size={13} /> : t("plugins.openTokenHarness")}
              </button>
            ) : null}
            <button type="button" className="tdw-button primary" onClick={() => { onClose(); onOpenPlugins() }}>{t("plugins.manage")}</button>
          </div>
        </footer>
      </section>
    </>,
    document.body
  )
}

/**
 * The always-visible plugin surface in the top bar. With an active plugin that publishes a quick
 * status, this is the allowance chip. Without one, it becomes the door to the plugin catalogue so
 * installing the first integration never depends on finding Settings.
 */
export function PluginQuickView({
  machine,
  snapshot,
  loading,
  refreshing,
  refresh,
  activeHarness,
  onOpenPlugins,
  variant = "topbar"
}: {
  machine: WorkspaceMachine | undefined
  snapshot: PluginSnapshot | null
  loading: boolean
  refreshing: boolean
  refresh: () => void
  activeHarness?: string
  onOpenPlugins: () => void
  variant?: "topbar" | "session"
}) {
  const t = useTranslator()
  const [open, setOpen] = useState(false)
  const [selectedID, setSelectedID] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const plugins = useMemo(
    () => activePlugins(snapshot).filter((plugin) => Boolean(plugin.contributions.home)),
    [snapshot]
  )
  const contextual = useMemo(() => {
    if (!activeHarness) return null
    for (const candidate of plugins) {
      const harness = candidate.contributions.home?.harnesses.find((item) => item.harnessId === activeHarness)
      if (harness) return { plugin: candidate, harness }
    }
    return null
  }, [activeHarness, plugins])
  useEffect(() => {
    if (!plugins.length) {
      setOpen(false)
      setSelectedID(null)
      return
    }
    if (!selectedID || !plugins.some((plugin) => plugin.id === selectedID)) {
      setSelectedID(contextual?.plugin.id ?? plugins[0].id)
    }
  }, [contextual?.plugin.id, plugins, selectedID])
  const plugin = plugins.find((candidate) => candidate.id === selectedID) ?? contextual?.plugin ?? plugins[0]
  function openPopover() {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    setAnchor({ top: rect.bottom + 8, right: Math.max(12, window.innerWidth - rect.right) })
    setOpen(true)
  }
  if (!snapshot && !loading) return null
  if (!plugin || !contextual) {
    if (variant === "session") return null
    return (
      <button
        type="button"
        className="tdw-icon-button hr-plugins-button"
        onClick={onOpenPlugins}
        title={t("plugins.manage")}
        aria-label={t("plugins.manage")}
      >
        <PuzzleIcon size={16} />
      </button>
    )
  }
  const harness = contextual.harness
  const value = harness.remainingPercent === null ? "—" : `${Math.round(harness.remainingPercent)}%`
  const windows = plugin.contributions.home?.meters
    .filter((meter) => meter.harness === activeHarness)
    .map((meter) => `${meter.label} ${meter.remainingPercent === null ? "—" : `${Math.round(meter.remainingPercent)}%`}`)
    .join(" · ")
  const chipLabel = activeHarness === "claude" ? "Claude" : activeHarness === "codex" ? "Codex" : harness.label
  const icon = activeHarness ? harnessIconUrl(activeHarness) : null
  return (
    <>
      <button
        type="button"
        ref={buttonRef}
        className={`hr-plugin-chip${variant === "session" ? " hr-plugin-chip-session" : ""}${pluginToneClass(harness.remainingPercent === null ? "muted" : harness.remainingPercent <= 15 ? "danger" : harness.remainingPercent <= 35 ? "warn" : "good")}`}
        onClick={() => open ? setOpen(false) : openPopover()}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${plugin.name}: ${harness.label} allowance ${value}`}
        title={`${plugin.name} · ${harness.label} allowance${windows ? ` · ${windows}` : ""}`}
      >
        {icon ? <img className="hr-plugin-chip-harness" src={icon} alt="" width={16} height={16} /> : <PluginIcon plugin={plugin} size={15} />}
        <span className="hr-plugin-chip-label">{chipLabel}</span>
        <span className="hr-plugin-chip-value">{value}</span>
      </button>
      {open && anchor && machine ? (
        <PluginPopover
          plugin={plugin}
          plugins={plugins}
          machine={machine}
          snapshot={snapshot}
          onSelectPlugin={setSelectedID}
          onClose={() => setOpen(false)}
          onOpenPlugins={onOpenPlugins}
          onRefresh={refresh}
          refreshing={refreshing}
          focusHarness={activeHarness}
          anchor={anchor}
        />
      ) : null}
    </>
  )
}

function PluginDetail({
  plugin,
  machine,
  onAction,
  onCustomAction,
  busyAction,
  notice,
  confirmUninstall,
  onConfirmUninstall,
  onCancelUninstall,
  onRefresh,
  onBack
}: {
  plugin: PluginInfo
  machine: WorkspaceMachine
  onAction: (plugin: PluginInfo, action: "install" | "update" | "uninstall" | "enable" | "disable") => void
  onCustomAction: (plugin: PluginInfo, actionID: string) => void
  busyAction: string | null
  notice: PluginNotice | null
  confirmUninstall: boolean
  onConfirmUninstall: () => void
  onCancelUninstall: () => void
  onRefresh: () => void
  onBack: () => void
}) {
  const t = useTranslator()
  const language = useLanguage()
  const active = pluginIsActive(plugin)
  const busy = (action: string) => busyAction === `${plugin.id}:${action}`
  const busyCustom = (actionID: string) => busyAction === `${plugin.id}:action:${actionID}`
  const dependency = plugin.dependency
  const canInstall = plugin.actions.install.available
  const canUpdate = plugin.actions.update.available
  const canUninstall = plugin.actions.uninstall.available
  return (
    <div className="hr-plugin-detail-inner">
      <button type="button" className="hr-plugin-mobile-back" onClick={onBack}>← {t("plugins.title")}</button>
      <header className="hr-plugin-detail-head">
        <div className="hr-plugin-detail-identity">
          <PluginIcon plugin={plugin} size={34} />
          <div>
            <div className="hr-plugin-detail-eyebrow">
              <span>{plugin.builtIn ? t("plugins.builtIn") : "Plugin"}</span>
              {plugin.vendor ? <><i aria-hidden="true">·</i><span>{plugin.vendor}</span></> : null}
            </div>
            <h2>{plugin.name}</h2>
            <p>{plugin.description}</p>
            <div className="hr-plugin-detail-badges">
              <PluginStateBadge plugin={plugin} />
              <span className="hr-plugin-badge">v{plugin.version}</span>
              {dependency ? <span className="hr-plugin-badge">{dependencyLabel(plugin, t)}</span> : null}
              {dependency?.version ? <span className="hr-plugin-badge">CLI {dependency.version}</span> : null}
              {plugin.storage ? <span className="hr-plugin-badge">{t("plugins.storage")}: {plugin.storage.complete ? "" : "≥"}{formatStorage(plugin.storage.bytes, language)}</span> : null}
            </div>
          </div>
        </div>
        <div className="hr-plugin-detail-actions">
          {active ? (
            <>
              {canInstall ? (
                <button type="button" className="tdw-button secondary" disabled={Boolean(busyAction)} onClick={() => onAction(plugin, "install")}>
                  {busy("install") ? <><LoadingIcon size={14} /> {t("plugins.installing")}</> : t("plugins.install")}
                </button>
              ) : null}
              {canUpdate ? (
                <button type="button" className="tdw-button secondary" disabled={Boolean(busyAction)} onClick={() => onAction(plugin, "update")}>
                  {busy("update") ? <><LoadingIcon size={14} /> {t("plugins.updating")}</> : t("plugins.update")}
                </button>
              ) : null}
              <button type="button" className="tdw-button secondary" disabled={Boolean(busyAction)} onClick={() => onAction(plugin, "disable")}>
                {busy("disable") ? <><LoadingIcon size={14} /> {t("plugins.disabling")}</> : t("plugins.disable")}
              </button>
            </>
          ) : plugin.ready ? (
            <button type="button" className="tdw-button primary" disabled={Boolean(busyAction)} onClick={() => onAction(plugin, "enable")}>
              {busy("enable") ? <><LoadingIcon size={14} /> {t("plugins.enabling")}</> : t("plugins.enable")}
            </button>
          ) : canInstall ? (
            <button type="button" className="tdw-button primary" disabled={Boolean(busyAction)} onClick={() => onAction(plugin, "install")}>
              {busy("install") ? <><LoadingIcon size={14} /> {t("plugins.installing")}</> : t("plugins.install")}
            </button>
          ) : null}
          {plugin.actions.custom.map((custom) => {
            const label = custom.id === "open" ? t("plugins.openTokenHarness") : custom.label
            return (
              <button
                type="button"
                className={`tdw-button ${custom.style}`}
                key={custom.id}
                disabled={Boolean(busyAction)}
                onClick={() => onCustomAction(plugin, custom.id)}
              >
                {busyCustom(custom.id) ? <><LoadingIcon size={14} /> {label}</> : label}
              </button>
            )
          })}
          {plugin.homepage ? (
            <a className="tdw-button secondary hr-plugin-link-button" href={plugin.homepage} target="_blank" rel="noreferrer">{t("plugins.openProject")}</a>
          ) : null}
          {canUninstall ? (
            <button type="button" className="tdw-button danger" disabled={Boolean(busyAction)} onClick={onConfirmUninstall}>
              {busy("uninstall") ? <><LoadingIcon size={14} /> {t("plugins.uninstalling")}</> : t("plugins.uninstall")}
            </button>
          ) : null}
        </div>
      </header>
      {dependency?.state === "external" ? <p className="hr-plugin-external-note">{t("plugins.externalInstallHint")}</p> : null}
      {!plugin.builtIn && !active ? <p className="hr-plugin-external-note">{t("plugins.userCodeWarning")}</p> : null}
      {plugin.storage && plugin.storage.bytes >= STORAGE_WARNING_BYTES ? <p className="hr-plugin-external-note" role="status">{t("plugins.storageLarge")}</p> : null}

      {notice ? (
        <p className={`hr-plugin-notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.text}
          {notice.url ? <> <NoticeLink notice={notice} machine={machine} t={t} /></> : null}
        </p>
      ) : null}

      {confirmUninstall ? (
        <section className="hr-plugin-confirm" role="alertdialog" aria-label={t("plugins.uninstallTitle", { name: plugin.name })}>
          <div>
            <strong>{t("plugins.uninstallTitle", { name: plugin.name })}</strong>
            <p>{t("plugins.uninstallBody")}</p>
          </div>
          <div className="hr-plugin-confirm-actions">
            <button type="button" className="tdw-button secondary" onClick={onCancelUninstall}>{t("plugins.cancel")}</button>
            <button type="button" className="tdw-button danger" disabled={Boolean(busyAction)} onClick={() => onAction(plugin, "uninstall")}>
              {busy("uninstall") ? <><LoadingIcon size={14} /> {t("plugins.uninstalling")}</> : t("plugins.confirm")}
            </button>
          </div>
        </section>
      ) : null}

      {!plugin.ready ? (
        <section className="hr-plugin-install-panel">
          <div>
            <h3>{canInstall ? t("plugins.notInstalled") : t("plugins.needsAttention")}</h3>
            <p>{dependency?.detail || t("plugins.installHint")}</p>
            {canInstall ? <small>{t("plugins.installHint")}</small> : null}
          </div>
          {canInstall ? (
            <button type="button" className="tdw-button primary" disabled={Boolean(busyAction)} onClick={() => onAction(plugin, "install")}>
              {busy("install") ? <><LoadingIcon size={14} /> {t("plugins.installing")}</> : t("plugins.install")}
            </button>
          ) : null}
        </section>
      ) : !active ? (
        <section className="hr-plugin-install-panel">
          <div>
            <h3>{t("plugins.disabled")}</h3>
            <p>{t("plugins.enableToConfigure")}</p>
          </div>
          <button type="button" className="tdw-button primary" disabled={Boolean(busyAction)} onClick={() => onAction(plugin, "enable")}>
            {busy("enable") ? <><LoadingIcon size={14} /> {t("plugins.enabling")}</> : t("plugins.enable")}
          </button>
        </section>
      ) : (
        <>
          {plugin.contributions.home ? (
            <section className="hr-plugin-detail-section">
              <PluginDashboardContent
                plugin={plugin}
                machine={machine}
                onChanged={onRefresh}
                showRouting={false}
                showWindow={false}
              />
            </section>
          ) : (
            <p className="hr-plugin-background-only">{plugin.description}</p>
          )}
          {plugin.settings ? (
            <section className="hr-plugin-detail-section">
              <PluginSettingsForm machine={machine} plugin={plugin} />
            </section>
          ) : null}
        </>
      )}

      <PluginDiagnostics plugin={plugin} />

      <section className="hr-plugin-about">
        <h4>{t("plugins.about")}</h4>
        <dl>
          <div><dt>{t("plugins.version")}</dt><dd>v{plugin.version}</dd></div>
          <div><dt>{t("plugins.machine")}</dt><dd>{machine.name}</dd></div>
          <div><dt>{t("plugins.runtime")}</dt><dd>{plugin.runtime.kind}</dd></div>
          {dependency ? <div><dt>{t("plugins.dependency")}</dt><dd>{dependencyLabel(plugin, t)}{dependency.version ? ` · v${dependency.version}` : ""}</dd></div> : null}
          {dependency?.path ? <div><dt>{t("plugins.path")}</dt><dd><code title={dependency.path}>{dependency.path}</code></dd></div> : null}
          {plugin.capabilities.length ? <div><dt>{t("plugins.capabilities")}</dt><dd>{plugin.capabilities.join(" · ")}</dd></div> : null}
          {plugin.permissions.length ? <div><dt>{t("plugins.permissions")}</dt><dd>{plugin.permissions.join(" · ")}</dd></div> : null}
          <div><dt>{t("plugins.lastChecked")}</dt><dd>{formatCheckedAt(plugin.checkedAt, language)}</dd></div>
        </dl>
      </section>
    </div>
  )
}

/**
 * The plugin catalogue. It is a dialog rather than a settings page because a plugin has a lifecycle
 * and a detail view, and because every lifecycle action has to be able to refresh the same list the
 * user is looking at. The machine picker is deliberate: applications live on computers, not in the
 * phone that controls them.
 */
export function PluginCenter({
  machines,
  initialMachineID,
  onClose
}: {
  machines: WorkspaceMachine[]
  initialMachineID?: string
  onClose: () => void
}) {
  const t = useTranslator()
  const language = useLanguage()
  const sectionRef = useRef<HTMLElement>(null)
  useDialogDismiss(sectionRef, onClose)
  const initial = machines.find((machine) => machine.id === initialMachineID)
    ?? machines.find(isDesktopLocalMachine)
    ?? machines[0]
  const [machineID, setMachineID] = useState(initial?.id ?? "")
  const machine = machines.find((candidate) => candidate.id === machineID) ?? initial
  const { snapshot, error, loading, refreshing, refresh } = usePluginSnapshot(machine)
  const [selectedPluginID, setSelectedPluginID] = useState<string | null>(null)
  const [mobileDetail, setMobileDetail] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [notice, setNotice] = useState<PluginNotice | null>(null)
  const [confirmUninstallID, setConfirmUninstallID] = useState<string | null>(null)

  useEffect(() => {
    setSelectedPluginID(null)
    setMobileDetail(false)
    setNotice(null)
    setConfirmUninstallID(null)
  }, [machineID])

  useEffect(() => {
    if (!snapshot?.plugins.length) {
      setSelectedPluginID(null)
      return
    }
    if (selectedPluginID && snapshot.plugins.some((plugin) => plugin.id === selectedPluginID)) return
    setSelectedPluginID(snapshot.plugins[0].id)
  }, [snapshot, selectedPluginID])

  const selected = snapshot?.plugins.find((plugin) => plugin.id === selectedPluginID)
  const activeCount = snapshot?.plugins.filter(pluginIsActive).length ?? 0

  async function perform(plugin: PluginInfo, action: "install" | "update" | "uninstall" | "enable" | "disable") {
    if (!machine) return
    setBusyAction(`${plugin.id}:${action}`)
    setNotice(null)
    try {
      const result = await mutatePlugin(machine.config, plugin.id, action)
      const localized = action === "enable"
        ? t("plugins.actionEnabled", { name: plugin.name })
        : action === "disable"
          ? t("plugins.actionDisabled", { name: plugin.name })
          : result.message || t("plugins.actionDone", { name: plugin.name })
      setNotice({ kind: "success", text: localized })
      if (action === "uninstall") setConfirmUninstallID(null)
      await refresh()
    } catch (reason) {
      setNotice({ kind: "error", text: reason instanceof Error ? reason.message : t("plugins.actionFailed") })
    } finally {
      setBusyAction(null)
    }
  }

  async function performCustom(plugin: PluginInfo, actionID: string) {
    if (!machine) return
    setBusyAction(`${plugin.id}:action:${actionID}`)
    setNotice(null)
    try {
      const result = await runPluginAction(machine.config, plugin.id, actionID)
      if (actionID === "open" && result.url) openDashboardURL(result.url, machine)
      setNotice({
        kind: "success",
        text: actionID === "open" ? t("plugins.tokenHarnessOpenedOn", { name: machine.name }) : result.message || t("plugins.actionDone", { name: plugin.name }),
        ...(actionID === "open" && result.url ? { url: result.url } : {})
      })
    } catch (reason) {
      setNotice({ kind: "error", text: reason instanceof Error ? reason.message : t("plugins.actionFailed") })
    } finally {
      setBusyAction(null)
    }
  }

  function selectPlugin(plugin: PluginInfo) {
    setSelectedPluginID(plugin.id)
    setMobileDetail(true)
    setNotice(null)
    setConfirmUninstallID(null)
  }

  return createPortal(
    <div className="hr-plugin-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="hr-plugin-center"
        ref={sectionRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("plugins.title")}
        data-mobile-detail={mobileDetail ? "true" : "false"}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="hr-plugin-center-head">
          <div className="hr-plugin-center-title">
            <span>Harness Remote</span>
            <h2>{t("plugins.title")}</h2>
            <p>{t("plugins.subtitle")}</p>
          </div>
          <div className="hr-plugin-center-tools">
            {machines.length > 1 ? (
              <label className="hr-plugin-machine-picker">
                <ServerIcon size={14} />
                <select value={machine?.id ?? ""} onChange={(event) => setMachineID(event.target.value)} aria-label={t("plugins.machine")}>
                  {machines.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name}</option>)}
                </select>
              </label>
            ) : machine ? (
              <span className="hr-plugin-machine-name"><ServerIcon size={13} /> {pluginMachineName(machine)}</span>
            ) : null}
            <button
              type="button"
              className="tdw-icon-button"
              onClick={() => void refresh()}
              disabled={refreshing || !machine}
              aria-label={t("plugins.refresh")}
              title={t("plugins.refresh")}
            >
              {refreshing ? <LoadingIcon size={16} /> : <RefreshIcon size={16} />}
            </button>
            <button type="button" className="tdw-icon-button" onClick={onClose} aria-label={t("plugins.close")}>×</button>
          </div>
        </header>
        <div className="hr-plugin-center-body">
          <aside className="hr-plugin-list" aria-label={t("plugins.title")}>
            <div className="hr-plugin-list-meta">
              <span>{t("plugins.activeCount", { count: activeCount })}</span>
              {loading ? <LoadingIcon size={13} /> : null}
            </div>
            {loading && !snapshot ? (
              <div className="hr-plugin-list-loading" role="status"><LoadingIcon size={18} /><span>{t("plugins.loading")}</span></div>
            ) : null}
            {error ? (
              <div className="hr-plugin-list-error" role="alert">
                <AlertIcon size={16} />
                <span>{error.message || t("plugins.loadError")}</span>
                <button type="button" className="tdw-button secondary" onClick={() => void refresh()}>{t("plugins.retry")}</button>
              </div>
            ) : null}
            {!loading && !error && snapshot && snapshot.plugins.length === 0 ? (
              <div className="hr-plugin-list-empty">
                <PuzzleIcon size={20} />
                <strong>{t("plugins.noPlugins")}</strong>
                <span>{t("plugins.noPluginsBody")}</span>
              </div>
            ) : null}
            {snapshot?.plugins.map((plugin) => (
              <button
                type="button"
                className={`hr-plugin-list-item${plugin.id === selectedPluginID ? " active" : ""}`}
                key={plugin.id}
                onClick={() => selectPlugin(plugin)}
                aria-pressed={plugin.id === selectedPluginID}
              >
                <PluginIcon plugin={plugin} size={21} />
                <span className="hr-plugin-list-copy">
                  <strong>{plugin.name}</strong>
                  <small>{plugin.description}</small>
                </span>
                <span className={`hr-plugin-list-status tone-${pluginIsActive(plugin) ? "good" : plugin.state === "available" ? "warn" : "muted"}`}>
                  <i aria-hidden="true" />
                  {pluginIsActive(plugin) ? t("plugins.active") : plugin.state === "available" ? t("plugins.available") : t("plugins.disabled")}
                </span>
              </button>
            ))}
            {snapshot && !loading ? (
              <p className="hr-plugin-list-footnote">{t("plugins.checked", { time: formatCheckedAt(snapshot.generatedAt, language) })}</p>
            ) : null}
          </aside>
          <main className="hr-plugin-detail">
            {machine && selected ? (
              <PluginDetail
                plugin={selected}
                machine={machine}
                onAction={(plugin, action) => void perform(plugin, action)}
                onCustomAction={(plugin, actionID) => void performCustom(plugin, actionID)}
                busyAction={busyAction}
                notice={notice}
                confirmUninstall={confirmUninstallID === selected.id}
                onConfirmUninstall={() => setConfirmUninstallID(selected.id)}
                onCancelUninstall={() => setConfirmUninstallID(null)}
                onRefresh={() => void refresh()}
                onBack={() => setMobileDetail(false)}
              />
            ) : (
              <div className="hr-plugin-detail-empty">
                <PuzzleIcon size={26} />
                <strong>{t("plugins.noPlugins")}</strong>
                <span>{t("plugins.noPluginsBody")}</span>
              </div>
            )}
          </main>
        </div>
      </section>
    </div>,
    document.body
  )
}
