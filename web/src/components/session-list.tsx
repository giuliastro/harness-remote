import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent, type RefObject, type ReactNode } from "react"
import {
  CloseIcon,
  FolderIcon,
  HelpIcon,
  LoadingIcon,
  OfflineIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  SaveIcon,
  SearchIcon,
  SettingsIcon,
  TrashIcon
} from "../Icons"
import type { Translator } from "../i18n"
import { discoverMachine } from "../machineClient"
import { loadActiveServerProfile, loadServerProfiles, SERVER_PROFILES_CHANGED_EVENT } from "../serverProfiles"
import type { HarnessCapabilities, ServerConfig, SessionView } from "../types"
import { TaskLaunchDialog } from "./task-launch-dialog"

export function shortDirectory(directory: string): string {
  const segments = directory.split(/[\\/]+/).filter(Boolean)
  if (segments.length <= 2) return directory
  return `…/${segments.slice(-2).join("/")}`
}

export function projectLabel(directory: string): string {
  const segments = directory.split(/[\\/]+/).filter(Boolean)
  return segments[segments.length - 1] || directory
}

export function formatTime(epoch: number): string {
  if (!epoch) return "-"
  return new Date(epoch).toLocaleString()
}

export function formatRelativeTime(epoch: number, locale: string): string {
  if (!epoch) return "-"
  const deltaSeconds = Math.round((epoch - Date.now()) / 1000)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" })
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 60 * 60 * 24 * 365], ["month", 60 * 60 * 24 * 30], ["week", 60 * 60 * 24 * 7],
    ["day", 60 * 60 * 24], ["hour", 60 * 60], ["minute", 60]
  ]
  for (const [unit, secondsInUnit] of units) {
    if (Math.abs(deltaSeconds) >= secondsInUnit) return formatter.format(Math.round(deltaSeconds / secondsInUnit), unit)
  }
  return formatter.format(deltaSeconds, "second")
}

/**
 * Task launch needs the machine daemon, which a pre-daemon profile does not have. Both the sidebar
 * and the sessions panel show the control, so the probe is shared: without this, mounting the two
 * surfaces asks the same daemon the same question twice on every profile change.
 */
const TASK_LAUNCH_ENABLED = false

const availabilityProbes = new Map<string, Promise<boolean>>()

function probeTaskLaunch(config: ServerConfig): Promise<boolean> {
  const key = `${config.host.trim()}:${config.port}:${config.agentId ?? config.backend}`
  const pending = availabilityProbes.get(key)
  if (pending) return pending
  const probe = discoverMachine(config).then((machine) => Boolean(machine)).catch(() => false)
  availabilityProbes.set(key, probe)
  // The answer is only cached for as long as the request is in flight: a daemon that has just been
  // started must become usable without restarting the app.
  void probe.finally(() => availabilityProbes.delete(key))
  return probe
}

function useTaskLaunchAvailability(offline: boolean): "checking" | "available" | "legacy" {
  const [profileRevision, setProfileRevision] = useState(0)
  useEffect(() => {
    const refreshProfile = () => setProfileRevision((value) => value + 1)
    window.addEventListener(SERVER_PROFILES_CHANGED_EVENT, refreshProfile)
    return () => window.removeEventListener(SERVER_PROFILES_CHANGED_EVENT, refreshProfile)
  }, [])
  const profile = useMemo(() => loadActiveServerProfile(loadServerProfiles()), [profileRevision])
  const [state, setState] = useState<"checking" | "available" | "legacy">("checking")
  useEffect(() => {
    if (offline) {
      setState("checking")
      return
    }
    let cancelled = false
    setState("checking")
    void probeTaskLaunch(profile.config).then((available) => {
      if (!cancelled) setState(available ? "available" : "legacy")
    })
    return () => { cancelled = true }
  }, [offline, profile])
  return state
}

export type SessionRenameState = {
  sessionID: string | null
  source: "list" | "header" | null
  value: string
}

