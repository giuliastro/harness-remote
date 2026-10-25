import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { listMachineProjects, type MachineProject } from "../machineClient"
import { canCreateNativeSession, createNativeSessionTarget } from "../native-session-create"
import {
  discoverAgentNativeSessionPageSkippingEmpty,
  nativeSessionSurfaceTarget,
  selectReadyNativeSessionSources,
  type NativeSessionRecord,
  type NativeSessionSurfaceTarget
} from "../native-session-discovery"
import {
  matchesFederatedSessionQuery,
  projectFederatedSession,
  type FederatedSessionBucket
} from "../native-session-federation"
import {
  federatedMoreStatesLabel,
  federatedOperationalStateLabel,
  type FederatedOperationalBucket
} from "../native-session-federation-labels"
import type { MachineAgentHost, MachineSnapshot } from "../types"
import { nativeSessionDisplayTitle } from "../native-session-title"
import { countVisibleFinishedKeys, nextFinishedKeys, withoutFinishedKey, type SessionRailState } from "../native-session-unseen"
import { useLanguage, useTranslator } from "../useTranslator"
import type { Translator } from "../i18n"
import type { WorkspaceMachine } from "../workspaceMachines"
import { AgentIcon, ChatIcon, ChevronDownIcon, FolderIcon, LoadingIcon, PlusIcon, SearchIcon, ServerIcon } from "../Icons"
import "../native-session-home.css"
import "../native-session-home-ux.css"
import { harnessIconUrl } from "../harness-icons"
import { activeSkin, APP_PREFERENCES_CHANGED_EVENT, loadHideRules, loadRecentsEnabled, titleMatchesHideRules } from "../appPreferences"

type Source = {
  machine: WorkspaceMachine
  snapshot: MachineSnapshot | null
  state: "loading" | "online" | "offline"
  error?: string
}

type RecordWithMachine = {
  machine: WorkspaceMachine
  /** Canonical daemon identity. WorkspaceMachine.id only identifies the saved connection locally. */
  machineID: string
  record: NativeSessionRecord
  project?: MachineProject
}

/** Sessions shown in each machine's "Recent" group: the ones used last, across every Project. */
const RECENT_GROUP_SIZE = 8
/**
 * The agent filter holds an agent id (the shared harness select) or, from a Mahurley logo,
 * `backend:<name>`, which spans every machine running that backend.
 */
const BACKEND_FILTER_PREFIX = "backend:"
function backendFilterValue(backend: string): string {
  return `${BACKEND_FILTER_PREFIX}${backend}`
}
function isBackendFilter(filter: string): boolean {
  return filter.startsWith(BACKEND_FILTER_PREFIX)
}
function matchesAgentFilter(filter: string, agentId: string, backend: string): boolean {
  return isBackendFilter(filter) ? backend === filter.slice(BACKEND_FILTER_PREFIX.length) : agentId === filter
}
/** Mahurley skin: coding-agent logos shown beside the status tabs before the rest collapse into "+N". */
const FILTER_AGENT_LIMIT = 4

type ProjectGroup = {
  key: string
  machine: WorkspaceMachine
  name: string
  directory: string
  sessions: RecordWithMachine[]
  updatedAt: number
  /** The machine's "Recent" group rather than a Project. */
  recent?: boolean
}

type CreateMachine = {
  machine: WorkspaceMachine
  snapshot: MachineSnapshot
  label: string
}

type CreateProject = {
  key: string
  machine: WorkspaceMachine
  snapshot: MachineSnapshot
  project: MachineProject
}

export type CursorPageState<T> = {
  records: T[]
  firstPageCursor?: string
  nextCursor?: string
  loadedOlder: boolean
}

type AgentPageCache = CursorPageState<RecordWithMachine> & {
  machine: WorkspaceMachine
  machineID: string
  agent: MachineAgentHost
  projects: MachineProject[]
  /** Later pages scanned to find a match for the current rail filters. */
  olderProbePages?: Array<{ records: RecordWithMachine[]; nextCursor?: string }>
  olderProbeCursor?: string
}

type SessionPresentationState = "working" | "attention" | "stopped" | "ready"

type Props = {
  attentionInbox?: ReactNode
  sources: Source[]
  onOpen: (target: NativeSessionSurfaceTarget) => void
  /** Bumped by the shell after a native mutation (rename/delete) so the list re-reads its Sessions
   * immediately instead of waiting for its own refresh cycle. */
  refreshToken?: number
  /** Bumped only for an explicit user refresh. Successful first-page reads are authoritative for
   * those harness scopes so externally deleted Sessions can be pruned without making automatic
   * lifecycle refreshes destructive. */
  authoritativeRefreshToken?: number
  /** The rail already counts Sessions needing input; the mobile nav needs that count outside it. */
  onAttentionCountChange?: (count: number) => void
  /** Finished Sessions the user has not opened since, for the window title. */
  onUnseenReadyCountChange?: (count: number) => void
  /** Structured pending permission/question identities from the global attention index. */
  attentionSessionKeys?: ReadonlySet<string>
  /** Exposes the currently scoped attention identities so the Inbox wrapper can union counts. */
  onAttentionKeysChange?: (keys: ReadonlySet<string>) => void
  selectedKey?: string
  /** False when the selected Session is not on screen (phone list view); it then keeps its unseen mark. */
  selectionOnScreen?: boolean
  selectedState?: SessionPresentationState
  /** Fires when native Session discovery has settled at least once for the current machines. */
  onDiscoveredChange?: (discovered: boolean) => void
  /** Confirms that a shell-requested Session-index refresh has settled. */
  onRefreshComplete?: (refreshToken: number) => void
  /** Session keys whose delete transition is still visible, including the in-flight request. */
  deletingKeys?: ReadonlySet<string>
  /** Successful deletes suppressed from cached pages even when an older page cannot be re-read. */
  deletedKeys?: ReadonlySet<string>
  /** Called once a fresh discovery proves a deleting Session has disappeared from the native index. */
  onDeletionSettled?: (key: string) => void
}

const SESSION_HOME_REFRESH_MS = 30_000
const COLLAPSED_PROJECT_SESSION_COUNT = 5
type SessionFilter = "all" | FederatedSessionBucket


function sessionWorking(record: NativeSessionRecord): boolean {
  const value = record.status?.type?.trim().toLowerCase() || ""
  return value === "busy"
    || value === "running"
    || value === "working"
    || value === "waiting"
    || value === "retry"
    || value === "in_progress"
    || value === "in-progress"
}

function sessionPresentation(record: NativeSessionRecord, t: Translator): { state: SessionPresentationState; label: string } {
  const value = record.status?.type?.trim().toLowerCase() || ""
  if (value.includes("error") || value.includes("fail") || value.includes("attention")) {
    return { state: "attention", label: t("sf.statusAttention") }
  }
  if (value === "retry") return { state: "working", label: t("sf.statusRetrying") }
  if (value === "waiting") return { state: "working", label: t("sf.statusWaiting") }
  if (sessionWorking(record)) return { state: "working", label: t("sf.statusWorking") }
  return { state: "ready", label: t("sf.statusReady") }
}

function presentationLabel(state: SessionPresentationState, t: Translator): string {
  return state === "working"
    ? t("sf.statusWorking")
    : state === "attention"
      ? t("sf.statusAttention")
      : state === "stopped"
        ? t("sf.statusStopped")
        : t("sf.statusReady")
}


function recordKey(item: RecordWithMachine): string {
  return `${item.machineID}:${item.record.key}`
}

function pageScopeKey(machineID: string, agentID: string): string {
  return `${machineID}\u0000${agentID}`
}

function uniqueSessionRecords(records: RecordWithMachine[]): RecordWithMachine[] {
  const unique = new Map<string, RecordWithMachine>()
  for (const item of records) unique.set(recordKey(item), item)
  return [...unique.values()]
}

function uniquePageRecords<T>(records: T[], key: (record: T) => string): T[] {
  const unique = new Map<string, T>()
  for (const record of records) unique.set(key(record), record)
  return [...unique.values()]
}

/** Overlay a fresh first page without losing rows that moved across its boundary after older pages
 * were loaded. Before pagination begins, a refresh remains an exact replacement. */
export function refreshCursorPage<T>(
  current: CursorPageState<T> | undefined,
  records: T[],
  nextCursor: string | undefined,
  key: (record: T) => string
): CursorPageState<T> {
  const loadedOlder = current?.loadedOlder === true
  return {
    records: uniquePageRecords([...(loadedOlder ? current.records : []), ...records], key),
    firstPageCursor: nextCursor,
    nextCursor: loadedOlder ? current?.nextCursor : nextCursor,
    loadedOlder
  }
}

/** Add one explicitly requested older page and advance only that cursor chain. */
export function appendCursorPage<T>(
  current: CursorPageState<T>,
  records: T[],
  nextCursor: string | undefined,
  key: (record: T) => string
): CursorPageState<T> {
  return {
    ...current,
    records: uniquePageRecords([...current.records, ...records], key),
    nextCursor,
    loadedOlder: true
  }
}

export function sameCursorPageLineage<T>(
  current: Pick<CursorPageState<T>, "firstPageCursor" | "nextCursor"> | undefined,
  refreshed: Pick<CursorPageState<T>, "firstPageCursor" | "nextCursor">
): boolean {
  return Boolean(current)
    && current?.firstPageCursor === refreshed.firstPageCursor
    && current?.nextCursor === refreshed.nextCursor
}

/** Return the first cached older page containing a record that survives the active filters. */
export function firstMatchingOlderPage<T>(pages: Array<{ records: T[] }>, matches: (record: T) => boolean): number {
  return pages.findIndex((page) => page.records.some(matches))
}

function sessionActivityCompare(left: RecordWithMachine, right: RecordWithMachine): number {
  const updated = (right.record.session.time?.updated || right.record.session.time?.created || 0)
    - (left.record.session.time?.updated || left.record.session.time?.created || 0)
  if (updated) return updated
  const created = (right.record.session.time?.created || 0) - (left.record.session.time?.created || 0)
  if (created) return created
  const machine = left.machine.id.localeCompare(right.machine.id)
  if (machine) return machine
  return left.record.key.localeCompare(right.record.key)
}

function visualProjectKey(item: RecordWithMachine): string {
  const nativeDirectory = item.record.session.directory || ""
  return item.project
    ? `${item.machine.id}\u0000project:${item.project.id}`
    : `${item.machine.id}\u0000directory:${nativeDirectory}`
}

