import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { listMachineProjects, type MachineProject } from "../machineClient"
import { canCreateNativeSession, createNativeSessionTarget } from "../native-session-create"
import {
  discoverAgentNativeSessionPage,
  nativeSessionSurfaceTarget,
  type NativeSessionRecord,
  type NativeSessionSurfaceTarget
} from "../native-session-discovery"
import type { MachineAgentHost, MachineSnapshot } from "../types"
import { nativeSessionDisplayTitle } from "../native-session-title"
import { useTranslator } from "../useTranslator"
import type { Translator } from "../i18n"
import type { WorkspaceMachine } from "../workspaceMachines"
import { AgentIcon, ChatIcon, ChevronDownIcon, LoadingIcon, PlusIcon, SearchIcon, ServerIcon } from "../Icons"
import "../native-session-home.css"
import "../native-session-home-ux.css"

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

type ProjectGroup = {
  key: string
  machine: WorkspaceMachine
  name: string
  directory: string
  sessions: RecordWithMachine[]
  updatedAt: number
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

type ActivityAnchor = {
  key: string
  updatedAt: number
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
}

type SessionPresentationState = "working" | "attention" | "stopped" | "ready"

type Props = {
  sources: Source[]
  onOpen: (target: NativeSessionSurfaceTarget) => void
  /** Bumped by the shell after a native mutation (rename/delete) so the list re-reads its Sessions
   * immediately instead of waiting for its own refresh cycle. */
  refreshToken?: number
  /** The rail already counts Sessions needing input; the mobile nav needs that count outside it. */
  onAttentionCountChange?: (count: number) => void
  selectedKey?: string
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
type SessionFilter = "all" | "working" | "attention"

const HARNESS_ICON_FILES: Record<string, string> = {
  codex: "codex.svg",
  claude: "claude.svg",
  opencode: "opencode.svg",
  omp: "omp.svg",
  pi: "pi.svg"
}

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

function harnessIconUrl(backend: string): string | undefined {
  const file = HARNESS_ICON_FILES[backend.toLowerCase()]
  return file ? `${import.meta.env.BASE_URL}harness-icons/${file}` : undefined
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
  return [...unique.values()].sort(sessionActivityCompare)
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

function activityTimestamp(item: RecordWithMachine, anchor?: ActivityAnchor | null): number {
  if (anchor?.key === recordKey(item)) return anchor.updatedAt
  return item.record.session.time?.updated || item.record.session.time?.created || 0
}

function sessionActivityCompare(left: RecordWithMachine, right: RecordWithMachine, anchor?: ActivityAnchor | null): number {
  const updated = activityTimestamp(right, anchor) - activityTimestamp(left, anchor)
  if (updated) return updated
  const created = (right.record.session.time?.created || 0) - (left.record.session.time?.created || 0)
  if (created) return created
  const machine = left.machine.id.localeCompare(right.machine.id)
  if (machine) return machine
  return left.record.key.localeCompare(right.record.key)
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

function projectGroups(records: RecordWithMachine[], anchor?: ActivityAnchor | null): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>()
  for (const item of records) {
    const nativeDirectory = item.record.session.directory || ""
    const project = item.project
    // ProjectCatalog is authoritative when it can attribute the native cwd. Its id is already stable
    // for machine + canonical realpath. Uncatalogued Sessions keep the exact native directory as a
    // conservative fallback, so an unreadable catalog never hides or incorrectly merges Sessions.
    const directory = project?.path || nativeDirectory
    const key = project
      ? `${item.machine.id}\u0000project:${project.id}`
      : `${item.machine.id}\u0000directory:${nativeDirectory}`
    const updatedAt = activityTimestamp(item, anchor)
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

  // Native activity is still the ordering rule, but the Session currently open in the detail pane
  // keeps the activity timestamp it had when it was selected. Harnesses update `time.updated` as a
  // turn starts; without this anchor the row, its Project and sometimes its Machine all jump to the
  // top while the user is looking at them. The live Working/Ready state remains fully independent.
  for (const group of groups.values()) group.sessions.sort((left, right) => sessionActivityCompare(left, right, anchor))

  return [...groups.values()].sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name))
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
  sources,
  onOpen,
  refreshToken = 0,
  onAttentionCountChange,
  onDiscoveredChange,
  onRefreshComplete,
  selectedKey,
  selectedState,
  deletingKeys,
  deletedKeys,
  onDeletionSettled
}: Props) {
  const t = useTranslator()
  const [records, setRecords] = useState<RecordWithMachine[]>([])
  const [projectsByMachine, setProjectsByMachine] = useState<Record<string, MachineProject[]>>({})
  const [loading, setLoading] = useState(false)
  /**
   * Which set of machines the list has actually been discovered for, rather than a bare "has ever
   * loaded". Adding the first machine used to leave the flag from the empty state standing, so the
   * workspace was told the Sessions were in while they were still being read. Keyed by machine, a
   * genuinely new set of machines is a fresh discovery; a refresh of the same set is not, so the
   * thirty-second cycle never drops the list back to a loading state.
   */
  const [loadedSignature, setLoadedSignature] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set())
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set())
  const [collapsedMachines, setCollapsedMachines] = useState<Set<string>>(() => new Set())
  const [createOpen, setCreateOpen] = useState(false)
  const [createMachineID, setCreateMachineID] = useState("")
  const [createProjectKey, setCreateProjectKey] = useState("")
  const [createAgentID, setCreateAgentID] = useState("")
  const [createTitle, setCreateTitle] = useState("")
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderSessionError, setOlderSessionError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<SessionFilter>("all")
  const [machineFilter, setMachineFilter] = useState("")
  const [agentFilter, setAgentFilter] = useState("")
  const [activityAnchor, setActivityAnchor] = useState<ActivityAnchor | null>(null)
  const [recentlyCompletedKey, setRecentlyCompletedKey] = useState<string | null>(null)
  const selectedRowRef = useRef<HTMLButtonElement | null>(null)
  const previousSelectedState = useRef<{ key?: string; state?: SessionPresentationState }>({})
  const completionTimer = useRef<number | null>(null)
  const pageCache = useRef<Map<string, AgentPageCache>>(new Map())
  const pageCacheSignature = useRef<string | null>(null)
  const onRefreshCompleteRef = useRef(onRefreshComplete)
  onRefreshCompleteRef.current = onRefreshComplete
  // The selected Session receives live status before the 30s discovery list refreshes. Keep that
  // last observed state by Session key while the user navigates elsewhere, otherwise the row falls
  // back to its stale discovery snapshot and visibly flips Working <-> Ready. The next successful
  // native discovery clears these bridge states and becomes authoritative again.
  const [presentationOverrides, setPresentationOverrides] = useState<Record<string, SessionPresentationState>>({})

  const discoveryReady = sources.every(({ state }) => state !== "loading")
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
  const loaded = discoveryReady && loadedSignature === machineSignature

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
    const previous = previousSelectedState.current
    if (previous.key !== selectedKey) setRecentlyCompletedKey(null)
    if (selectedKey && previous.key === selectedKey && previous.state === "working" && selectedState === "ready") {
      setRecentlyCompletedKey(selectedKey)
      if (completionTimer.current !== null) window.clearTimeout(completionTimer.current)
      completionTimer.current = window.setTimeout(() => {
        setRecentlyCompletedKey((current) => current === selectedKey ? null : current)
        completionTimer.current = null
      }, 5_000)
    } else if (selectedKey && selectedState === "working") {
      setRecentlyCompletedKey((current) => current === selectedKey ? null : current)
    }
    previousSelectedState.current = { key: selectedKey, state: selectedState }
  }, [selectedKey, selectedState])

  useEffect(() => () => {
    if (completionTimer.current !== null) window.clearTimeout(completionTimer.current)
  }, [])

  useEffect(() => {
    if (!selectedKey) {
      if (activityAnchor) setActivityAnchor(null)
      return
    }
    if (activityAnchor?.key === selectedKey) return
    const selected = records.find((item) => recordKey(item) === selectedKey)
    setActivityAnchor(selected ? {
      key: selectedKey,
      updatedAt: selected.record.session.time?.updated || selected.record.session.time?.created || 0
    } : null)
  }, [activityAnchor, records, selectedKey])

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
      setOlderSessionError(null)
      setLoadedSignature(machineSignature)
      setLoading(false)
      onRefreshCompleteRef.current?.(refreshToken)
      return
    }
    // A configured connection is not yet a discoverable machine while its daemon probe is still in
    // flight. Running Session discovery against snapshot=null used to "complete" startup with an
    // empty list, then flip to the real Sessions a moment later. Hold this phase explicitly until
    // every configured machine has either produced a snapshot or definitively settled offline.
    if (!discoveryReady) {
      setLoading(true)
      setDiscoveryError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setDiscoveryError(null)
    setOlderSessionError(null)
    void Promise.all(sources.map(async ({ machine, snapshot }) => {
      if (!snapshot) return { machine, snapshot, projects: [] as MachineProject[], pages: [] }
      const [pages, projects] = await Promise.all([
        Promise.all(snapshot.agents.map(async (agent) => ({
          agent,
          page: await discoverAgentNativeSessionPage(machine.config, agent).catch(() => null)
        }))),
        listMachineProjects(machine.config).catch(() => [] as MachineProject[])
      ])
      return { machine, snapshot, projects, pages }
    })).then((results) => {
      if (cancelled) return
      setProjectsByMachine(Object.fromEntries(results.map((result) => [result.machine.id, result.projects])))
      if (pageCacheSignature.current !== machineSignature) pageCache.current.clear()
      pageCacheSignature.current = machineSignature
      const activeScopes = new Set<string>()
      for (const result of results) {
        if (!result.snapshot) continue
        for (const { agent, page } of result.pages) {
          const scope = pageScopeKey(result.machine.id, agent.id)
          activeScopes.add(scope)
          const existing = pageCache.current.get(scope)
          if (!page) continue
          const firstRecords = page.records.map((record) => ({
            machine: result.machine,
            machineID: result.snapshot!.machine.id,
            record,
            project: catalogProject(record, result.projects, result.snapshot!.machine.id)
          }))
          const refreshed = refreshCursorPage(existing, firstRecords, page.nextCursor, recordKey)
          const recordsForScope = uniqueSessionRecords(refreshed.records)
            .filter((item) => !deletedKeys?.has(recordKey(item)))
          pageCache.current.set(scope, {
            machine: result.machine,
            machineID: result.snapshot.machine.id,
            agent,
            projects: result.projects,
            records: recordsForScope,
            firstPageCursor: refreshed.firstPageCursor,
            nextCursor: refreshed.nextCursor,
            loadedOlder: refreshed.loadedOlder
          })
        }
      }
      for (const scope of pageCache.current.keys()) {
        if (!activeScopes.has(scope)) pageCache.current.delete(scope)
      }
      // This is a fresh status read from every harness, so it supersedes any presentation bridge
      // remembered only to span the gap between a detail event and this discovery cycle.
      setPresentationOverrides({})
      setRecords(uniqueSessionRecords([...pageCache.current.values()].flatMap((entry) => entry.records)))
      setLoadedSignature(machineSignature)
    }).catch((reason) => {
      // Preserve an already loaded list, but never present a failed refresh as a genuinely empty machine.
      if (!cancelled) {
        // A failed pass still counts as settled: the notice above the list explains it, and the
        // workspace must not sit on a waiting screen for a machine that is not coming back.
        setLoadedSignature(machineSignature)
        setDiscoveryError(reason instanceof Error ? reason.message : String(reason))
      }
    }).finally(() => {
      if (!cancelled) {
        setLoading(false)
        onRefreshCompleteRef.current?.(refreshToken)
      }
    })
    return () => { cancelled = true }
  }, [sources, revision, refreshToken, discoveryReady, machineSignature, deletedKeys])

  useEffect(() => {
    if (!loaded || document.visibilityState !== "visible") return
    const timer = window.setInterval(() => setRevision((value) => value + 1), SESSION_HOME_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [loaded])

  const presentationForItem = useCallback((item: RecordWithMachine) => {
    const targetKey = recordKey(item)
    const bridgedState = targetKey === selectedKey && selectedState
      ? selectedState
      : presentationOverrides[targetKey]
    if (bridgedState) return { state: bridgedState, label: presentationLabel(bridgedState, t) }
    return sessionPresentation(item.record, t)
  }, [presentationOverrides, selectedKey, selectedState, t])

  const selectedActivityAnchor = activityAnchor?.key === selectedKey ? activityAnchor : null
  const groups = useMemo(() => projectGroups(records, selectedActivityAnchor), [records, selectedActivityAnchor])

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
    // A collapsed machine must not be able to hide the Session that is currently open.
    setCollapsedMachines((current) => {
      if (!current.has(selectedGroup.machine.id)) return current
      const next = new Set(current)
      next.delete(selectedGroup.machine.id)
      return next
    })
    // The compact project preview normally shows five rows. If the open Session sits below that
    // boundary, expand exactly that project rather than letting the current Session disappear.
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
  }, [expandedProjects, selectedKey, selectedState])

  const machineChoices = useMemo(() => sources.map(({ machine, snapshot }) => ({
    id: machine.id,
    label: snapshot?.machine.name || machine.name,
    count: records.filter((item) => item.machine.id === machine.id).length
  })), [records, sources])

  const machineScopedRecords = useMemo(
    () => machineFilter ? records.filter((item) => item.machine.id === machineFilter) : records,
    [machineFilter, records]
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
    if (agentFilter && !agentChoices.some((choice) => choice.id === agentFilter)) setAgentFilter("")
  }, [agentChoices, agentFilter])

  const scopedRecords = useMemo(
    () => agentFilter ? machineScopedRecords.filter((item) => item.record.agentId === agentFilter) : machineScopedRecords,
    [agentFilter, machineScopedRecords]
  )

  const activeCount = useMemo(
    () => scopedRecords.filter((item) => presentationForItem(item).state === "working").length,
    [presentationForItem, scopedRecords]
  )
  const attentionCount = useMemo(
    () => scopedRecords.filter((item) => presentationForItem(item).state === "attention").length,
    [presentationForItem, scopedRecords]
  )

  useEffect(() => {
    onAttentionCountChange?.(attentionCount)
  }, [attentionCount, onAttentionCountChange])

  useEffect(() => {
    onDiscoveredChange?.(loaded)
  }, [loaded, onDiscoveredChange])

  const filteredGroups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return groups.flatMap((group) => {
      const sessions = group.sessions.filter((item) => {
        const presentation = presentationForItem(item)
        if (machineFilter && item.machine.id !== machineFilter) return false
        if (agentFilter && item.record.agentId !== agentFilter) return false
        if (filter === "working" && presentation.state !== "working") return false
        if (filter === "attention" && presentation.state !== "attention") return false
        if (!normalizedQuery) return true
        const session = item.record.session
        return [
          session.title,
          item.record.agentLabel,
          group.name,
          group.directory,
          group.machine.name
        ].some((value) => value?.toLowerCase().includes(normalizedQuery))
      })
      return sessions.length ? [{ ...group, sessions }] : []
    })
  }, [agentFilter, filter, groups, machineFilter, presentationForItem, query])

  const machineGroups = useMemo(() => sources
    .filter(({ machine }) => !machineFilter || machine.id === machineFilter)
    .flatMap(({ machine, snapshot, state, error }) => {
      const projects = filteredGroups.filter((group) => group.machine.id === machine.id)
      const filtering = Boolean(query.trim() || agentFilter || filter !== "all")
      if (!projects.length && filtering) return []
      return [{
        machine,
        label: snapshot?.machine.name || machine.name,
        state,
        error,
        projects,
        sessionCount: projects.reduce((count, group) => count + group.sessions.length, 0),
        workingCount: projects.reduce((count, group) =>
          count + group.sessions.filter((item) => presentationForItem(item).state === "working").length, 0),
        attentionCount: projects.reduce((count, group) =>
          count + group.sessions.filter((item) => presentationForItem(item).state === "attention").length, 0),
        updatedAt: projects.reduce((latest, group) => Math.max(latest, group.updatedAt), 0)
      }]
    })
    .sort((left, right) => right.updatedAt - left.updatedAt || left.label.localeCompare(right.label)), [agentFilter, filter, filteredGroups, machineFilter, presentationForItem, query, sources])

  const olderPageTargets = [...pageCache.current.entries()].filter(([, entry]) =>
    entry.nextCursor
    && (!machineFilter || entry.machine.id === machineFilter)
    && (!agentFilter || entry.agent.id === agentFilter)
  )

  async function loadOlderSessions() {
    if (loadingOlder || olderPageTargets.length === 0) return
    setLoadingOlder(true)
    setOlderSessionError(null)
    const outcomes = await Promise.all(olderPageTargets.map(async ([scope, entry]) => {
      const cursor = entry.nextCursor!
      try {
        const page = await discoverAgentNativeSessionPage(entry.machine.config, entry.agent, cursor)
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
        pageCache.current.set(outcome.scope, {
          ...current,
          nextCursor: current.firstPageCursor
        })
        continue
      }
      const appended = appendCursorPage(current, outcome.records, outcome.page.nextCursor, recordKey)
      pageCache.current.set(outcome.scope, {
        ...current,
        ...appended,
        records: uniqueSessionRecords(appended.records)
          .filter((item) => !deletedKeys?.has(recordKey(item)))
      })
    }
    setRecords(uniqueSessionRecords([...pageCache.current.values()].flatMap((entry) => entry.records)))
    setOlderSessionError(firstError)
    setLoadingOlder(false)
  }

  const createMachines = useMemo<CreateMachine[]>(() => sources.flatMap(({ machine, snapshot, state, error }) =>
    snapshot && state === "online" && !error
      ? [{ machine, snapshot, label: snapshot.machine.name || machine.name }]
      : []
  ), [sources])
  const selectedCreateMachine = createMachines.find(({ machine }) => machine.id === createMachineID) || createMachines[0]
  const createProjects = useMemo<CreateProject[]>(() => {
    if (!selectedCreateMachine) return []
    return (projectsByMachine[selectedCreateMachine.machine.id] || []).map((project) => ({
      key: `${selectedCreateMachine.machine.id}:${project.id}`,
      machine: selectedCreateMachine.machine,
      snapshot: selectedCreateMachine.snapshot,
      project
    }))
  }, [projectsByMachine, selectedCreateMachine])
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
    onOpen(nativeSessionSurfaceTarget(item.machineID, item.machine.config, item.record))
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
    setCollapsedProjects((current) => {
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
    // A machine snapshot arriving is not the end of startup. Project + Session discovery must settle
    // first, otherwise New Session competes with those reads on the same mobile connection and can
    // be fired while the saved machine is already in a reconnect grace state.
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
      setRecords((current) => [
        createdRecord,
        ...current.filter((item) => !(item.machine.id === selectedCreateMachine.machine.id && item.record.key === record.key))
      ].sort(sessionActivityCompare))
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
      <div className="hr-native-home-heading">
        <div>
          <h2>{t("nav.sessions")}</h2>
          {loaded ? <span>{activeCount
              ? t("sf.workingShown", { working: activeCount, shown: scopedRecords.length })
              : t("sf.recentCount", { count: scopedRecords.length })}</span> : null}
        </div>
        {/* Rename and Delete live in the chat header of the open Session, and refreshing is owned by
            the workspace top bar plus the automatic discovery cycle. The Session list keeps exactly
            one action: starting a new native Session. */}
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
        <div className="hr-native-home-tools">
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
          <div className="hr-native-session-filters" role="group" aria-label={t("sf.filterSessions")}>
            <button type="button" className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")} aria-pressed={filter === "all"}>
              <span>{t("sf.filterAll")}</span> <b>{scopedRecords.length}</b>
            </button>
            <button type="button" className={filter === "working" ? "active" : ""} onClick={() => setFilter("working")} aria-pressed={filter === "working"}>
              <span>{t("sf.filterLive")}</span> <b>{activeCount}</b>
            </button>
            <button type="button" className={filter === "attention" ? "active" : ""} onClick={() => setFilter("attention")} aria-pressed={filter === "attention"}>
              <span>{t("sf.filterAttention")}</span> <b>{attentionCount}</b>
            </button>
          </div>
          <div className="hr-native-session-scopes">
            {sources.length > 1 ? (
              <label className="hr-native-scope">
                <ServerIcon size={13} />
                <select value={machineFilter} onChange={(event) => setMachineFilter(event.target.value)} aria-label={t("sf.filterByMachine")}>
                  <option value="">{t("sf.allMachinesCount", { count: records.length })}</option>
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
        </div>
      ) : null}

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
            <select value={selectedCreateProject?.key || ""} onChange={(event) => { setCreateProjectKey(event.target.value); setCreateError(null) }} disabled={creating || createProjects.length === 0}>
              {createProjects.map((choice) => <option value={choice.key} key={choice.key}>{choice.project.name}</option>)}
            </select>
          </label>
          <label>
            <span>{t("sf.codingAgent")}</span>
            <select value={selectedCreateAgent?.id || ""} onChange={(event) => { setCreateAgentID(event.target.value); setCreateError(null) }} disabled={creating || createAgents.length === 0}>
              {createAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.label || agent.id}</option>)}
            </select>
          </label>
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

      {discoveryError ? (
        <div className="hr-native-home-notice" role="alert">
          <span><strong>{t("sf.refreshFailed")}</strong> {t("sf.refreshFailedDetail")}</span>
          <button type="button" className="tdw-button secondary" onClick={() => setRevision((value) => value + 1)} disabled={loading}>{t("sf.retry")}</button>
        </div>
      ) : null}
      {olderSessionError ? (
        <div className="hr-native-home-notice" role="alert">
          <span><strong>{t("sf.olderSessionsFailed")}</strong> {olderSessionError}</span>
          <button type="button" className="tdw-button secondary" onClick={() => olderPageTargets.length ? void loadOlderSessions() : setRevision((value) => value + 1)} disabled={loading || loadingOlder}>{t("sf.retry")}</button>
        </div>
      ) : null}

      <div className="hr-native-machine-list">
        {machineGroups.map(({ machine, label, state, error, projects, sessionCount, workingCount, attentionCount: machineAttentionCount }) => {
          const machineCollapsed = collapsedMachines.has(machine.id)
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
                  {workingCount ? <em>{t("sf.liveCount", { count: workingCount })}</em> : null}
                  <small>{state === "online" && loaded && !reconnecting ? sessionCount : state === "offline" ? t("sf.offline") : ""}</small>
                  <i className="hr-native-machine-chevron" aria-hidden="true"><ChevronDownIcon size={13} /></i>
                </span>
              </button>
              {machineCollapsed ? null : (
                <>
                  {projects.length === 0 && state !== "loading" && !(state === "online" && (!loaded || reconnecting)) ? (
                    <div className="hr-native-machine-empty">
                      <ServerIcon size={15} />
                      <span>{state === "offline" ? t("sf.machineUnavailableSaved") : t("sf.noSessionsOnMachine")}</span>
                    </div>
                  ) : null}

                  {projects.map((group) => {
                    const expanded = expandedProjects.has(group.key)
                    const collapsed = collapsedProjects.has(group.key)
                    const treeRows = sessionTreeRows(group.sessions)
                    const visibleRows = expanded ? treeRows : treeRows.slice(0, COLLAPSED_PROJECT_SESSION_COUNT)
                    const hiddenCount = Math.max(0, treeRows.length - COLLAPSED_PROJECT_SESSION_COUNT)
                    return (
                      <section className={`hr-native-project-group${collapsed ? " collapsed" : ""}`} key={group.key} aria-label={t("sf.groupSessions", { name: group.name })}>
                        <button
                          type="button"
                          className="hr-native-project-heading"
                          onClick={() => toggleProjectCollapsed(group.key)}
                          aria-expanded={!collapsed}
                          aria-label={t(collapsed ? "sf.expandGroup" : "sf.collapseGroup", { name: group.name })}
                        >
                          <span>
                            <strong>{group.name}</strong>
                            <small title={group.directory}>{group.directory || t("sf.noWorkingDirectory")}</small>
                          </span>
                          <span><b>{group.sessions.length}</b><i className="hr-native-project-chevron" aria-hidden="true"><ChevronDownIcon size={13} /></i></span>
                        </button>
                        {!collapsed ? (
                          <>
                            <div className="hr-native-home-list">
                              {visibleRows.map(({ item, depth }) => {
                                const status = presentationForItem(item)
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
                                const recentlyCompleted = targetKey === recentlyCompletedKey
                                const deleting = Boolean(deletingKeys?.has(targetKey))
                                return (
                                  <button
                                    type="button"
                                    ref={selected ? selectedRowRef : undefined}
                                    className={`hr-native-session-row ${status.state}${selected ? " selected" : ""}${recentlyCompleted ? " just-finished" : ""}${deleting ? " deleting" : ""}${depth ? " child" : ""}`}
                                    data-depth={Math.min(depth, 3)}
                                    key={targetKey}
                                    onClick={() => { if (!deleting) open(item) }}
                                    disabled={deleting}
                                    aria-busy={deleting || undefined}
                                    aria-current={selected ? "page" : undefined}
                                    aria-label={t("sf.openSessionAria", {
                                      title: accessibleTitle,
                                      agent: `${item.record.agentLabel}${nativeAgent ? ` · ${nativeAgent}` : ""}${restrictionCount ? ` · ${t("sf.restrictionsLabel", { count: restrictionCount })}` : ""}${depth ? ` · ${t("sf.childSession")}` : ""}`,
                                      status: deleting ? t("sf.deleting") : status.label,
                                      project: group.name,
                                      machine: group.machine.name
                                    })}
                                    title={tooltipTitle}
                                  >
                                    <span className="hr-native-session-harness" aria-hidden="true">
                                      {icon ? <img src={icon} alt="" /> : <b>{item.record.agentLabel.slice(0, 2).toUpperCase()}</b>}
                                      <i data-state={status.state} />
                                    </span>
                                    <span className="hr-native-session-copy">
                                      <strong>{title}</strong>
                                      <small>
                                        <span>{item.record.agentLabel}{nativeAgent ? ` · ${nativeAgent}` : ""}{item.record.session.external === true ? ` · ${t("sf.external")}` : ""}</span>
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
                                      <span className="hr-native-session-status" data-state={deleting ? "deleting" : status.state} aria-live={selected || deleting ? "polite" : undefined}>
                                        {deleting ? <><LoadingIcon size={12} /> {t("sf.deleting")}</> : <>{recentlyCompleted ? "✓ " : ""}{status.label}</>}
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
                                {expanded ? t("sf.showLess") : t("sf.showMore", { count: hiddenCount })}
                              </button>
                            ) : null}
                          </>
                        ) : null}
                      </section>
                    )
                  })}
                </>
              )}
            </section>
          )
        })}
      </div>

      {loaded && olderPageTargets.length > 0 ? (
        <div className="hr-native-home-pagination">
          <button type="button" className="tdw-button secondary" onClick={() => void loadOlderSessions()} disabled={loading || loadingOlder} aria-busy={loadingOlder}>
            {loadingOlder ? <LoadingIcon size={14} /> : null}
            {t(loadingOlder ? "sf.loadingOlderSessions" : "sf.loadOlderSessions")}
          </button>
        </div>
      ) : null}

      {loaded && records.length > 0 && filteredGroups.length === 0 ? (
        <div className="hr-native-home-empty compact"><SearchIcon size={18} /><span>{t("sf.noMatch")}</span></div>
      ) : null}

      {loaded && !loading && !discoveryError && records.length === 0 && sources.length === 0 ? (
        <div className="hr-native-home-empty"><ChatIcon size={18} /><span>{t("sf.addMachineHint")}</span></div>
      ) : null}
    </section>
  )
}