export function SessionCard({
  session,
  selectedID,
  rename,
  renameInputRef,
  capabilities,
  language,
  t,
  onOpen,
  onRenameValueChange,
  onRename,
  onCancelRename,
  onStartRename,
  onDelete
}: {
  session: SessionView
  selectedID: string | null
  rename: SessionRenameState
  renameInputRef: RefObject<HTMLInputElement>
  capabilities: HarnessCapabilities
  language: string
  t: Translator
  onOpen: (session: SessionView) => void
  onRenameValueChange: (value: string) => void
  onRename: (session: SessionView) => void
  onCancelRename: () => void
  onStartRename: (session: SessionView) => void
  onDelete: (session: SessionView) => void
}) {
  const isRenaming = rename.sessionID === session.id && rename.source === "list"
  return (
    <article
      className={`session-card ${session.status} ${selectedID === session.id ? "active" : ""} ${isRenaming ? "renaming" : ""} fade-in`}
      onClick={() => onOpen(session)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onOpen(session)
        }
      }}
    >
      <div className="session-card-main">
        <div>
          {isRenaming ? (
            <div className="rename-inline" onClick={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
              <input
                ref={renameInputRef}
                value={rename.value}
                onChange={(event) => onRenameValueChange(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  if (event.key === "Enter") {
                    event.preventDefault()
                    onRename(session)
                  } else if (event.key === "Escape") {
                    onCancelRename()
                  }
                }}
                onBlur={() => {
                  if (rename.value === session.title || !rename.value.trim()) onCancelRename()
                }}
                placeholder={t('session.renamePlaceholder')}
                enterKeyHint="done"
                autoCorrect="off"
                spellCheck={false}
                className="rename-input"
                autoComplete="off"
              />
              <button className="btn-primary compact" onClick={(event) => { event.stopPropagation(); onRename(session) }} onMouseDown={(event) => event.preventDefault()} title={t('session.renameConfirm')}>
                <SaveIcon size={16} />
              </button>
              <button className="btn-secondary compact" onClick={(event) => { event.stopPropagation(); onCancelRename() }} title={t('session.cancel')}>
                <CloseIcon size={16} />
              </button>
            </div>
          ) : (
            <h3 title={session.title}>{session.title}</h3>
          )}
          <p title={session.directory}>{shortDirectory(session.directory)}</p>
        </div>
      </div>
      <div className="session-stats">
        {(session.files > 0 || session.additions > 0 || session.deletions > 0) && (
          <span className="change-summary"><strong>{session.files}</strong> files<strong className="positive">+{session.additions}</strong><strong className="negative">-{session.deletions}</strong></span>
        )}
        <span className="subtle session-meta-line">
          <span className="session-directory-compact" title={session.directory}>{shortDirectory(session.directory)}</span>
          <span title={formatTime(session.updated)}>{t('sessions.updated', { time: formatRelativeTime(session.updated, language) })}</span>
        </span>
        <span className={`pill ${session.status}`}>{session.status}</span>
      </div>
      <div className="inline-actions">
        {capabilities.sessionRename && capabilities.sessionDelete && (
          <>
            <button className="btn-secondary" onClick={(event) => { event.stopPropagation(); onStartRename(session) }} title={t('session.renameTitle')} aria-label={t('session.renameTitle')}>
              <PencilIcon size={16} />{t('session.renameConfirm')}
            </button>
            <button className="btn-danger" onClick={(event) => { event.stopPropagation(); onDelete(session) }} title={t('sessions.delete')}>
              <TrashIcon size={16} />{t('sessions.delete')}
            </button>
          </>
        )}
      </div>
    </article>
  )
}

type SessionCardProps = Omit<Parameters<typeof SessionCard>[0], "session">

