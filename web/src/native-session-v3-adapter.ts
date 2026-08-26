import { api, type MessagePage } from "./api"
import { probeNativeSessionContinuation } from "./native-session-continuation"
import { lastNativeMessageModel } from "./native-session-model"
import type { NativeSessionSurfaceTarget } from "./native-session-discovery"
import { loadPendingNativeSessionPrompt, sendNativeSessionPrompt } from "./native-session-prompt"
import { stopNativeSession } from "./native-session-stop"
import {
  taskClient,
  type MachineTask,
  type MachineTaskRun,
  type TaskContinueInput
} from "./taskClient"
import type { MessageEnvelope, ModelSelection, ServerConfig } from "./types"

const PROJECTION_ID_PREFIX = "native-session-v3:"

type ProjectionRun = {
  id: string
  prompt: string
  created: number
  model: ModelSelection | null
}

type ProjectionEntry = {
  target: NativeSessionSurfaceTarget
  createdAt: number
  updatedAt: number
  statusType: string
  forcedStatus: "running" | "cancelled" | null
  currentModel: ModelSelection | null
  initialPageCaptured: boolean
  piTailMessages: MessageEnvelope[]
  writerReady: boolean
  writerClaimInFlight: Promise<void> | null
  runs: Map<string, ProjectionRun>
  listeners: Set<(task: MachineTask) => void>
}

type PreparedProjectionRun = {
  id: string
  created: number
  prompt: string
  model: ModelSelection | null
}

const projections = new Map<string, ProjectionEntry>()
let installed = false
let provisionalRunSequence = 0

export function nativeSessionIsWorking(status?: string): boolean {
  const value = status?.trim().toLowerCase() || ""
  return value === "busy"
    || value === "running"
    || value === "working"
    || value === "retry"
    || value === "waiting"
    || value === "in_progress"
    || value === "in-progress"
}

function projectionID(target: NativeSessionSurfaceTarget): string {
  return `${PROJECTION_ID_PREFIX}${encodeURIComponent(target.machineID)}:${encodeURIComponent(target.agentID)}:${encodeURIComponent(target.sessionID)}`
}

function canonicalText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim()
}