/**
 * Reconcile native truth into the rail without using changing harness timestamps as layout
 * coordinates. Existing rows keep their relative positions; genuinely new rows may enter at the
 * front, while explicit older-page loads append. A native first-page read is allowed to omit a row
 * transiently (active writer, pagination boundary, adapter lag), so callers may retain missing rows
 * while the same machine+harness source still exists. Explicit local deletes always win.
 */
export function reconcileStableSessionRecords(
  previous: RecordWithMachine[],
  fresh: RecordWithMachine[],
  {
    deletedKeys,
    keepMissing,
    newPosition = "front"
  }: {
    deletedKeys?: ReadonlySet<string>
    keepMissing?: (record: RecordWithMachine) => boolean
    newPosition?: "front" | "back"
  } = {}
): RecordWithMachine[] {
  const freshByKey = new Map<string, RecordWithMachine>()
  for (const item of fresh) {
    const key = recordKey(item)
    if (!deletedKeys?.has(key)) freshByKey.set(key, item)
  }

  const retained: RecordWithMachine[] = []
  for (const prior of previous) {
    const key = recordKey(prior)
    if (deletedKeys?.has(key)) continue
    const current = freshByKey.get(key)
    if (current) {
      retained.push(current)
      freshByKey.delete(key)
      continue
    }
    if (keepMissing?.(prior)) retained.push(prior)
  }

  const newcomers = [...freshByKey.values()].sort(sessionActivityCompare)
  if (previous.length === 0) return newcomers
  if (newPosition === "back") return [...retained, ...newcomers]

  // New activity belongs at the front of its existing Project, not at the front of the whole rail.
  // Otherwise creating or discovering a Session in Project B makes Project B jump above Project A.
  // Truly new Projects may enter at the front because no existing visual anchor is displaced.
  const result = [...retained]
  const newcomerGroups = new Map<string, RecordWithMachine[]>()
  for (const item of newcomers) {
    const key = visualProjectKey(item)
    newcomerGroups.set(key, [...(newcomerGroups.get(key) || []), item])
  }
  const newProjectRecords: RecordWithMachine[] = []
  for (const [projectKey, projectNewcomers] of newcomerGroups) {
    const existingIndex = result.findIndex((item) => visualProjectKey(item) === projectKey)
    if (existingIndex >= 0) result.splice(existingIndex, 0, ...projectNewcomers)
    else newProjectRecords.push(...projectNewcomers)
  }
  return [...newProjectRecords, ...result]
}

function relativeTime(timestamp: number): string {
  if (!timestamp) return ""
  const delta = Math.max(0, Date.now() - timestamp)
  if (delta < 60_000) return "now"
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))}m`
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h`
  return `${Math.round(delta / 86_400_000)}d`
}

function fallbackProjectName(record: NativeSessionRecord): string {
  const explicit = record.session.project?.name?.trim()
  if (explicit) return explicit
  const parts = record.session.directory.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || record.session.directory || "Ungrouped"
}

function normalizedPath(value: string): { value: string; caseInsensitive: boolean } {
  let normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "")
  if (!normalized) normalized = "/"
  const caseInsensitive = /^[A-Za-z]:\//.test(normalized)
  if (caseInsensitive) normalized = normalized.toLowerCase()
  return { value: normalized, caseInsensitive }
}

function pathContains(projectPath: string, sessionDirectory: string): boolean {
  if (!projectPath || !sessionDirectory) return false
  const project = normalizedPath(projectPath)
  const session = normalizedPath(sessionDirectory)
  let root = project.value
  let candidate = session.value
  if (project.caseInsensitive || session.caseInsensitive) {
    root = root.toLowerCase()
    candidate = candidate.toLowerCase()
  }
  return candidate === root || candidate.startsWith(root === "/" ? "/" : `${root}/`)
}

function catalogProject(record: NativeSessionRecord, projects: MachineProject[], machineID: string): MachineProject | undefined {
  const directory = record.session.directory || ""
  if (!directory) return undefined
  return projects
    .filter((project) => project.machineId === machineID && pathContains(project.path, directory))
    .sort((left, right) => normalizedPath(right.path).value.length - normalizedPath(left.path).value.length)[0]
}

/** True when any segment of the path is hidden (".claude/worktrees", ".codex-…"). */
function hasHiddenSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..")
}

/**
 * Compact skin's New Session Project list: the catalog plus the folders the user actually has
 * Sessions in (only inside a configured root, so the daemon accepts them), hidden folders left out,
 * ordered by last use with the chosen agent, then last use overall, then name.
 */
function projectsByRecentUse(catalog: MachineProject[], records: RecordWithMachine[], machineID: string, agentID: string): MachineProject[] {
  const roots = catalog.filter((project) => project.configured)
  const members = catalog.filter((project) => !project.configured)
  const extra = new Map<string, MachineProject>()
  const lastUse = new Map<string, number>()
  const lastUseWithAgent = new Map<string, number>()
  for (const item of records) {
    const directory = item.record.session.directory || item.project?.path || ""
    if (!directory || hasHiddenSegment(directory)) continue
    const member = members
      .filter((project) => pathContains(project.path, directory))
      .sort((left, right) => right.path.length - left.path.length)[0]
    let key: string
    if (member) {
      key = member.id
    } else {
      const root = roots.find((project) => pathContains(project.path, directory))
      if (!root) continue
      if (normalizedPath(root.path).value === normalizedPath(directory).value) {
        key = root.id
      } else {
        key = `session-dir:${normalizedPath(directory).value}`
        if (!extra.has(key)) {
          extra.set(key, {
            id: key,
            machineId: machineID,
            name: directory.split(/[\\/]+/).filter(Boolean).pop() || directory,
            path: directory,
            kind: "directory"
          })
        }
      }
    }
    const at = item.record.session.time?.updated || item.record.session.time?.created || 0
    lastUse.set(key, Math.max(lastUse.get(key) || 0, at))
    if (item.record.agentId === agentID) lastUseWithAgent.set(key, Math.max(lastUseWithAgent.get(key) || 0, at))
  }
  return [...catalog, ...extra.values()]
    .filter((project) => !project.name.startsWith(".") && !hasHiddenSegment(project.path))
    .sort((left, right) =>
      (lastUseWithAgent.get(right.id) || 0) - (lastUseWithAgent.get(left.id) || 0)
      || (lastUse.get(right.id) || 0) - (lastUse.get(left.id) || 0)
      || left.name.localeCompare(right.name))
}