export function SessionSidebar({
  groups,
  query,
  searchInputRef,
  sidebarSessionsRef,
  refreshing,
  creating,
  offline,
  width,
  t,
  onQueryChange,
  onRefresh,
  onNewSession,
  onShowHelp,
  onShowSettings,
  onResize,
  onScroll,
  jumpControls,
  sessionCardProps
}: {
  groups: Array<{ directory: string; sessions: SessionView[] }>
  query: string
  searchInputRef: RefObject<HTMLInputElement>
  sidebarSessionsRef: RefObject<HTMLDivElement>
  refreshing: boolean
  creating: boolean
  offline: boolean
  width: number
  t: Translator
  onQueryChange: (value: string) => void
  onRefresh: () => void
  onNewSession: () => void
  onShowHelp: () => void
  onShowSettings: () => void
  onResize: (event: ReactPointerEvent) => void
  onScroll: () => void
  jumpControls: ReactNode
  sessionCardProps: SessionCardProps
}) {
  const [showTaskLaunch, setShowTaskLaunch] = useState(false)
  const taskAvailability = useTaskLaunchAvailability(offline)
  // New Task stays out of sight until a task is at least as capable as the session it wraps.
  // Promoting the weaker path is how a feature gets judged before it is ready; the flag is here
  // rather than deleted so turning it on is one edit and one release note.
  const taskEnabled = TASK_LAUNCH_ENABLED && !offline && taskAvailability === "available"
  const taskTitle = offline ? t('sessions.offlineHint') : taskEnabled ? t('task.new') : t('task.requiresDaemon')
  return (
    <>
      <aside className="desktop-sidebar fade-in" style={{ width, flex: `0 0 ${width}px` }}>
        <div className="resize-handle resize-handle--end" onPointerDown={onResize} role="separator" aria-orientation="vertical" aria-label="Resize panels" />
        <div className="sidebar-toolbar">
          <div className="search-field"><SearchIcon size={14} /><input ref={searchInputRef} placeholder={t('sessions.searchPlaceholder')} value={query} onChange={(event) => onQueryChange(event.target.value)} className="search" /></div>
          <button onClick={onRefresh} className="btn-secondary" disabled={refreshing} aria-label={t('sessions.refresh')} title={t('sessions.refresh')}>
            {refreshing ? <LoadingIcon size={16} /> : <RefreshIcon size={16} />}
          </button>
          {TASK_LAUNCH_ENABLED && <button onClick={() => setShowTaskLaunch(true)} className={taskEnabled ? "btn-primary" : "btn-secondary"} disabled={!taskEnabled} aria-label={t('task.new')} title={taskTitle}>
            {taskAvailability === "checking" && !offline ? <LoadingIcon size={16} /> : <PlayIcon size={16} />}
          </button>}
          <button onClick={onNewSession} className={taskEnabled ? "btn-secondary" : "btn-primary"} disabled={creating || offline} aria-label={t('sessions.new')} title={offline ? t('sessions.offlineHint') : t('sessions.new')}>
            {creating ? <LoadingIcon size={16} /> : <PlusIcon size={16} />}
          </button>
        </div>
        <div className="sidebar-sessions" ref={sidebarSessionsRef} onScroll={onScroll}>
          {groups.length === 0 ? <p className="subtle sidebar-empty">{offline ? t('sessions.offlineHint') : t('sessions.emptyTitle')}</p> : groups.map((group) => (
            <section key={group.directory} className="sidebar-group">
              <div className="sidebar-group-label" title={group.directory}><FolderIcon size={12} /><span>{projectLabel(group.directory)}</span><span className="sidebar-group-count">{group.sessions.length}</span></div>
              {group.sessions.map((session) => <SessionCard key={session.id} session={session} {...sessionCardProps} />)}
            </section>
          ))}
        </div>
        {jumpControls}
        <div className="sidebar-footer">
          <button type="button" className="btn-secondary" onClick={onShowHelp} title={t('nav.help')}><HelpIcon size={18} /><span className="sidebar-footer-label">{t('nav.help')}</span></button>
          <button type="button" className="btn-secondary" onClick={onShowSettings} title={t('nav.settings')}><SettingsIcon size={18} /><span className="sidebar-footer-label">{t('nav.settings')}</span></button>
        </div>
      </aside>
      {showTaskLaunch && <TaskLaunchDialog t={t} onClose={() => setShowTaskLaunch(false)} onLaunched={onRefresh} />}
    </>
  )
}