function messageText(message: MessageEnvelope): string {
  return (message.parts || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

/**
 * PI exposes two legitimate identities for one completed assistant reply: while the turn is live the
 * ACP stream has one message id, then the authoritative JSONL journal can expose the same reply with
 * its persisted record id. The mature v3 tail merge intentionally retains unseen ids, so letting that
 * transport identity swap through would display the same answer twice after Stop/reopen or any other
 * live-to-journal transition.
 *
 * Preserve the prior browser identity only for one unambiguous assistant final-text match. Reasoning
 * may accompany the final text because PI journals thinking and the answer in the same assistant
 * record. Repeated identical answers stay distinct because neither side may contain more than one
 * candidate. Errors and tool-bearing messages keep their native identities unchanged.
 */
function piStableAssistantKey(message: MessageEnvelope): string | null {
  if (message.info.role !== "assistant" || message.info.error || !message.parts.length) return null
  if (message.parts.some((part) => part.type !== "text" && part.type !== "reasoning")) return null
  const textParts = message.parts.filter((part) => part.type === "text" && typeof part.text === "string")
  if (!textParts.length) return null
  const text = canonicalText(textParts.map((part) => part.text || "").join("\n"))
  return text ? text : null
}

export function stabilizePiTailMessageIDs(
  previous: MessageEnvelope[],
  next: MessageEnvelope[]
): MessageEnvelope[] {
  if (!previous.length || !next.length) return next

  const previousIDs = new Set(previous.map((message) => message.info.id))
  const nextIDs = new Set(next.map((message) => message.info.id))
  const previousByKey = new Map<string, MessageEnvelope[]>()
  const nextKeyCounts = new Map<string, number>()

  for (const message of previous) {
    if (nextIDs.has(message.info.id)) continue
    const key = piStableAssistantKey(message)
    if (!key) continue
    const candidates = previousByKey.get(key) ?? []
    candidates.push(message)
    previousByKey.set(key, candidates)
  }
  for (const message of next) {
    if (previousIDs.has(message.info.id)) continue
    const key = piStableAssistantKey(message)
    if (key) nextKeyCounts.set(key, (nextKeyCounts.get(key) ?? 0) + 1)
  }

  let changed = false
  const stabilized = next.map((message) => {
    if (previousIDs.has(message.info.id)) return message
    const key = piStableAssistantKey(message)
    if (!key || nextKeyCounts.get(key) !== 1) return message
    const candidates = previousByKey.get(key)
    if (candidates?.length !== 1) return message
    const stableID = candidates[0].info.id
    changed = true
    return {
      ...message,
      info: { ...message.info, id: stableID },
      parts: message.parts.map((part) => ({ ...part, messageID: stableID }))
    }
  })
  return changed ? stabilized : next
}

function stabilizePiTailPage(entry: ProjectionEntry, page: MessagePage, before?: string): MessagePage {
  if (entry.target.backend !== "pi" || before) return page
  const messages = stabilizePiTailMessageIDs(entry.piTailMessages, page.messages)
  entry.piTailMessages = messages
  return messages === page.messages ? page : { ...page, messages }
}

/**
 * The old v3 handoff packet is transport context, not visible dialogue. This adapter only extracts
 * the same USER INSTRUCTION marker so the mature work-thread timeline can match the native turn.
 */
function visiblePrompt(message: MessageEnvelope): string {
  const value = canonicalText(messageText(message))
  if (!value.startsWith("You are taking over an existing TaskDesk task.")) return value
  const marker = "\nUSER INSTRUCTION\n"
  const start = value.indexOf(marker)
  if (start < 0) return value
  const instructionStart = start + marker.length
  const footerStart = value.indexOf("\n\nContinue from the shared workspace", instructionStart)
  return canonicalText(value.slice(instructionStart, footerStart >= 0 ? footerStart : undefined))
}

function nativeAssistantCompleted(message: MessageEnvelope): boolean {
  if (message.info.role !== "assistant") return false
  if (message.info.error || message.info.time?.completed) return true
  const info = message.info as MessageEnvelope["info"] & { finish?: unknown }
  return typeof info.finish === "string" && Boolean(info.finish.trim())
}

function sameModel(left: ModelSelection | null, right: ModelSelection | null): boolean {
  if (!left || !right) return !left && !right
  return left.providerID === right.providerID
    && left.modelID === right.modelID
    && (left.variant || "") === (right.variant || "")
}

/**
 * Model enrichment is not a mount-only read. A user can leave immediately after Send, before the
 * new native envelope is durable, then return while the reply is still streaming. Every current-tail
 * page can therefore advance the projection from stale/default metadata to the model on the newest
 * native turn.
 *
 * OMP reports the model of its selected JSONL branch as page.model. That is native truth and must be
 * allowed to fill a projection that mounted before model enrichment. While an HR-originated turn is
 * already running, however, an older journal page may still describe the previous model for a few
 * milliseconds; never let that stale page undo a concrete model the user just selected for the turn.
 */
function reconcileNativeSessionModel(entry: ProjectionEntry, page: MessagePage, before?: string): void {
  if (before || !["opencode", "codex", "omp"].includes(entry.target.backend)) return
  const model = page.model ?? (entry.target.backend === "opencode" ? lastNativeMessageModel(page.messages) : null)
  if (!model) return
  if (entry.target.backend === "omp" && entry.forcedStatus === "running" && entry.currentModel && !sameModel(entry.currentModel, model)) {
    return
  }

  let changed = !sameModel(entry.currentModel, model)
  entry.currentModel = model

  const orderedRuns = [...entry.runs.values()].sort((left, right) => left.created - right.created || left.id.localeCompare(right.id))
  const latestRun = orderedRuns[orderedRuns.length - 1]
  if (latestRun && !latestRun.model) {
    latestRun.model = model
    changed = true
  } else {
    const latestUser = [...page.messages].reverse().find((message) => message.info.role === "user" && message.info.id)
    if (latestUser) {
      const run = entry.runs.get(`${projectionID(entry.target)}:native-user:${latestUser.info.id}`)
      if (run && !sameModel(run.model, model)) {
        run.model = model
        changed = true
      }
    }
  }
  if (changed) notify(entry)
}

/**
 * OpenCode status and transcript durability are separate streams. After HR accepts one prompt, the
 * durable native transcript is the strongest evidence that this exact turn finished: it cannot be
 * scoped away by `/session/status`, and it is also the payload the user ultimately needs to see.
 *
 * Match by prompt occurrence, not timestamps, so repeated prompts remain correct and clock skew
 * between the browser and OpenCode cannot attach an older completed assistant to a new Run.
 */
function reconcileOpenCodeTranscriptStatus(entry: ProjectionEntry, page: MessagePage, before?: string): void {
  if (entry.target.backend !== "opencode" || before || entry.forcedStatus !== "running") return

  const orderedRuns = [...entry.runs.values()].sort((left, right) => left.created - right.created || left.id.localeCompare(right.id))
  const current = orderedRuns[orderedRuns.length - 1]
  const prompt = canonicalText(current?.prompt || "")
  if (!current || !prompt) return

  const occurrence = orderedRuns.slice(0, -1).filter((run) => canonicalText(run.prompt) === prompt).length
  let seen = 0
  let userIndex = -1
  for (let index = 0; index < page.messages.length; index += 1) {
    const message = page.messages[index]
    if (message.info.role !== "user" || visiblePrompt(message) !== prompt) continue
    if (seen === occurrence) {
      userIndex = index
      break
    }
    seen += 1
  }
  if (userIndex < 0) return

  let completedAt = 0
  let completed = false
  for (let index = userIndex + 1; index < page.messages.length; index += 1) {
    const message = page.messages[index]
    if (message.info.role === "user") break
    if (!nativeAssistantCompleted(message)) continue
    completed = true
    completedAt = Math.max(completedAt, Number(message.info.time?.completed) || Number(message.info.time?.created) || 0)
  }
  if (!completed) return

  const priorStatus = taskStatus(entry)
  entry.statusType = "idle"
  entry.forcedStatus = null
  if (completedAt) entry.updatedAt = Math.max(entry.updatedAt, completedAt)
  if (taskStatus(entry) !== priorStatus) notify(entry)
}

function iso(timestamp: number): string {
  return new Date(Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now()).toISOString()
}

function sameServer(left: ServerConfig, right: ServerConfig): boolean {
  return left.host === right.host
    && left.port === right.port
    && left.username === right.username
    && left.password === right.password
    && (left.agentId || "") === (right.agentId || "")
}

function entryForRead(config: ServerConfig, sessionID: string, directory?: string): ProjectionEntry | undefined {
  for (const entry of projections.values()) {
    if (entry.target.sessionID !== sessionID || !sameServer(entry.target.config, config)) continue
    if (directory && entry.target.directory && directory !== entry.target.directory) continue
    return entry
  }
  return undefined
}

function taskStatus(entry: ProjectionEntry): string {
  if (entry.forcedStatus) return entry.forcedStatus
  return nativeSessionIsWorking(entry.statusType) ? "running" : "completed"
}

function sortedRuns(entry: ProjectionEntry): MachineTaskRun[] {
  const status = taskStatus(entry)
  const ordered = [...entry.runs.values()].sort((left, right) => left.created - right.created || left.id.localeCompare(right.id))
  if (ordered.length === 0) {
    return [{
      id: `${projectionID(entry.target)}:anchor`,
      sequence: 1,
      agentId: entry.target.agentID,
      model: entry.currentModel,
      role: "continue",
      sessionId: entry.target.sessionID,
      status,
      transport: entry.target.transport,
      directory: entry.target.directory,
      prompt: "",
      startedAt: iso(entry.createdAt),
      ...(status === "running" ? {} : { finishedAt: iso(entry.updatedAt) })
    }]
  }

  return ordered.map((run, index) => ({
    id: run.id,
    sequence: index + 1,
    agentId: entry.target.agentID,
    model: run.model,
    role: index === 0 ? "implement" : "continue",
    sessionId: entry.target.sessionID,
    status: index === ordered.length - 1 ? status : "completed",
    transport: entry.target.transport,
    directory: entry.target.directory,
    prompt: run.prompt,
    startedAt: iso(run.created),
    ...(index === ordered.length - 1 && status === "running" ? {} : { finishedAt: iso(Math.max(run.created, entry.updatedAt)) })
  }))
}

function projectedTask(entry: ProjectionEntry): MachineTask {
  const runs = sortedRuns(entry)
  const current = runs[runs.length - 1] ?? null
  const firstPrompt = runs.find((run) => run.prompt?.trim())?.prompt || ""
  const directoryParts = entry.target.directory.split(/[\\/]/).filter(Boolean)
  const projectName = directoryParts[directoryParts.length - 1] || entry.target.title || "Native Session"
  return {
    id: projectionID(entry.target),
    machineId: entry.target.machineID,
    projectId: `native:${entry.target.directory || entry.target.sessionID}`,
    project: { name: projectName, path: entry.target.directory, kind: "directory" },
    title: entry.target.title,
    agentId: entry.target.agentID,
    prompt: firstPrompt,
    model: entry.currentModel,
    status: taskStatus(entry),
    workspace: { mode: "project", path: entry.target.directory },
    run: current,
    runs,
    error: null,
    createdAt: iso(entry.createdAt),
    updatedAt: iso(entry.updatedAt),
    ...(taskStatus(entry) === "running" ? {} : { finishedAt: iso(entry.updatedAt) })
  }
}

function notify(entry: ProjectionEntry): MachineTask {
  const task = projectedTask(entry)
  for (const listener of entry.listeners) listener(task)
  return task
}

function captureUserRuns(entry: ProjectionEntry, page: MessagePage, before?: string): void {
  // The first page describes the Session state that existed when the v3 controller mounted. Older
  // pages are admitted when the user explicitly pages backward. Tail refreshes do not manufacture
  // new Runs from replay IDs: new HR prompts already have one accepted client operation identity.
  const mayDiscoverRuns = !entry.initialPageCaptured || Boolean(before)
  if (!mayDiscoverRuns) return

  let changed = false
  for (const message of page.messages) {
    if (message.info.role !== "user" || !message.info.id) continue
    const prompt = visiblePrompt(message)
    if (!prompt) continue
    const id = `${projectionID(entry.target)}:native-user:${message.info.id}`
    if (entry.runs.has(id)) continue
    const created = Number(message.info.time?.created) || entry.createdAt
    entry.runs.set(id, { id, prompt, created, model: entry.currentModel })
    entry.createdAt = Math.min(entry.createdAt, created)
    entry.updatedAt = Math.max(entry.updatedAt, created)
    changed = true
  }
  if (!entry.initialPageCaptured) entry.initialPageCaptured = true
  if (changed) notify(entry)
}

function requestRunID(entry: ProjectionEntry, clientRequestId: string): string {
  return `${projectionID(entry.target)}:request:${clientRequestId}`
}

/**
 * Create the logical continuation boundary before writer acquisition or HTTP prompt delivery starts.
 * OMP can emit session.updated while claim/model application is in progress; without a new Run in the
 * projection that event marks the preceding assistant as active and its old Activity flips back to
 * Working. A provisional Run gives the mature timeline the correct current turn immediately.
 */
function beginProjectionRun(entry: ProjectionEntry, prompt: string, model: ModelSelection | null): PreparedProjectionRun {
  const normalizedPrompt = canonicalText(prompt)
  const effectiveModel = model ?? entry.currentModel
  const unresolved = loadPendingNativeSessionPrompt(entry.target)
  const canReusePending = Boolean(
    unresolved
    && canonicalText(unresolved.text) === normalizedPrompt
    && sameModel(unresolved.model ?? null, effectiveModel)
  )
  const created = canReusePending && unresolved ? unresolved.createdAt : Date.now()
  const id = canReusePending && unresolved
    ? requestRunID(entry, unresolved.clientRequestId)
    : `${projectionID(entry.target)}:pending:${created.toString(36)}:${++provisionalRunSequence}`

  if (!entry.runs.has(id)) {
    entry.runs.set(id, { id, prompt: normalizedPrompt, created, model: effectiveModel })
  }
  if (effectiveModel) entry.currentModel = effectiveModel
  entry.updatedAt = Math.max(entry.updatedAt, created)
  entry.forcedStatus = "running"
  notify(entry)
  return { id, created, prompt: normalizedPrompt, model: effectiveModel }
}

function promoteProjectionRun(
  entry: ProjectionEntry,
  prepared: PreparedProjectionRun,
  clientRequestId: string,
  running: boolean
): MachineTask {
  const id = requestRunID(entry, clientRequestId)
  const existing = entry.runs.get(prepared.id)
  if (prepared.id !== id) entry.runs.delete(prepared.id)
  if (!entry.runs.has(id)) {
    entry.runs.set(id, {
      id,
      prompt: existing?.prompt ?? prepared.prompt,
      created: existing?.created ?? prepared.created,
      model: existing?.model ?? prepared.model ?? entry.currentModel
    })
  }
  const run = entry.runs.get(id)
  if (run && !run.model && entry.currentModel) run.model = entry.currentModel
  entry.updatedAt = Math.max(entry.updatedAt, run?.created ?? prepared.created)
  entry.forcedStatus = running ? "running" : null
  if (running) entry.statusType = "running"
  return notify(entry)
}

function abandonProjectionRun(entry: ProjectionEntry, prepared: PreparedProjectionRun): MachineTask {
  entry.runs.delete(prepared.id)
  entry.forcedStatus = null
  return notify(entry)
}

async function refreshStatus(entry: ProjectionEntry): Promise<void> {
  // OpenCode's legacy /session/status has changed scope across recent releases and can omit a child
  // directory Session entirely. More importantly, this read sits in the v3 pre-Send reconciliation
  // path, so a slow status endpoint delays prompt delivery before OpenCode even starts reasoning.
  // Once HR accepts an OpenCode prompt, reconcileOpenCodeTranscriptStatus clears Working only after
  // the same native transcript consumed by the UI contains a terminal assistant envelope.
  if (entry.target.backend === "opencode") return

  try {
    const statuses = await api.listStatuses(entry.target.config)
    const next = statuses[entry.target.sessionID]?.type
    if (typeof next === "string" && next) {
      entry.statusType = next
      if (!nativeSessionIsWorking(next)) entry.forcedStatus = null
    }
  } catch {
    // Status is enrichment. The v3 transcript remains the authority when this lightweight read fails.
  }
}

/**
 * ACP writer ownership is a transport detail, not a navigation step. Reading a Session never claims
 * it. The first Send or Stop acquires the writer transparently and caches that fact for this open
 * projection. OpenCode resolves immediately because it has no ACP single-writer claim boundary.
 */
async function ensureWriter(entry: ProjectionEntry): Promise<void> {
  if (entry.writerReady) return
  if (entry.writerClaimInFlight) return entry.writerClaimInFlight

  const claim = (async () => {
    const result = await probeNativeSessionContinuation(entry.target)
    if (!result.writable) {
      throw new Error(result.reason || `${entry.target.agentLabel} did not allow this Session to be resumed.`)
    }
    entry.writerReady = true
  })()
  entry.writerClaimInFlight = claim
  try {
    await claim
  } finally {
    if (entry.writerClaimInFlight === claim) entry.writerClaimInFlight = null
  }
}

function installAdapter(): void {
  if (installed) return
  installed = true

  const originalLoadMessagePage = api.loadMessagePage.bind(api)
  api.loadMessagePage = async function patchedLoadMessagePage(config, sessionID, directory, before, limit, refreshHistory) {
    let page = await originalLoadMessagePage(config, sessionID, directory, before, limit, refreshHistory)
    const entry = entryForRead(config, sessionID, directory)
    if (entry) {
      page = stabilizePiTailPage(entry, page, before)
      captureUserRuns(entry, page, before)
      reconcileOpenCodeTranscriptStatus(entry, page, before)
      reconcileNativeSessionModel(entry, page, before)
    }
    return page
  }

  const originalGetWorkThread = taskClient.getWorkThread.bind(taskClient)
  taskClient.getWorkThread = async function patchedGetWorkThread(config, taskId) {
    const entry = projections.get(taskId)
    if (!entry) return originalGetWorkThread(config, taskId)
    await refreshStatus(entry)
    return projectedTask(entry)
  }

  const originalContinueTask = taskClient.continueTask.bind(taskClient)
  taskClient.continueTask = async function patchedContinueTask(config, taskId, input) {
    const entry = projections.get(taskId)
    if (!entry) return originalContinueTask(config, taskId, input)
    const body: TaskContinueInput = typeof input === "string" ? { prompt: input } : input
    const prompt = body.prompt?.trim() || ""
    if (!prompt) throw new Error("A text prompt is required")
    if (body.agentId && body.agentId !== entry.target.agentID) {
      throw new Error("Cross-agent continuation is disabled until single-Session parity is validated")
    }

    // The shared v3 controller emits null while its model picker is still catching up with native
    // transcript enrichment. For a native Session that is not an explicit new catalog selection,
    // preserve the model already recovered from the authoritative Session instead of silently
    // switching the next turn to the harness default. A concrete ModelSelection still wins.
    const model = body.model ?? entry.currentModel
    const prepared = beginProjectionRun(entry, prompt, model ?? null)

    try {
      await ensureWriter(entry)
      const result = await sendNativeSessionPrompt(entry.target, prompt, model)
      if (result.status !== "accepted") {
        promoteProjectionRun(entry, prepared, result.clientRequestId, false)
        throw new Error(`Prompt delivery is ${result.status}. Retry the same prompt to reconcile the existing request id.`)
      }
      return promoteProjectionRun(entry, prepared, result.clientRequestId, true)
    } catch (reason) {
      // A transport failure after dispatch keeps the durable pending request id. Preserve that logical
      // user turn so retrying cannot reactivate the preceding Activity, but do not claim it is still
      // Working until native status proves delivery. A claim/HTTP refusal clears the pending record,
      // which proves no turn exists and allows the provisional boundary to be removed completely.
      const pending = loadPendingNativeSessionPrompt(entry.target)
      if (
        pending
        && canonicalText(pending.text) === prepared.prompt
        && sameModel(pending.model ?? null, prepared.model)
      ) {
        promoteProjectionRun(entry, prepared, pending.clientRequestId, false)
      } else if (entry.runs.has(prepared.id)) {
        abandonProjectionRun(entry, prepared)
      }
      throw reason
    }
  }

  const originalCancelWorkThread = taskClient.cancelWorkThread.bind(taskClient)
  taskClient.cancelWorkThread = async function patchedCancelWorkThread(config, taskId) {
    const entry = projections.get(taskId)
    if (!entry) return originalCancelWorkThread(config, taskId)
    await ensureWriter(entry)
    const projectionRuns = sortedRuns(entry)
    const latestRun = projectionRuns[projectionRuns.length - 1]
    const operationToken = latestRun?.id || entry.target.sessionID
    const result = await stopNativeSession(entry.target, operationToken)
    if (result.status !== "accepted") {
      throw new Error(`Stop delivery is ${result.status}. The existing native cancel request will be reconciled instead of repeated.`)
    }
    entry.forcedStatus = "cancelled"
    entry.statusType = "idle"
    entry.updatedAt = Date.now()
    return notify(entry)
  }
}

export function registerNativeSessionV3Adapter(
  target: NativeSessionSurfaceTarget,
  onTaskUpdate: (task: MachineTask) => void
): { task: MachineTask; dispose: () => void } {
  installAdapter()
  const id = projectionID(target)
  let entry = projections.get(id)
  if (!entry) {
    const now = Date.now()
    entry = {
      target,
      createdAt: now,
      updatedAt: now,
      statusType: target.status?.type || "idle",
      forcedStatus: null,
      currentModel: target.model,
      initialPageCaptured: false,
      piTailMessages: [],
      writerReady: !target.requiresExplicitClaim,
      writerClaimInFlight: null,
      runs: new Map(),
      listeners: new Set()
    }
    projections.set(id, entry)
  } else {
    entry.target = target
    entry.statusType = target.status?.type || entry.statusType
    entry.currentModel = target.model ?? entry.currentModel
    if (!target.requiresExplicitClaim) entry.writerReady = true
  }
  entry.listeners.add(onTaskUpdate)
  return {
    task: projectedTask(entry),
    dispose: () => {
      entry?.listeners.delete(onTaskUpdate)
      if (entry && entry.listeners.size === 0) projections.delete(id)
    }
  }
}

export function isNativeSessionV3Projection(taskId: string): boolean {
  return taskId.startsWith(PROJECTION_ID_PREFIX)
}

/**
 * Record a model that was recovered from native metadata after this Session was already mounted.
 *
 * Opening a Session must never wait for model enrichment: the transcript is the product, and the
 * mature v3 contract keeps catalog/model discovery independent of chat availability. An explicit
 * selection the user has since made always wins, so a late enrichment result cannot overwrite it.
 */
export function applyDiscoveredNativeSessionModel(
  target: NativeSessionSurfaceTarget,
  model: ModelSelection | null
): void {
  if (!model) return
  const entry = projections.get(projectionID(target))
  if (!entry || entry.currentModel) return
  entry.currentModel = model
  notify(entry)
}