function projectGroups(records: RecordWithMachine[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>()
  for (const item of records) {
    const nativeDirectory = item.record.session.directory || ""
    const project = item.project
    const directory = project?.path || nativeDirectory
    const key = project
      ? `${item.machine.id}\u0000project:${project.id}`
      : `${item.machine.id}\u0000directory:${nativeDirectory}`
    const updatedAt = item.record.session.time?.updated || item.record.session.time?.created || 0
    const existing = groups.get(key)
    if (existing) {
      existing.sessions.push(item)
      existing.updatedAt = Math.max(existing.updatedAt, updatedAt)
      continue
    }
    groups.set(key, {
      key,
      machine: item.machine,
      name: project?.name || fallbackProjectName(item.record),
      directory,
      sessions: [item],
      updatedAt
    })
  }

  // Records are already reconciled into a stable visual order. Preserve that order inside each
  // Project and preserve first appearance as Project order; native timestamps remain metadata only.
  return [...groups.values()]
}

export function sessionTreeRows(sessions: RecordWithMachine[]): Array<{ item: RecordWithMachine; depth: number }> {
  const byID = new Map(sessions.map((item) => [item.record.session.id, item]))
  const children = new Map<string, RecordWithMachine[]>()
  const roots: RecordWithMachine[] = []
  for (const item of sessions) {
    const parentID = item.record.session.parentID
    if (!parentID || parentID === item.record.session.id || !byID.has(parentID)) {
      roots.push(item)
      continue
    }
    children.set(parentID, [...(children.get(parentID) || []), item])
  }

  const rows: Array<{ item: RecordWithMachine; depth: number }> = []
  const visited = new Set<string>()
  const visit = (item: RecordWithMachine, depth: number) => {
    if (visited.has(item.record.session.id)) return
    visited.add(item.record.session.id)
    rows.push({ item, depth })
    for (const child of children.get(item.record.session.id) || []) visit(child, depth + 1)
  }
  for (const root of roots) visit(root, 0)
  // Corrupt or cyclic parent metadata must not hide a native Session.
  for (const item of sessions) visit(item, 0)
  return rows
}

function nativeCreateAgents(snapshot: MachineSnapshot): MachineAgentHost[] {
  return snapshot.agents.filter(canCreateNativeSession)
}

export function NativeSessionHome({
  attentionInbox,
  sources,
  onOpen,
  refreshToken = 0,
  authoritativeRefreshToken = 0,
  onAttentionCountChange,
  onUnseenReadyCountChange,
  attentionSessionKeys,
  onAttentionKeysChange,
  onDiscoveredChange,
  onRefreshComplete,
  selectedKey: selectedKeyProp,
  selectionOnScreen = true,
  selectedState,
  deletingKeys,
  deletedKeys,
  onDeletionSettled
}: Props) {
  // A Session counts as open only while it is on screen: on a phone, back on the list it is not,
  // so its unseen mark ("Just finished") must survive until it is opened again.
  const selectedKey = selectionOnScreen ? selectedKeyProp : undefined
  const t = useTranslator()
  const language = useLanguage()
  const [records, setRecords] = useState<RecordWithMachine[]>([])
  const [projectsByMachine, setProjectsByMachine] = useState<Record<string, MachineProject[]>>({})
  const [loading, setLoading] = useState(false)
  const [loadedSignature, setLoadedSignature] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set())
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set())
  // Compact skin: every Project group (Recent included) starts folded; this holds the ones opened.
  const [openedProjects, setOpenedProjects] = useState<Set<string>>(() => new Set())
  const [collapsedMachines, setCollapsedMachines] = useState<Set<string>>(() => new Set())
  const [createOpen, setCreateOpen] = useState(false)
  const [createMachineID, setCreateMachineID] = useState("")
  const [createProjectKey, setCreateProjectKey] = useState("")
  const [createAgentID, setCreateAgentID] = useState("")
  const [createTitle, setCreateTitle] = useState("")
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [loadingOlderMachines, setLoadingOlderMachines] = useState<ReadonlySet<string>>(() => new Set())
  const [probingOlderMachines, setProbingOlderMachines] = useState<ReadonlySet<string>>(() => new Set())
  const olderRequests = useRef(new Set<string>())
  const [olderSessionErrors, setOlderSessionErrors] = useState<Record<string, string | undefined>>({})
  const [query, setQuery] = useState("")
  // Compact skin: search and filters open from a magnifier in the top bar, and New Session is a
  // "+" beside it. Both render into a slot the top bar provides; without the slot nothing moves.
  const [searchOpen, setSearchOpen] = useState(false)
  // The coding agents available across every online machine, one logo each. A logo filters by
  // backend (`backend:<name>`), not by one agent id: two machines can run the same backend under
  // different agent ids, and the first machine's id would hide the second machine's Sessions.
  const onlineAgents = useMemo(() => {
    const seen = new Map<string, { backend: string; label: string }>()
    for (const source of sources) {
      if (source.state !== "online") continue
      for (const agent of source.snapshot?.agents ?? []) {
        if (agent.state === "unavailable" || seen.has(agent.backend)) continue
        seen.set(agent.backend, { backend: agent.backend, label: agent.label })
      }
    }
    return [...seen.values()]
  }, [sources])
  const [recentsEnabled, setRecentsEnabled] = useState(loadRecentsEnabled)
  const [compactSkin, setCompactSkin] = useState(() => activeSkin() === "compact")
  const [hideRules, setHideRules] = useState(loadHideRules)
  const [showHidden, setShowHidden] = useState(false)
  useEffect(() => {
    const sync = () => {
      setRecentsEnabled(loadRecentsEnabled())
      setCompactSkin(activeSkin() === "compact")
      setHideRules(loadHideRules())
    }
    window.addEventListener(APP_PREFERENCES_CHANGED_EVENT, sync)
    return () => window.removeEventListener(APP_PREFERENCES_CHANGED_EVENT, sync)
  }, [])
  const [topbarSlot, setTopbarSlot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setTopbarSlot(document.getElementById("hr-topbar-home-slot"))
  }, [])
  useEffect(() => {
    if (!searchOpen) return
    document.querySelector<HTMLInputElement>(".hr-native-home-tools.search-open input[type=search]")?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSearchOpen(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [searchOpen])
  const [filter, setFilter] = useState<SessionFilter>("all")
  const [machineFilter, setMachineFilter] = useState("")
  const [agentFilter, setAgentFilter] = useState("")
  // More agents than fit beside the status tabs at phone width: show three, keep the filtered one
  // visible, and let "+N" open the rest on a row of their own.
  const [agentsExpanded, setAgentsExpanded] = useState(false)
  const visibleFilterAgents = useMemo(() => {
    if (agentsExpanded || onlineAgents.length <= FILTER_AGENT_LIMIT) return onlineAgents
    const shown = onlineAgents.slice(0, FILTER_AGENT_LIMIT - 1)
    const filtered = onlineAgents.find((agent) => backendFilterValue(agent.backend) === agentFilter)
    if (filtered && !shown.includes(filtered)) shown[shown.length - 1] = filtered
    return shown
  }, [agentFilter, agentsExpanded, onlineAgents])
  const hiddenFilterAgentCount = onlineAgents.length - visibleFilterAgents.length
  const [projectFilter, setProjectFilter] = useState("")
  const [modelFilter, setModelFilter] = useState("")
  const homeScrollRef = useRef<HTMLDivElement | null>(null)
  const selectedRowRef = useRef<HTMLButtonElement | null>(null)
  const pageCache = useRef<Map<string, AgentPageCache>>(new Map())
  const pageCacheSignature = useRef<string | null>(null)
  const deletedKeysRef = useRef(deletedKeys)
  deletedKeysRef.current = deletedKeys
  const authoritativeRefreshApplied = useRef(authoritativeRefreshToken)
  const onRefreshCompleteRef = useRef(onRefreshComplete)
  onRefreshCompleteRef.current = onRefreshComplete
  const [presentationOverrides, setPresentationOverrides] = useState<Record<string, SessionPresentationState>>({})

  const { ready: discoveryReady, sources: readySources } = selectReadyNativeSessionSources(sources)
  const machineSignature = sources.map(({ machine, snapshot, state }) =>
    [
      machine.id,
      machine.config.host,
      machine.config.port,
      machine.config.username,
      machine.config.password,
      machine.config.agentId || "",
      snapshot?.machine.id || state,
      snapshot?.agents.map((agent) => `${agent.id}:${agent.backend}:${agent.transport}:${agent.processID ?? ""}:${agent.state}`).join(",") || ""
    ].join(":")
  ).join("|")
  // Agent lifecycle (a lazy ACP start, a process exit or restart, a machine probe flapping) changes
  // the signature above all the time on a perfectly healthy machine. That must re-read the Sessions,
  // but it is not a different set of machines: treating it as one sent the rail and the workspace back
  // to their first-load state ("Loading Sessions" in the workspace), hid the counts and disabled the
  // open Session until the read finished. Only a changed endpoint is a new first load.
  const endpointSignature = sources.map(({ machine }) =>
    [
      machine.id,
      machine.config.host,
      machine.config.port,
      machine.config.username,
      machine.config.password,
      machine.config.agentId || ""
    ].join(":")
  ).join("|")
  const loaded = discoveryReady && loadedSignature === endpointSignature
  // Whether the read for the current snapshot has landed. Only used where showing stale emptiness
  // would be wrong (e.g. "No Sessions on this machine" for a machine that just came back).
  const [currentSignature, setCurrentSignature] = useState<string | null>(null)
  const snapshotLoaded = loaded && currentSignature === machineSignature

  useEffect(() => {
    if (!loaded || loading || !deletingKeys?.size || !onDeletionSettled) return
    const visibleKeys = new Set(records.map(recordKey))
    for (const key of deletingKeys) {
      if (!visibleKeys.has(key)) onDeletionSettled(key)
    }
  }, [loaded, loading, records, deletingKeys, onDeletionSettled])

  useEffect(() => {
    if (!selectedKey || !selectedState) return
    setPresentationOverrides((current) => current[selectedKey] === selectedState
      ? current
      : { ...current, [selectedKey]: selectedState })
  }, [selectedKey, selectedState])

  useEffect(() => {
    if (machineFilter && !sources.some(({ machine }) => machine.id === machineFilter)) setMachineFilter("")
  }, [machineFilter, sources])

  useEffect(() => {
    if (!sources.length) {
      pageCache.current.clear()
      pageCacheSignature.current = machineSignature
      setRecords([])
      setProjectsByMachine({})
      setPresentationOverrides({})
      setOlderSessionErrors({})
      setLoadedSignature(endpointSignature)
      setCurrentSignature(machineSignature)
      setLoading(false)
      onRefreshCompleteRef.current?.(refreshToken)
      return
    }
    if (!discoveryReady) {
      setLoading(true)
      setDiscoveryError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setDiscoveryError(null)
    setOlderSessionErrors({})
    const authoritativeRefresh = authoritativeRefreshToken !== authoritativeRefreshApplied.current
    void Promise.all(readySources.map(async ({ machine, snapshot }) => {
      if (!snapshot) return { machine, snapshot, projects: [] as MachineProject[], pages: [] }
      const [pages, projects] = await Promise.all([
        Promise.all(snapshot.agents.map(async (agent) => ({
          agent,
          page: await discoverAgentNativeSessionPageSkippingEmpty(machine.config, agent).catch(() => null)
        }))),
        listMachineProjects(machine.config).catch(() => [] as MachineProject[])
      ])
      return { machine, snapshot, projects, pages }
    })).then((results) => {
      if (cancelled) return
      const loadingMachineIDs = new Set(sources.filter(({ state }) => state === "loading").map(({ machine }) => machine.id))
      setProjectsByMachine((current) => Object.fromEntries([
        ...Object.entries(current).filter(([machineID]) => loadingMachineIDs.has(machineID)),
        ...results.map((result) => [result.machine.id, result.projects])
      ]))
      // Unlike `loaded`, the page cache follows the agent processes: ACP cursors are bound to the
      // connection that issued them. The visible rows survive through the reconciliation below.
      if (pageCacheSignature.current !== machineSignature) pageCache.current.clear()
      pageCacheSignature.current = machineSignature
      const activeScopes = new Set<string>()
      const authoritativeScopes = new Set<string>()
      // Keep previously loaded rows for a source whose next connection probe has not settled yet.
      for (const source of sources) {
        if (source.state !== "loading" || !source.snapshot) continue
        for (const agent of source.snapshot.agents) {
          activeScopes.add(pageScopeKey(source.machine.id, agent.id))
        }
      }
      for (const result of results) {
        if (!result.snapshot) continue
        for (const { agent, page } of result.pages) {
          const scope = pageScopeKey(result.machine.id, agent.id)
          activeScopes.add(scope)
          const existing = pageCache.current.get(scope)
          if (!page) continue
          if (authoritativeRefresh) authoritativeScopes.add(scope)
          const firstRecords = page.records.map((record) => ({
            machine: result.machine,
            machineID: result.snapshot!.machine.id,
            record,
            project: catalogProject(record, result.projects, result.snapshot!.machine.id)
          }))
          const refreshed = refreshCursorPage(authoritativeRefresh ? undefined : existing, firstRecords, page.nextCursor, recordKey)
          const preserveProbeCache = !authoritativeRefresh && sameCursorPageLineage(existing, refreshed)
          const recordsForScope = uniqueSessionRecords(refreshed.records)
            .filter((item) => !deletedKeysRef.current?.has(recordKey(item)))
          pageCache.current.set(scope, {
            machine: result.machine,
            machineID: result.snapshot.machine.id,
            agent,
            projects: result.projects,
            records: recordsForScope,
            firstPageCursor: refreshed.firstPageCursor,
            nextCursor: refreshed.nextCursor,
            loadedOlder: refreshed.loadedOlder,
            ...(preserveProbeCache ? {
              olderProbePages: existing?.olderProbePages,
              olderProbeCursor: existing?.olderProbeCursor
            } : {})
          })
        }
      }
      for (const scope of pageCache.current.keys()) {
        if (!activeScopes.has(scope)) pageCache.current.delete(scope)
      }
      setPresentationOverrides({})
      const freshRecords = uniqueSessionRecords([...pageCache.current.values()].flatMap((entry) => entry.records))
      setRecords((current) => reconcileStableSessionRecords(current, freshRecords, {
        deletedKeys: deletedKeysRef.current,
        keepMissing: (item) => {
          const scope = pageScopeKey(item.machine.id, item.record.agentId)
          return activeScopes.has(scope) && (!authoritativeRefresh || !authoritativeScopes.has(scope))
        }
      }))
      if (authoritativeRefresh) authoritativeRefreshApplied.current = authoritativeRefreshToken
      setLoadedSignature(endpointSignature)
      setCurrentSignature(machineSignature)
    }).catch((reason) => {
      if (!cancelled) {
        setLoadedSignature(endpointSignature)
        setCurrentSignature(machineSignature)
        setDiscoveryError(reason instanceof Error ? reason.message : String(reason))
      }
    }).finally(() => {
      if (!cancelled) {
        setLoading(false)
        onRefreshCompleteRef.current?.(refreshToken)
      }
    })
    return () => { cancelled = true }
  }, [sources, revision, refreshToken, authoritativeRefreshToken, discoveryReady, machineSignature, endpointSignature, deletedKeys])

  useEffect(() => {
    if (!loaded || document.visibilityState !== "visible") return
    const timer = window.setInterval(() => setRevision((value) => value + 1), SESSION_HOME_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [loaded])

  const liveStateForItem = useCallback((item: RecordWithMachine): SessionPresentationState | undefined => {
    const targetKey = recordKey(item)
    if (attentionSessionKeys?.has(targetKey)) return "attention"
    return targetKey === selectedKey && selectedState
      ? selectedState
      : presentationOverrides[targetKey]
  }, [attentionSessionKeys, presentationOverrides, selectedKey, selectedState])

  const presentationForItem = useCallback((item: RecordWithMachine) => {
    const liveState = liveStateForItem(item)
    if (liveState) return { state: liveState, label: presentationLabel(liveState, t) }
    return sessionPresentation(item.record, t)
  }, [liveStateForItem, t])

  // A Session the rail sees finish stays marked until it is clicked (see native-session-unseen.ts).
  // The open one is in front of the user already, so any sign of them clears it instead.
  const [finishedKeys, setFinishedKeys] = useState<ReadonlySet<string>>(() => new Set())
  const railStatesRef = useRef<ReadonlyMap<string, SessionRailState>>(new Map())

  useEffect(() => {
    const current = new Map(records.map((item) => [recordKey(item), presentationForItem(item).state]))
    const previous = railStatesRef.current
    railStatesRef.current = current
    setFinishedKeys((finished) => nextFinishedKeys(finished, previous, current))
  }, [records, presentationForItem])

  const clearFinished = useCallback((key: string) => {
    setFinishedKeys((finished) => withoutFinishedKey(finished, key))
  }, [])

  // Opening a Session from anywhere else - a link, the search, a notification - also counts.
  useEffect(() => {
    if (selectedKey) clearFinished(selectedKey)
  }, [selectedKey, clearFinished])

  // The open Session's mark lasts until the first click, key, scroll or mouse movement on the page
  // after it finished - not until a click on its own row. One that finished while the window was in
  // the background therefore stays marked until the user is back.
  const selectedFinished = Boolean(selectedKey && finishedKeys.has(selectedKey))
  useEffect(() => {
    if (!selectedKey || !selectedFinished) return
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const
    const acknowledge = () => {
      if (document.visibilityState === "visible") clearFinished(selectedKey)
    }
    for (const type of events) window.addEventListener(type, acknowledge, { capture: true, passive: true })
    return () => {
      for (const type of events) window.removeEventListener(type, acknowledge, { capture: true })
    }
  }, [selectedKey, selectedFinished, clearFinished])


  const unseenKeys = useMemo<ReadonlySet<string>>(() => deletingKeys?.size
    ? new Set([...finishedKeys].filter((key) => !deletingKeys.has(key)))
    : finishedKeys, [finishedKeys, deletingKeys])

  const projectionForItem = useCallback((item: RecordWithMachine) => projectFederatedSession({
    machineID: item.machineID,
    machineName: item.machine.name,
    agentID: item.record.agentId,
    agentLabel: item.record.agentLabel,
    session: item.record.session,
    projectName: item.project?.name,
    projectPath: item.project?.path
  }, liveStateForItem(item)), [liveStateForItem])

  // Compact skin: Sessions whose title matches a hide pattern (helper agents, reviewers, bots) leave
  // the list, its counters and Recent unless the user asks to see them.
  const hideActive = compactSkin && hideRules.enabled && hideRules.rules.length > 0
  const hiddenKeys = useMemo(() => hideActive
    ? new Set(records.filter((item) => titleMatchesHideRules(item.record.session.title || "", hideRules.rules)).map(recordKey))
    : new Set<string>(), [hideActive, hideRules.rules, records])
  const shownRecords = useMemo(
    () => hiddenKeys.size && !showHidden ? records.filter((item) => !hiddenKeys.has(recordKey(item))) : records,
    [hiddenKeys, records, showHidden]
  )
  const hiddenCount = hiddenKeys.size
  // Hidden Sessions keep their unseen mark in `unseenKeys` for when they are shown again; only
  // the published count (window title / global counter) excludes them while they are hidden.
  const visibleUnseenCount = useMemo(
    () => countVisibleFinishedKeys(unseenKeys, hiddenKeys, showHidden),
    [hiddenKeys, showHidden, unseenKeys]
  )
  useEffect(() => {
    onUnseenReadyCountChange?.(visibleUnseenCount)
  }, [onUnseenReadyCountChange, visibleUnseenCount])

  const groups = useMemo(() => projectGroups(shownRecords), [shownRecords])

  useEffect(() => {
    if (!selectedKey) return
    const selectedGroup = groups.find((group) =>
      group.sessions.some((item) => recordKey(item) === selectedKey)
    )
    if (!selectedGroup) return
    setCollapsedProjects((current) => {
      if (!current.has(selectedGroup.key)) return current
      const next = new Set(current)
      next.delete(selectedGroup.key)
      return next
    })
    setOpenedProjects((current) => {
      if (current.has(selectedGroup.key)) return current
      const next = new Set(current)
      next.add(selectedGroup.key)
      return next
    })
    setCollapsedMachines((current) => {
      if (!current.has(selectedGroup.machine.id)) return current
      const next = new Set(current)
      next.delete(selectedGroup.machine.id)
      return next
    })
    const selectedIndex = sessionTreeRows(selectedGroup.sessions)
      .findIndex(({ item }) => recordKey(item) === selectedKey)
    if (selectedIndex >= COLLAPSED_PROJECT_SESSION_COUNT) {
      setExpandedProjects((current) => {
        if (current.has(selectedGroup.key)) return current
        const next = new Set(current)
        next.add(selectedGroup.key)
        return next
      })
    }
  }, [groups, selectedKey])

  useEffect(() => {
    if (!selectedKey) return
    const frame = window.requestAnimationFrame(() => {
      selectedRowRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [expandedProjects, selectedKey])

  const machineChoices = useMemo(() => sources.map(({ machine, snapshot }) => ({
    id: machine.id,
    label: snapshot?.machine.name || machine.name,
    count: shownRecords.filter((item) => item.machine.id === machine.id).length
  })), [shownRecords, sources])

  const machineScopedRecords = useMemo(
    () => machineFilter ? shownRecords.filter((item) => item.machine.id === machineFilter) : shownRecords,
    [machineFilter, shownRecords]
  )

  const agentChoices = useMemo(() => {
    const choices = new Map<string, { id: string; label: string; count: number }>()
    for (const item of machineScopedRecords) {
      const existing = choices.get(item.record.agentId)
      if (existing) existing.count += 1
      else choices.set(item.record.agentId, {
        id: item.record.agentId,
        label: item.record.agentLabel,
        count: 1
      })
    }
    return [...choices.values()].sort((left, right) => left.label.localeCompare(right.label))
  }, [machineScopedRecords])

  useEffect(() => {
    if (agentFilter && !isBackendFilter(agentFilter) && !agentChoices.some((choice) => choice.id === agentFilter)) setAgentFilter("")
  }, [agentChoices, agentFilter])

  const agentScopedRecords = useMemo(
    () => agentFilter ? machineScopedRecords.filter((item) => matchesAgentFilter(agentFilter, item.record.agentId, item.record.backend)) : machineScopedRecords,
    [agentFilter, machineScopedRecords]
  )

  const projectChoices = useMemo(() => {
    const choices = new Map<string, { id: string; label: string; count: number }>()
    for (const item of agentScopedRecords) {
      const projection = projectionForItem(item)
      const existing = choices.get(projection.projectKey)
      if (existing) existing.count += 1
      else choices.set(projection.projectKey, {
        id: projection.projectKey,
        label: sources.length > 1 ? `${projection.projectLabel} · ${item.machine.name}` : projection.projectLabel,
        count: 1
      })
    }
    return [...choices.values()].sort((left, right) => left.label.localeCompare(right.label))
  }, [agentScopedRecords, projectionForItem, sources.length])

  useEffect(() => {
    if (projectFilter && !projectChoices.some((choice) => choice.id === projectFilter)) setProjectFilter("")
  }, [projectChoices, projectFilter])

  const projectScopedRecords = useMemo(
    () => projectFilter
      ? agentScopedRecords.filter((item) => projectionForItem(item).projectKey === projectFilter)
      : agentScopedRecords,
    [agentScopedRecords, projectFilter, projectionForItem]
  )

  const modelChoices = useMemo(() => {
    const choices = new Map<string, { id: string; label: string; count: number }>()
    for (const item of projectScopedRecords) {
      const projection = projectionForItem(item)
      if (!projection.modelKey) continue
      const existing = choices.get(projection.modelKey)
      if (existing) existing.count += 1
      else choices.set(projection.modelKey, {
        id: projection.modelKey,
        label: projection.modelLabel,
        count: 1
      })
    }
    return [...choices.values()].sort((left, right) => left.label.localeCompare(right.label))
  }, [projectScopedRecords, projectionForItem])

  useEffect(() => {
    if (modelFilter && !modelChoices.some((choice) => choice.id === modelFilter)) setModelFilter("")
  }, [modelChoices, modelFilter])

  const scopedRecords = useMemo(
    () => modelFilter
      ? projectScopedRecords.filter((item) => projectionForItem(item).modelKey === modelFilter)
      : projectScopedRecords,
    [modelFilter, projectScopedRecords, projectionForItem]
  )

  const bucketCounts = useMemo(() => {
    const counts: Record<FederatedSessionBucket, number> = {
      active: 0,
      attention: 0,
      failed: 0,
      completed: 0,
      recent: 0
    }
    for (const item of scopedRecords) counts[projectionForItem(item).bucket] += 1
    return counts
  }, [projectionForItem, scopedRecords])
  const activeCount = bucketCounts.active
  const attentionKeys = useMemo<ReadonlySet<string>>(() => new Set(
    scopedRecords
      .filter((item) => projectionForItem(item).bucket === "attention")
      .map(recordKey)
  ), [projectionForItem, scopedRecords])
  const attentionCount = attentionKeys.size
  const operationalFilter: FederatedOperationalBucket | "" =
    filter === "failed" || filter === "completed" || filter === "recent" ? filter : ""
  const showOperationalFilter = bucketCounts.failed + bucketCounts.completed + bucketCounts.recent > 0 || Boolean(operationalFilter)

  // Machine and agent filters are already guaranteed by each cursor's discovery scope. Only
  // content filters need to inspect later pages to know whether a matching Session exists.
  const hasSessionFilters = Boolean(query.trim() || projectFilter || modelFilter || filter !== "all")
  const matchesActiveFilters = (item: RecordWithMachine) => {
    if (deletedKeysRef.current?.has(recordKey(item))) return false
    const projection = projectionForItem(item)
    if (machineFilter && item.machine.id !== machineFilter) return false
    if (agentFilter && !matchesAgentFilter(agentFilter, item.record.agentId, item.record.backend)) return false
    if (projectFilter && projection.projectKey !== projectFilter) return false
    if (modelFilter && projection.modelKey !== modelFilter) return false
    if (filter !== "all" && projection.bucket !== filter) return false
    return matchesFederatedSessionQuery(projection, query)
  }
  const machineHasMatchingOlderPage = (machineID: string) => [...pageCache.current.values()].some((entry) =>
    entry.machine.id === machineID
    && firstMatchingOlderPage(entry.olderProbePages || [], matchesActiveFilters) >= 0
  )
  const machineHasScopedOlderCursor = (machineID: string) => [...pageCache.current.values()].some((entry) =>
    entry.machine.id === machineID
    && entry.nextCursor
    && (!agentFilter || matchesAgentFilter(agentFilter, entry.agent.id, entry.agent.backend))
  )

  useEffect(() => {
    onAttentionCountChange?.(attentionCount)
    onAttentionKeysChange?.(attentionKeys)
  }, [attentionCount, attentionKeys, onAttentionCountChange, onAttentionKeysChange])

  useEffect(() => {
    onDiscoveredChange?.(loaded)
  }, [loaded, onDiscoveredChange])

  const filteredGroups = useMemo(() => groups.flatMap((group) => {
    const sessions = group.sessions.filter((item) => {
      const projection = projectionForItem(item)
      if (machineFilter && item.machine.id !== machineFilter) return false
      if (agentFilter && !matchesAgentFilter(agentFilter, item.record.agentId, item.record.backend)) return false
      if (projectFilter && projection.projectKey !== projectFilter) return false
      if (modelFilter && projection.modelKey !== modelFilter) return false
      if (filter !== "all" && projection.bucket !== filter) return false
      return matchesFederatedSessionQuery(projection, query)
    })
    return sessions.length ? [{ ...group, sessions }] : []
  }), [agentFilter, filter, groups, machineFilter, modelFilter, projectFilter, projectionForItem, query])

  const machineGroups = useMemo(() => sources
    .filter(({ machine }) => !machineFilter || machine.id === machineFilter)
    .flatMap(({ machine, snapshot, state, error }) => {
      const machineProjects = filteredGroups.filter((group) => group.machine.id === machine.id)
      // Compact skin: the folders being worked on come first.
      const projects = compactSkin ? [...machineProjects].sort((left, right) => right.updatedAt - left.updatedAt) : machineProjects
      const filtering = Boolean(query.trim() || agentFilter || projectFilter || modelFilter || filter !== "all" || machineFilter)
      if (!projects.length && filtering && !machineHasMatchingOlderPage(machine.id)
        && !(!hasSessionFilters && machineHasScopedOlderCursor(machine.id))) return []
      // While searching or filtering the Recent group would only repeat the results below it.
      const recent = compactSkin && recentsEnabled && !filtering
        ? projects
          .flatMap((group) => group.sessions)
          .map((item) => ({ item, at: item.record.session.time?.updated || item.record.session.time?.created || 0 }))
          .sort((left, right) => right.at - left.at)
          .slice(0, RECENT_GROUP_SIZE)
        : []
      const recentGroup: ProjectGroup | null = recent.length
        ? { key: `${machine.id}\u0000recent`, machine, name: t("sf.recentGroup"), directory: "", sessions: recent.map(({ item }) => item), updatedAt: recent[0].at, recent: true }
        : null
      return [{
        machine,
        label: snapshot?.machine.name || machine.name,
        state,
        error,
        projects: recentGroup ? [recentGroup, ...projects] : projects,
        sessionCount: projects.reduce((count, group) => count + group.sessions.length, 0),
        workingCount: projects.reduce((count, group) =>
          count + group.sessions.filter((item) => projectionForItem(item).bucket === "active").length, 0),
        attentionCount: projects.reduce((count, group) =>
          count + group.sessions.filter((item) => projectionForItem(item).bucket === "attention").length, 0),
        unseenCount: projects.reduce((count, group) =>
          count + group.sessions.filter((item) => unseenKeys.has(recordKey(item))).length, 0),
        updatedAt: projects.reduce((latest, group) => Math.max(latest, group.updatedAt), 0)
      }]
    }), [agentFilter, compactSkin, filter, filteredGroups, machineFilter, modelFilter, projectFilter, projectionForItem, query, recentsEnabled, sources, t, unseenKeys, probingOlderMachines])

  useEffect(() => {
    if (!hasSessionFilters) {
      setProbingOlderMachines(new Set())
      return
    }
    let cancelled = false
    const entries = [...pageCache.current.entries()].filter(([, entry]) =>
      entry.nextCursor
      && (!machineFilter || entry.machine.id === machineFilter)
      && (!agentFilter || matchesAgentFilter(agentFilter, entry.agent.id, entry.agent.backend))
    )
    setProbingOlderMachines(new Set(entries.map(([, entry]) => entry.machine.id)))
    void Promise.all(entries.map(async ([scope, entry]) => {
      let pages = entry.olderProbePages || []
      let cursor = entry.olderProbeCursor ?? (pages.length ? pages[pages.length - 1].nextCursor : entry.nextCursor)
      if (firstMatchingOlderPage(pages, matchesActiveFilters) >= 0) return
      while (cursor && !cancelled) {
        try {
          const page = await discoverAgentNativeSessionPageSkippingEmpty(entry.machine.config, entry.agent, cursor)
          if (page.nextCursor === cursor) throw new Error("Session listing returned the same pagination cursor twice.")
          const records = page.records.map((record) => ({
            machine: entry.machine,
            machineID: entry.machineID,
            record,
            project: catalogProject(record, entry.projects, entry.machineID)
          }))
          pages = [...pages, { records, nextCursor: page.nextCursor }]
          cursor = page.nextCursor
          if (records.some(matchesActiveFilters)) break
        } catch {
          break
        }
      }
      if (cancelled) return
      const current = pageCache.current.get(scope)
      if (current && current.nextCursor === entry.nextCursor) {
        current.olderProbePages = pages
        current.olderProbeCursor = cursor
      }
    })).finally(() => {
      if (!cancelled) setProbingOlderMachines(new Set())
    })
    return () => { cancelled = true }
  }, [agentFilter, filter, hasSessionFilters, machineFilter, modelFilter, projectFilter, projectionForItem, query, records])

  const olderPageTargets = [...pageCache.current.entries()].filter(([, entry]) =>
    (hasSessionFilters
      ? firstMatchingOlderPage(entry.olderProbePages || [], matchesActiveFilters) >= 0
      : Boolean(entry.nextCursor))
    && (!machineFilter || entry.machine.id === machineFilter)
    && (!agentFilter || matchesAgentFilter(agentFilter, entry.agent.id, entry.agent.backend))
  )

  async function loadOlderSessions(machineID: string) {
    const targets = olderPageTargets.filter(([, entry]) => entry.machine.id === machineID)
    if (olderRequests.current.has(machineID) || targets.length === 0) return
    olderRequests.current.add(machineID)
    setLoadingOlderMachines(new Set(olderRequests.current))
    setOlderSessionErrors((current) => ({ ...current, [machineID]: undefined }))
    const outcomes = await Promise.all(targets.map(async ([scope, entry]) => {
      if (hasSessionFilters) {
        const pages = entry.olderProbePages || []
        const matchIndex = firstMatchingOlderPage(pages, matchesActiveFilters)
        if (matchIndex < 0) return { ok: false as const, scope, cursor: entry.nextCursor!, error: "No matching older Sessions were found." }
        const revealedPages = pages.slice(0, matchIndex + 1)
        return {
          ok: true as const,
          scope,
          cursor: entry.nextCursor!,
          page: { nextCursor: revealedPages[revealedPages.length - 1].nextCursor },
          records: revealedPages.flatMap((page) => page.records)
        }
      }
      const cursor = entry.nextCursor!
      try {
        const page = await discoverAgentNativeSessionPageSkippingEmpty(entry.machine.config, entry.agent, cursor)
        if (page.nextCursor === cursor) throw new Error("Session listing returned the same pagination cursor twice.")
        const records = page.records.map((record) => ({
          machine: entry.machine,
          machineID: entry.machineID,
          record,
          project: catalogProject(record, entry.projects, entry.machineID)
        }))
        return { ok: true as const, scope, cursor, page, records }
      } catch (error) {
        return { ok: false as const, scope, cursor, error: error instanceof Error ? error.message : String(error) }
      }
    }))

    let firstError: string | null = null
    for (const outcome of outcomes) {
      const current = pageCache.current.get(outcome.scope)
      if (!current || current.nextCursor !== outcome.cursor) continue
      if (!outcome.ok) {
        firstError ??= outcome.error
        continue
      }
      const appended = appendCursorPage(current, outcome.records, outcome.page.nextCursor, recordKey)
      pageCache.current.set(outcome.scope, {
        ...current,
        ...appended,
        records: uniqueSessionRecords(appended.records)
          .filter((item) => !deletedKeysRef.current?.has(recordKey(item))),
        olderProbePages: undefined,
        olderProbeCursor: undefined
      })
    }
    const freshRecords = uniqueSessionRecords([...pageCache.current.values()].flatMap((entry) => entry.records))
    const activeScopes = new Set(sources.flatMap(({ machine, snapshot }) =>
      snapshot ? snapshot.agents.map((agent) => pageScopeKey(machine.id, agent.id)) : []
    ))
    setRecords((current) => reconcileStableSessionRecords(current, freshRecords, {
      deletedKeys: deletedKeysRef.current,
      keepMissing: (item) => activeScopes.has(pageScopeKey(item.machine.id, item.record.agentId)),
      newPosition: "back"
    }))
    setOlderSessionErrors((current) => ({ ...current, [machineID]: firstError || undefined }))
    olderRequests.current.delete(machineID)
    setLoadingOlderMachines(new Set(olderRequests.current))
  }

  const createMachines = useMemo<CreateMachine[]>(() => sources.flatMap(({ machine, snapshot, state, error }) =>
    snapshot && state === "online" && !error
      ? [{ machine, snapshot, label: snapshot.machine.name || machine.name }]
      : []
  ), [sources])
  const selectedCreateMachine = createMachines.find(({ machine }) => machine.id === createMachineID) || createMachines[0]
  const createProjects = useMemo<CreateProject[]>(() => {
    if (!selectedCreateMachine) return []
    const machineID = selectedCreateMachine.machine.id
    const catalog = projectsByMachine[machineID] || []
    const projects = compactSkin ? projectsByRecentUse(catalog, records.filter((item) => item.machine.id === machineID), machineID, createAgentID) : catalog
    return projects.map((project) => ({
      key: `${machineID}:${project.id}`,
      machine: selectedCreateMachine.machine,
      snapshot: selectedCreateMachine.snapshot,
      project
    }))
  }, [compactSkin, createAgentID, projectsByMachine, records, selectedCreateMachine])
  // Compact skin: until the Project is picked by hand, the default follows the chosen agent.
  const createProjectTouched = useRef(false)
  useEffect(() => {
    if (!createOpen) createProjectTouched.current = false
  }, [createOpen])
  useEffect(() => {
    if (!createOpen || !compactSkin || createProjectTouched.current) return
    setCreateProjectKey(createProjects[0]?.key || "")
    // Only an agent change should move the default; list refreshes keep the current choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createAgentID, createOpen, compactSkin])
  const selectedCreateProject = createProjects.find((choice) => choice.key === createProjectKey) || createProjects[0]
  const createAgents = selectedCreateMachine ? nativeCreateAgents(selectedCreateMachine.snapshot) : []
  const selectedCreateAgent = createAgents.find((agent) => agent.id === createAgentID) || createAgents[0]

  useEffect(() => {
    if (!createOpen) return
    if (!createMachines.some(({ machine }) => machine.id === createMachineID)) {
      setCreateMachineID(createMachines[0]?.machine.id || "")
    }
  }, [createMachineID, createMachines, createOpen])

  useEffect(() => {
    if (!createOpen) return
    if (!createProjects.some((choice) => choice.key === createProjectKey)) setCreateProjectKey(createProjects[0]?.key || "")
  }, [createOpen, createProjectKey, createProjects])

  useEffect(() => {
    if (!createOpen) return
    const available = selectedCreateMachine ? nativeCreateAgents(selectedCreateMachine.snapshot) : []
    if (!available.some((agent) => agent.id === createAgentID)) setCreateAgentID(available[0]?.id || "")
  }, [createAgentID, createOpen, selectedCreateMachine])

  function open(item: RecordWithMachine) {
    onOpen(nativeSessionSurfaceTarget(item.machineID, item.machine.config, item.record, liveStateForItem(item)))
  }

  function toggleProject(groupKey: string) {
    setExpandedProjects((current) => {
      const next = new Set(current)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      return next
    })
  }

  function toggleProjectCollapsed(groupKey: string) {
    const setter = compactSkin ? setOpenedProjects : setCollapsedProjects
    setter((current) => {
      const next = new Set(current)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      return next
    })
  }

  function toggleMachineCollapsed(machineID: string) {
    setCollapsedMachines((current) => {
      const next = new Set(current)
      if (next.has(machineID)) next.delete(machineID)
      else next.add(machineID)
      return next
    })
  }

  function openCreatePanel() {
    if (!loaded || createMachines.length === 0) return
    const selectedRecord = records.find((item) => recordKey(item) === selectedKey)
    const preferredMachineID = createMachines.some(({ machine }) => machine.id === machineFilter)
      ? machineFilter
      : selectedRecord && createMachines.some(({ machine }) => machine.id === selectedRecord.machine.id)
        ? selectedRecord.machine.id
        : createMachines[0]?.machine.id || ""
    setCreateMachineID(preferredMachineID)
    setCreateProjectKey("")
    setCreateAgentID("")
    setCreateError(null)
    setCreateOpen(true)
    // The creation form is at the start of the scroll area, below the fixed navigation controls.
    homeScrollRef.current?.scrollTo({ top: 0 })
  }

  async function createSession() {
    if (creating || !selectedCreateMachine || !selectedCreateProject || !selectedCreateAgent) return
    setCreating(true)
    setCreateError(null)
    try {
      const { target, record } = await createNativeSessionTarget({
        machineID: selectedCreateMachine.snapshot.machine.id,
        baseConfig: selectedCreateMachine.machine.config,
        agent: selectedCreateAgent,
        directory: selectedCreateProject.project.path,
        title: createTitle
      })
      const createdRecord = {
        machine: selectedCreateMachine.machine,
        machineID: selectedCreateMachine.snapshot.machine.id,
        record,
        project: selectedCreateProject.project
      }
      const scope = pageScopeKey(selectedCreateMachine.machine.id, selectedCreateAgent.id)
      const cached = pageCache.current.get(scope)
      if (cached) {
        pageCache.current.set(scope, {
          ...cached,
          records: uniqueSessionRecords([...cached.records, createdRecord])
        })
      }
      setRecords((current) => reconcileStableSessionRecords(
        current,
        [
          ...current.filter((item) => !(item.machine.id === selectedCreateMachine.machine.id && item.record.key === record.key)),
          createdRecord
        ],
        { keepMissing: () => true }
      ))
      setCreateTitle("")
      setCreateOpen(false)
      onOpen(target)
      setRevision((value) => value + 1)
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className="hr-native-home" aria-label="Sessions" aria-busy={!loaded || undefined}>
      {topbarSlot ? createPortal(
        <>
          {records.length > 0 ? (
            <button
              type="button"
              className={`tdw-icon-button hr-topbar-search hr-topbar-home-action${searchOpen || query ? " active" : ""}`}
              onClick={() => setSearchOpen((open) => !open)}
              aria-label={t("sf.searchSessionsLabel")}
              aria-expanded={searchOpen}
              title={t("sf.searchSessionsLabel")}
            >
              <SearchIcon size={16} />
            </button>
          ) : null}
          <button
            type="button"
            className="tdw-icon-button hr-topbar-new-session hr-topbar-home-action"
            onClick={openCreatePanel}
            aria-label={t("sf.newSession")}
            title={t("sf.newSession")}
            disabled={!loaded || createMachines.length === 0}
          >
            <PlusIcon size={18} />
          </button>
        </>,
        topbarSlot
      ) : null}
      {searchOpen ? <button type="button" className="hr-native-search-backdrop" aria-label={t("action.close")} onClick={() => setSearchOpen(false)} /> : null}
      <div className="hr-native-home-controls">
        <div className="hr-native-home-heading">
          <div>
            <h2>{t("nav.sessions")}</h2>
            {loaded ? <span>{activeCount
                ? t("sf.workingShown", { working: activeCount, shown: scopedRecords.length })
                : t("sf.recentCount", { count: scopedRecords.length })}</span> : null}
          </div>
          <div className="hr-native-home-actions">
            <button
              type="button"
              className="tdw-button primary hr-native-new-session"
              onClick={openCreatePanel}
              aria-label={t("sf.newSession")}
              disabled={!loaded || createMachines.length === 0}
            >
              <PlusIcon size={15} /> <span>{t("sf.newSession")}</span>
            </button>
          </div>
        </div>


        {records.length > 0 ? (
          <div className={`hr-native-home-tools${searchOpen ? " search-open" : ""}`}>
            <label className="hr-native-session-search">
              <SearchIcon size={14} />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("sf.searchSessions")}
                aria-label={t("sf.searchSessionsLabel")}
              />
            </label>
            {hiddenCount ? (
              <button type="button" className={`hr-native-hidden-toggle${showHidden ? " active" : ""}`} onClick={() => setShowHidden((value) => !value)} aria-pressed={showHidden}>
                {showHidden ? t("sf.hideHidden", { count: hiddenCount }) : t("sf.showHidden", { count: hiddenCount })}
              </button>
            ) : null}
            <div className="hr-native-session-filters" role="group" aria-label={t("sf.filterSessions")}>
              <button type="button" className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")} aria-pressed={filter === "all"}>
                <i className="hr-filter-icon all" aria-hidden="true" /><span>{t("sf.filterAll")}</span> <b>{scopedRecords.length}</b>
              </button>
              <button type="button" className={filter === "active" ? "active" : ""} onClick={() => setFilter("active")} aria-pressed={filter === "active"}>
                <i className="hr-filter-icon live" aria-hidden="true" /><span>{t("sf.filterLive")}</span> <b>{activeCount}</b>
              </button>
              <button type="button" className={filter === "attention" ? "active" : ""} onClick={() => setFilter("attention")} aria-pressed={filter === "attention"}>
                <i className={`hr-filter-icon attention${attentionCount ? " alert" : ""}`} aria-hidden="true" /><span>{t("sf.filterAttention")}</span> <b>{attentionCount}</b>
              </button>
              {onlineAgents.length ? (
                <span className={`hr-filter-agents${agentFilter ? " filtering" : ""}${agentsExpanded ? " expanded" : ""}`} role="group" aria-label={t("sf.filterByAgent")}>
                  {visibleFilterAgents.map((agent, index) => {
                    const selected = agentFilter === backendFilterValue(agent.backend)
                    return (
                      <button
                        type="button"
                        key={agent.backend}
                        className={selected ? "selected" : undefined}
                        style={{ animationDelay: `${index * 0.35}s` }}
                        onClick={() => setAgentFilter(selected ? "" : backendFilterValue(agent.backend))}
                        aria-pressed={selected}
                        aria-label={agent.label}
                        title={agent.label}
                      >
                        {harnessIconUrl(agent.backend)
                          ? <img src={harnessIconUrl(agent.backend)} alt="" />
                          : <b>{agent.label.slice(0, 2).toUpperCase()}</b>}
                      </button>
                    )
                  })}
                  {hiddenFilterAgentCount || agentsExpanded ? (
                    <button
                      type="button"
                      className="hr-filter-agents-more"
                      onClick={() => setAgentsExpanded((open) => !open)}
                      aria-expanded={agentsExpanded}
                      aria-label={agentsExpanded ? t("sf.showFewerAgents") : t("sf.showAllAgents", { count: onlineAgents.length })}
                    >
                      {agentsExpanded ? "−" : `+${hiddenFilterAgentCount}`}
                    </button>
                  ) : null}
                </span>
              ) : null}
            </div>
            <div className="hr-native-session-scopes">
              {sources.length > 1 ? (
                <label className="hr-native-scope">
                  <ServerIcon size={13} />
                  <select value={machineFilter} onChange={(event) => setMachineFilter(event.target.value)} aria-label={t("sf.filterByMachine")}>
                    <option value="">{t("sf.allMachinesCount", { count: shownRecords.length })}</option>
                    {machineChoices.map((choice) => <option value={choice.id} key={choice.id}>{choice.label} · {choice.count}</option>)}
                  </select>
                  <ChevronDownIcon size={12} />
                </label>
              ) : null}
              <label className="hr-native-scope">
                <AgentIcon size={13} />
                <select value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)} aria-label={t("sf.filterByAgent")}>
                  <option value="">{t("sf.allHarnesses")}</option>
                  {agentChoices.map((choice) => <option value={choice.id} key={choice.id}>{choice.label} · {choice.count}</option>)}
                </select>
                <ChevronDownIcon size={12} />
              </label>
            </div>
            {projectChoices.length > 1 || modelChoices.length > 1 || projectFilter || modelFilter || showOperationalFilter ? (
              <div className="hr-native-session-scopes">
                {projectChoices.length > 1 || projectFilter ? (
                  <label className="hr-native-scope">
                    <FolderIcon size={13} />
                    <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} aria-label={t("sf.project")}>
                      <option value="">{t("sf.filterAll")} · {t("sf.project")}</option>
                      {projectChoices.map((choice) => <option value={choice.id} key={choice.id}>{choice.label} · {choice.count}</option>)}
                    </select>
                    <ChevronDownIcon size={12} />
                  </label>
                ) : null}
                {modelChoices.length > 1 || modelFilter ? (
                  <label className="hr-native-scope">
                    <ChatIcon size={13} />
                    <select value={modelFilter} onChange={(event) => setModelFilter(event.target.value)} aria-label={t("detail.modelTitle")}>
                      <option value="">{t("sf.filterAll")} · {t("detail.modelTitle")}</option>
                      {modelChoices.map((choice) => <option value={choice.id} key={choice.id}>{choice.label} · {choice.count}</option>)}
                    </select>
                    <ChevronDownIcon size={12} />
                  </label>
                ) : null}
                {showOperationalFilter ? (
                  <label className="hr-native-scope">
                    <ChatIcon size={13} />
                    <select
                      value={operationalFilter}
                      onChange={(event) => setFilter(event.target.value as FederatedOperationalBucket)}
                      aria-label={federatedMoreStatesLabel(language)}
                    >
                      <option value="" disabled>{federatedMoreStatesLabel(language)}</option>
                      <option value="failed">{federatedOperationalStateLabel("failed", language)} · {bucketCounts.failed}</option>
                      <option value="completed">{federatedOperationalStateLabel("completed", language)} · {bucketCounts.completed}</option>
                      <option value="recent">{federatedOperationalStateLabel("recent", language)} · {bucketCounts.recent}</option>
                    </select>
                    <ChevronDownIcon size={12} />
                  </label>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

      </div>
      <div className="hr-native-home-scroll" ref={homeScrollRef}>
        {createOpen ? <button type="button" className="hr-native-create-backdrop" aria-label={t("sf.closeNewSession")} onClick={() => !creating && setCreateOpen(false)} /> : null}
        {createOpen ? (
          <div className="hr-native-create-panel" role="group" aria-label={t("sf.createNativeSession")}>
            <div className="hr-native-create-heading">
              <div><strong>{t("sf.newSession")}</strong><small>{t("sf.newSessionSubtitle")}</small></div>
              <button type="button" className="tdw-icon-button" onClick={() => !creating && setCreateOpen(false)} disabled={creating} aria-label={t("sf.closeNewSession")}>×</button>
            </div>
            <label className="hr-native-create-machine">
              <span>{t("sf.machines")}</span>
              <select
                value={selectedCreateMachine?.machine.id || ""}
                onChange={(event) => {
                  setCreateMachineID(event.target.value)
                  setCreateProjectKey("")
                  setCreateAgentID("")
                  setCreateError(null)
                }}
                disabled={creating || createMachines.length === 0}
                aria-label={t("sf.filterByMachine")}
              >
                {createMachines.map(({ machine, label }) => <option value={machine.id} key={machine.id}>{label}</option>)}
              </select>
            </label>
            <label>
              <span>{t("sf.project")}</span>
              <select value={selectedCreateProject?.key || ""} onChange={(event) => { createProjectTouched.current = true; setCreateProjectKey(event.target.value); setCreateError(null) }} disabled={creating || createProjects.length === 0}>
                {createProjects.map((choice) => <option value={choice.key} key={choice.key}>{choice.project.name}</option>)}
              </select>
            </label>
            {compactSkin ? (
              <div className="hr-native-create-agents-field">
                <span>{t("sf.codingAgent")}</span>
                <div className="hr-create-agents" role="radiogroup" aria-label={t("sf.codingAgent")}>
                  {createAgents.map((agent, index) => {
                    const selected = agent.id === selectedCreateAgent?.id
                    return (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        key={agent.id}
                        className={selected ? "selected" : undefined}
                        style={{ animationDelay: `${index * 0.35}s` }}
                        disabled={creating}
                        onClick={() => { setCreateAgentID(agent.id); setCreateError(null) }}
                      >
                        <i>{harnessIconUrl(agent.backend) ? <img src={harnessIconUrl(agent.backend)} alt="" /> : <b>{(agent.label || agent.id).slice(0, 2).toUpperCase()}</b>}</i>
                        <small>{agent.label || agent.id}</small>
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : (
              <label>
                <span>{t("sf.codingAgent")}</span>
                <select value={selectedCreateAgent?.id || ""} onChange={(event) => { setCreateAgentID(event.target.value); setCreateError(null) }} disabled={creating || createAgents.length === 0}>
                  {createAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.label || agent.id}</option>)}
                </select>
              </label>
            )}
            <label className="hr-native-create-title">
              <span>{t("sf.title")} <small>{t("sf.optional")}</small></span>
              <input value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} disabled={creating} placeholder={t("sf.newAgentSession", { agent: selectedCreateAgent?.label || selectedCreateAgent?.id || "native" })} maxLength={200} />
            </label>
            {createMachines.length === 0 ? <div className="hr-native-create-error">{t("sf.machinesUnavailable")}</div> : null}
            {selectedCreateMachine && createProjects.length === 0 ? <div className="hr-native-create-error">{t("sf.noProjectAvailable")}</div> : null}
            {selectedCreateMachine && createAgents.length === 0 ? <div className="hr-native-create-error">{t("sf.noAgentCanCreate")}</div> : null}
            {createError ? <div className="hr-native-create-error" role="alert">{createError}</div> : null}
            <div className="hr-native-create-actions">
              <button type="button" className="tdw-button secondary" onClick={() => setCreateOpen(false)} disabled={creating}>{t("sf.cancel")}</button>
              <button type="button" className="tdw-button primary" onClick={() => void createSession()} disabled={creating || !selectedCreateMachine || !selectedCreateProject || !selectedCreateAgent}>
                {creating ? <LoadingIcon size={15} /> : <PlusIcon size={15} />}
                {creating ? t("sf.creating") : t("sf.createSession")}
              </button>
            </div>
          </div>
        ) : null}

        {attentionInbox}
        {discoveryError ? (
          <div className="hr-native-home-notice" role="alert">
            <span><strong>{t("sf.refreshFailed")}</strong> {t("sf.refreshFailedDetail")}</span>
            <button type="button" className="tdw-button secondary" onClick={() => setRevision((value) => value + 1)} disabled={loading}>{t("sf.retry")}</button>
          </div>
        ) : null}
        <div className="hr-native-machine-list">
          {machineGroups.map(({ machine, label, state, error, projects, sessionCount, workingCount, attentionCount: machineAttentionCount, unseenCount }) => {
            const machineCollapsed = collapsedMachines.has(machine.id)
            const loadingOlder = loadingOlderMachines.has(machine.id)
            const olderSessionError = olderSessionErrors[machine.id]
            // Empty pages are skipped within a bounded discovery read. If that budget runs out,
            // a remaining cursor still means unscanned history: keep manual continuation reachable
            // even when no rows have been found yet. A fully scanned empty machine has no cursor.
            const hasOlderSessions = state === "online"
              && !probingOlderMachines.has(machine.id)
              && olderPageTargets.some(([, entry]) => entry.machine.id === machine.id)
            const reconnecting = state === "online" && Boolean(error)
            return (
              <section className={`hr-native-machine-group ${state}${machineCollapsed ? " collapsed" : ""}`} key={machine.id} aria-label={t("sf.groupSessions", { name: label })}>
                <button
                  type="button"
                  className="hr-native-machine-heading"
                  onClick={() => toggleMachineCollapsed(machine.id)}
                  aria-expanded={!machineCollapsed}
                  aria-label={t(machineCollapsed ? "sf.expandGroup" : "sf.collapseGroup", { name: label })}
                >
                  <span className="hr-native-machine-identity">
                    <i data-state={state} aria-hidden="true" />
                    <span>
                      <strong>{label}</strong>
                      <small title={state === "offline" ? error || t("sf.machineOffline") : machine.config.host}>{state === "offline" ? error || t("sf.machineOffline") : machine.config.host}</small>
                    </span>
                  </span>
                  <span className="hr-native-machine-metrics">
                    {machineAttentionCount ? <b>{t("sf.attentionCount", { count: machineAttentionCount })}</b> : null}
                    {unseenCount ? <span className="hr-native-machine-ready">{t("sf.readyCount", { count: unseenCount })}</span> : null}
                    {workingCount ? <em>{t("sf.liveCount", { count: workingCount })}</em> : null}
                    <small>{state === "online" && loaded && !reconnecting ? sessionCount : state === "offline" ? t("sf.offline") : ""}</small>
                    <i className="hr-native-machine-chevron" aria-hidden="true"><ChevronDownIcon size={13} /></i>
                  </span>
                </button>
                {machineCollapsed ? null : (
                  <>
                    {projects.length === 0 && !hasOlderSessions && state !== "loading" && !(state === "online" && (!snapshotLoaded || reconnecting)) ? (
                      <div className="hr-native-machine-empty">
                        <ServerIcon size={15} />
                        <span>{state === "offline" ? t("sf.machineUnavailableSaved") : t("sf.noSessionsOnMachine")}</span>
                      </div>
                    ) : null}

                    {projects.map((group) => {
                      const expanded = expandedProjects.has(group.key)
                      const collapsed = compactSkin ? !openedProjects.has(group.key) : collapsedProjects.has(group.key)
                      const treeRows = sessionTreeRows(group.sessions)
                      const visibleRows = expanded ? treeRows : treeRows.slice(0, COLLAPSED_PROJECT_SESSION_COUNT)
                      const hiddenCount = Math.max(0, treeRows.length - COLLAPSED_PROJECT_SESSION_COUNT)
                      const projectUnseen = group.sessions.filter((item) => unseenKeys.has(recordKey(item))).length
                      const projectWorking = group.sessions.some((item) => projectionForItem(item).bucket === "active")
                      return (
                        <section className={`hr-native-project-group${collapsed ? " collapsed" : ""}${group.recent ? " recent" : ""}`} key={group.key} aria-label={t("sf.groupSessions", { name: group.name })}>
                          <button
                            type="button"
                            className="hr-native-project-heading"
                            onClick={() => toggleProjectCollapsed(group.key)}
                            aria-expanded={!collapsed}
                            aria-label={t(collapsed ? "sf.expandGroup" : "sf.collapseGroup", { name: group.name })}
                          >
                            <span>
                              <strong>{group.name}</strong>
                              <small title={group.directory}>{group.recent ? t("sf.recentGroupHint") : group.directory || t("sf.noWorkingDirectory")}</small>
                            </span>
                            <span>{projectWorking ? <i className="hr-native-project-live" aria-hidden="true" /> : null}{projectUnseen ? <em className="hr-native-project-ready" title={t("sf.readyCount", { count: projectUnseen })}>{projectUnseen}</em> : null}<b>{group.sessions.length}</b><i className="hr-native-project-chevron" aria-hidden="true"><ChevronDownIcon size={13} /></i></span>
                          </button>
                          {!collapsed ? (
                            <>
                              <div className="hr-native-home-list">
                                {visibleRows.map(({ item, depth }) => {
                                  const status = presentationForItem(item)
                                  const projection = projectionForItem(item)
                                  const operationalLabel = projection.bucket === "failed" || projection.bucket === "completed"
                                    ? federatedOperationalStateLabel(projection.bucket, language)
                                    : status.label
                                  const title = nativeSessionDisplayTitle(
                                    item.record.session.title,
                                    t("sf.untitledSession", { agent: item.record.agentLabel })
                                  )
                                  const normalizedTitle = title
                                  const accessibleTitle = normalizedTitle.length > 140 ? `${normalizedTitle.slice(0, 137)}…` : normalizedTitle
                                  const tooltipTitle = normalizedTitle.length > 240 ? `${normalizedTitle.slice(0, 237)}…` : normalizedTitle
                                  const timestamp = item.record.session.time?.updated || item.record.session.time?.created || 0
                                  const summary = item.record.session.summary
                                  const hasChanges = Boolean(summary && (summary.files || summary.additions || summary.deletions))
                                  const nativeAgent = item.record.session.agent?.trim()
                                  const restrictionCount = item.record.session.permission?.filter((rule) => rule.action === "deny").length || 0
                                  const icon = harnessIconUrl(item.record.backend)
                                  const targetKey = recordKey(item)
                                  const selected = targetKey === selectedKey
                                  const unseen = unseenKeys.has(targetKey)
                                  // Mahurley "Just finished" is the project's own unseen mark: set only when the rail
                                  // sees a turn end, cleared by opening the Session. No timestamp is involved, because a
                                  // harness can rewrite a transcript (titles, relocations) without a new turn.
                                  const rowState = compactSkin && status.state === "ready" && projection.bucket !== "failed" && unseen
                                    ? "fresh"
                                    : status.state
                                  const rowLabel = rowState === "fresh" ? t("sf.statusFresh") : operationalLabel
                                  const deleting = Boolean(deletingKeys?.has(targetKey))
                                  return (
                                    <button
                                      type="button"
                                      ref={selected ? selectedRowRef : undefined}
                                      className={`hr-native-session-row ${rowState}${selected ? " selected" : ""}${unseen ? " unseen" : ""}${deleting ? " deleting" : ""}${depth ? " child" : ""}`}
                                      data-depth={Math.min(depth, 3)}
                                      key={targetKey}
                                      onClick={() => {
                                        if (deleting) return
                                        clearFinished(targetKey)
                                        open(item)
                                      }}
                                      disabled={deleting}
                                      aria-busy={deleting || undefined}
                                      aria-current={selected ? "page" : undefined}
                                      aria-label={t("sf.openSessionAria", {
                                        title: accessibleTitle,
                                        agent: `${item.record.agentLabel}${nativeAgent ? ` · ${nativeAgent}` : ""}${restrictionCount ? ` · ${t("sf.restrictionsLabel", { count: restrictionCount })}` : ""}${depth ? ` · ${t("sf.childSession")}` : ""}`,
                                        status: deleting ? t("sf.deleting") : unseen ? `${operationalLabel} · ${t("sf.unseenResult")}` : operationalLabel,
                                        project: group.name,
                                        machine: group.machine.name
                                      })}
                                      title={tooltipTitle}
                                    >
                                      <span className="hr-native-session-harness" aria-hidden="true">
                                        {icon ? <img src={icon} alt="" /> : <b>{item.record.agentLabel.slice(0, 2).toUpperCase()}</b>}
                                        <i data-state={rowState} />
                                      </span>
                                      <span className="hr-native-session-copy">
                                        <strong>{title}</strong>
                                        <small>
                                          {compactSkin
                                            ? <span><span className="hr-native-session-agent-label">{item.record.agentLabel}</span>{nativeAgent ? <span className="hr-native-session-extra">{nativeAgent}</span> : null}{item.record.session.external === true ? <span className="hr-native-session-extra">{t("sf.external")}</span> : null}</span>
                                            : <span>{item.record.agentLabel}{nativeAgent ? ` · ${nativeAgent}` : ""}{item.record.session.external === true ? ` · ${t("sf.external")}` : ""}</span>}
                                          {restrictionCount ? <span className="hr-native-session-policy">{t("sf.restrictedCount", { count: restrictionCount })}</span> : null}
                                          {depth ? <span className="hr-native-session-child-label">{t("sf.childSession")}</span> : null}
                                          {hasChanges ? (
                                            <span className="hr-native-session-changes">
                                              <b>+{summary?.additions || 0}</b>
                                              <i>−{summary?.deletions || 0}</i>
                                              <em>{summary?.files || 0} file{summary?.files === 1 ? "" : "s"}</em>
                                            </span>
                                          ) : null}
                                        </small>
                                      </span>
                                      <span className="hr-native-session-meta">
                                        <span className="hr-native-session-status" data-state={deleting ? "deleting" : rowState} aria-live={selected || deleting ? "polite" : undefined}>
                                          {deleting ? <><LoadingIcon size={12} /> {t("sf.deleting")}</> : <>{unseen && rowState !== "fresh" ? "✓ " : ""}{rowLabel}</>}
                                        </span>
                                        {deleting ? null : (
                                          <time dateTime={timestamp ? new Date(timestamp).toISOString() : undefined} title={timestamp ? new Date(timestamp).toLocaleString() : undefined}>
                                            {relativeTime(timestamp)}
                                          </time>
                                        )}
                                      </span>
                                    </button>
                                  )
                                })}
                              </div>
                              {hiddenCount > 0 ? (
                                <button
                                  type="button"
                                  className="hr-native-project-more"
                                  onClick={() => toggleProject(group.key)}
                                  aria-expanded={expanded}
                                >
                                  <span>{expanded ? t("sf.showLess") : t("sf.showMore", { count: hiddenCount })}</span>
                                  <ChevronDownIcon size={14} className="hr-native-project-more-icon" />
                                </button>
                              ) : null}
                            </>
                          ) : null}
                        </section>
                      )
                    })}
                    {olderSessionError ? (
                      <div className="hr-native-home-notice" role="alert">
                        <span><strong>{t("sf.olderSessionsFailed")}</strong> {olderSessionError}</span>
                        <button type="button" className="tdw-button secondary" onClick={() => void loadOlderSessions(machine.id)} disabled={loading || loadingOlder}>{t("sf.retry")}</button>
                      </div>
                    ) : null}
                    {loaded && hasOlderSessions ? (
                      <div className="hr-native-home-pagination">
                        <button type="button" className="tdw-button secondary" onClick={() => void loadOlderSessions(machine.id)} disabled={loading || loadingOlder} aria-busy={loadingOlder}>
                          {loadingOlder ? <LoadingIcon size={14} /> : null}
                          {t(loadingOlder ? "sf.loadingOlderSessions" : "sf.loadOlderSessions")}
                        </button>
                      </div>
                    ) : null}
                  </>
                )}
              </section>
            )
          })}
        </div>

        {loaded && records.length > 0 && filteredGroups.length === 0 ? (
          <div className="hr-native-home-empty compact"><SearchIcon size={18} /><span>{t("sf.noMatch")}</span></div>
        ) : null}

        {loaded && !loading && !discoveryError && records.length === 0 && sources.length === 0 ? (
          <div className="hr-native-home-empty"><ChatIcon size={18} /><span>{t("sf.addMachineHint")}</span></div>
        ) : null}
      </div>
    </section>
  )
}