export function SessionsPanel({
  sessions,
  filteredSessions,
  activeSessions,
  changedSessions,
  query,
  refreshing,
  creating,
  offline,
  connectionState,
  connectionStatusText,
  eventStreamState,
  eventStreamText,
  runtimeError,
  t,
  onQueryChange,
  onRefresh,
  onNewSession,
  onShowSettings,
  jumpControls,
  sessionCardProps
}: {
  sessions: SessionView[]
  filteredSessions: SessionView[]
  activeSessions: number
  changedSessions: number
  query: string
  refreshing: boolean
  creating: boolean
  offline: boolean
  connectionState: string
  connectionStatusText: string
  eventStreamState: string
  eventStreamText: string
  runtimeError: string | null
  t: Translator
  onQueryChange: (value: string) => void
  onRefresh: () => void
  onNewSession: () => void
  onShowSettings: () => void
  jumpControls: ReactNode
  sessionCardProps: SessionCardProps
}) {
  const [showTaskLaunch, setShowTaskLaunch] = useState(false)
  const taskAvailability = useTaskLaunchAvailability(offline)
  // New Task stays out of sight until a task is at least as capable as the session it wraps.
  // Promoting the weaker path is how a feature gets judged before it is ready; the flag is here
  // rather than deleted so turning it on is one edit and one release note.
  const taskEnabled = TASK_LAUNCH_ENABLED && !offline && taskAvailability === "available"
  const taskTitle = offline ? t('sessions.offlineHint') : taskEnabled ? t('task.new') : t('task.requiresDaemon')
  return (
    <>
      <section className="panel sessions fade-in">
        <div className="section-heading">
          <div>
            <h2>{t('sessions.title')}</h2>
            <p className="subtle">{t('sessions.summary', { total: sessions.length, active: activeSessions, changed: changedSessions })}</p>
            {(connectionStatusText || eventStreamText) && <div className="connection-status-row">
              {connectionStatusText && <p className={`connection-status ${connectionState}`}>{['connecting', 'reconnecting'].includes(connectionState) && <LoadingIcon size={14} />}{connectionStatusText}</p>}
              {eventStreamText && <p className={`connection-status event-stream ${eventStreamState}`}>{['connecting', 'reconnecting'].includes(eventStreamState) && <LoadingIcon size={14} />}{eventStreamText}</p>}
            </div>}
          </div>
          <div className="inline-actions sessions-header-actions">
            <button onClick={onRefresh} className="btn-secondary sessions-action-compact" disabled={refreshing} aria-label={t('sessions.refresh')} title={t('sessions.refresh')}>{refreshing ? <LoadingIcon size={18} /> : <RefreshIcon size={18} />}<span className="sessions-action-label">{t('sessions.refresh')}</span></button>
            {TASK_LAUNCH_ENABLED && <button onClick={() => setShowTaskLaunch(true)} className={taskEnabled ? "btn-primary" : "btn-secondary"} disabled={!taskEnabled} title={taskTitle}>{taskAvailability === "checking" && !offline ? <LoadingIcon size={18} /> : <PlayIcon size={18} />}<span className="sessions-action-label">{t('task.new')}</span><span className="sessions-action-label-short">{t('task.newShort')}</span></button>}
            <button onClick={onNewSession} className={taskEnabled ? "btn-secondary" : "btn-primary"} disabled={creating || offline} title={offline ? t('sessions.offlineHint') : undefined}>{creating ? <LoadingIcon size={18} /> : <PlusIcon size={18} />}<span className="sessions-action-label">{creating ? t('sessions.creating') : t('sessions.new')}</span><span className="sessions-action-label-short">{creating ? t('sessions.creating') : t('sessions.newShort')}</span></button>
          </div>
        </div>
        <div className="toolbar"><input placeholder={t('sessions.searchPlaceholder')} value={query} onChange={(event) => onQueryChange(event.target.value)} className="search" /></div>
        <div className="session-list">
          {filteredSessions.length === 0 && offline ? <div className="empty-state"><OfflineIcon size={44} className="icon-empty-state" /><p>{t('sessions.offlineHint')}</p><div className="empty-state-actions"><button type="button" className="btn-primary" onClick={onRefresh} disabled={refreshing}>{refreshing ? <LoadingIcon size={18} /> : <RefreshIcon size={18} />}{t('sessions.retry')}</button><button type="button" className="btn-secondary" onClick={onShowSettings}><SettingsIcon size={18} />{t('nav.settings')}</button></div></div>
            : filteredSessions.length === 0 && ['connecting', 'reconnecting'].includes(connectionState) ? <div className="empty-state connection-pending"><LoadingIcon size={40} className="icon-empty-state" /><p>{t('sessions.loadingTitle')}</p><p className="subtle">{t('sessions.loadingHint')}</p></div>
            : filteredSessions.length === 0 ? <div className="empty-state"><FolderIcon size={48} className="icon-empty-state" /><p>{t('sessions.emptyTitle')}</p><p className="subtle">{t('sessions.emptyHint')}</p></div>
            : filteredSessions.map((session) => <SessionCard key={session.id} session={session} {...sessionCardProps} />)}
        </div>
        {runtimeError && !(offline && filteredSessions.length === 0) && <div className="error fade-in">✗ {runtimeError}</div>}
        {jumpControls}
      </section>
      {showTaskLaunch && <TaskLaunchDialog t={t} onClose={() => setShowTaskLaunch(false)} onLaunched={onRefresh} />}
    </>
  )
}
