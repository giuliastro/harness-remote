import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  listExtensionActions,
  loadExtensionActionState,
  resetExtensionActionState,
  resolveExtensionAction
} from "./extension-actions.js"

function toEpoch(value) {
  const epoch = Date.parse(value ?? "")
  return Number.isFinite(epoch) ? epoch : Date.now()
}

/** ACP agents report native paths; the app may send them in either separator form. */
export function sameDirectory(left, right) {
  if (!left || !right) return false
  const normalize = (value) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, "")
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}
function sessionView(session, status = "idle", title = session.title, external = false) {
  return {
    id: session.sessionId,
    title: title || `Session ${session.sessionId.slice(0, 8)}`,
    directory: session.cwd,
    time: { created: toEpoch(session.updatedAt), updated: toEpoch(session.updatedAt) },
    summary: { additions: 0, deletions: 0, files: 0 },
    model: undefined,
    status,
    ...(external ? { external: true } : {})
  }
}

/**
 * Older PI snapshots contain one UUID-identified assistant envelope per streamed fragment. A user
 * turn is the natural delimiter, so those adjacent envelopes are one visible reply. Keeping them
 * separate breaks Markdown whenever a marker or word straddles two updates.
 */
function mergeFragmentedPiSnapshot(messages) {
  const merged = []
  for (const message of messages) {
    const previous = merged.at(-1)
    if (
      message?.info?.role === "assistant"
      && previous?.info?.role === "assistant"
      && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(message.info.id)
      && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(previous.info.id)
    ) {
      for (const part of message.parts ?? []) {
        const lastPart = previous.parts.at(-1)
        if (lastPart?.type === part?.type && typeof lastPart.text === "string" && typeof part.text === "string") {
          lastPart.text += part.text
        } else {
          previous.parts.push(part)
        }
      }
      continue
    }
    merged.push(message)
  }
  return merged
}

function messageSignature(message) {
  return `${message?.info?.role ?? ""}\u0000${(message?.parts ?? []).map((part) => part?.text ?? "").join("")}`
}
function stableSemanticValue(value) {
  if (Array.isArray(value)) return value.map(stableSemanticValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableSemanticValue(value[key])]))
}

function semanticMessagePart(part) {
  if (!part || typeof part !== "object") return part
  const semantic = {}
  for (const key of Object.keys(part).sort()) {
    if (["id", "messageID", "sessionID", "callID", "time"].includes(key)) continue
    if (key === "state" && part.state && typeof part.state === "object") {
      const { time: _time, ...state } = part.state
      semantic.state = stableSemanticValue(state)
      continue
    }
    semantic[key] = stableSemanticValue(part[key])
  }
  return semantic
}

function semanticMessageSignature(message) {
  return JSON.stringify({
    role: message?.info?.role,
    parts: (message?.parts ?? []).map(semanticMessagePart)
  })
}

function semanticHistorySignature(messages) {
  return JSON.stringify(messages.map((message) => ({
    role: message?.info?.role,
    parts: (message?.parts ?? []).map(semanticMessagePart)
  })))
}

/** Exported for testing only. */
export function mergeReplay(previous, replayed) {
  if (previous.length === 0) return replayed
  if (replayed.length === 0) return previous
  const left = previous.map(messageSignature)
  const right = replayed.map(messageSignature)

  let prefix = 0
  const maxPrefix = Math.min(previous.length, replayed.length)
  while (prefix < maxPrefix && left[prefix] === right[prefix]) {
    prefix += 1
  }

  if (prefix === previous.length) {
    return [...previous, ...replayed.slice(prefix)]
  }

  const midLeft = left.slice(prefix)
  const midRight = right.slice(prefix)

  const common = Array.from({ length: midLeft.length + 1 }, () => new Uint32Array(midRight.length + 1))
  for (let leftIndex = midLeft.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = midRight.length - 1; rightIndex >= 0; rightIndex -= 1) {
      common[leftIndex][rightIndex] = midLeft[leftIndex] === midRight[rightIndex]
        ? common[leftIndex + 1][rightIndex + 1] + 1
        : Math.max(common[leftIndex + 1][rightIndex], common[leftIndex][rightIndex + 1])
    }
  }

  const midMerged = []
  let leftIndex = 0
  let rightIndex = 0
  const midPrev = previous.slice(prefix)
  const midRep = replayed.slice(prefix)

  while (leftIndex < midLeft.length && rightIndex < midRight.length) {
    if (midLeft[leftIndex] === midRight[rightIndex]) {
      midMerged.push(midPrev[leftIndex])
      leftIndex += 1
      rightIndex += 1
    } else if (common[leftIndex + 1][rightIndex] >= common[leftIndex][rightIndex + 1]) {
      midMerged.push(midPrev[leftIndex])
      leftIndex += 1
    } else {
      midMerged.push(midRep[rightIndex])
      rightIndex += 1
    }
  }
  return [
    ...previous.slice(0, prefix),
    ...midMerged,
    ...midPrev.slice(leftIndex),
    ...midRep.slice(rightIndex)
  ]
}
export function mergeExternalHistory(persisted, cached) {
  const persistedIDs = new Set(persisted.map((message) => message.info.id))
  const remainingBySignature = new Map()
  for (const message of persisted) {
    const signature = semanticMessageSignature(message)
    remainingBySignature.set(signature, (remainingBySignature.get(signature) ?? 0) + 1)
  }
  const cachedOnly = cached.filter((message) => {
    if (persistedIDs.has(message.info.id)) return false
    const signature = semanticMessageSignature(message)
    const remaining = remainingBySignature.get(signature) ?? 0
    if (remaining === 0) return true
    remainingBySignature.set(signature, remaining - 1)
    return false
  })
  return [...persisted, ...cachedOnly].sort((left, right) => left.info.time.created - right.info.time.created)
}

function mergeTodos(previous, replayed) {
  if (previous.length === 0 || replayed.length === 0) return replayed.length > 0 ? replayed : previous
  const priorByContent = new Map(previous.map((todo) => [todo.content, todo]))
  if (replayed.some((todo) => !priorByContent.has(todo.content))) return replayed
  const statusRank = { pending: 0, in_progress: 1, completed: 2 }
  return replayed.map((todo) => {
    const prior = priorByContent.get(todo.content)
    return (statusRank[prior.status] ?? -1) > (statusRank[todo.status] ?? -1) ? { ...todo, status: prior.status } : todo
  })
}

/**
 * Some harnesses inject their own bookkeeping into the model's context as user-role turns —
 * background-task notifications and system reminders — and the ACP adapter forwards them as
 * `user_message_chunk` because that is what they are at the protocol level. Rendered faithfully,
 * the app then shows harness internals in a bubble attributed to the person holding the phone,
 * text they never wrote and cannot see anywhere else.
 *
 * Matched only when the chunk is *entirely* one or more such blocks, so a message where someone
 * quotes one while asking about it stays visible — which is exactly how this was reported.
 */
const HARNESS_INJECTED_BLOCK = /^(?:\s*<(task-notification|system-reminder)>[\s\S]*?<\/\1>\s*)+$/

export function isHarnessInjectedText(text) {
  return HARNESS_INJECTED_BLOCK.test(text)
}

// The app groups the picker by source and offers a skill-only filter, so the
// `skill:` prefix OMP puts on skill commands has to survive as structured data
// rather than staying buried in the name.
function commandInfoList(commands) {
  return commands.map((command) => ({
    name: command.name,
    description: command.description ?? undefined,
    source: command.name.startsWith("skill:") ? "skill" : "command"
  }))
}

export class AcpService {
  #acp
  #sessions = new Map()
  #messages = new Map()
  #todos = new Map()
  #configOptions = new Map()
  #commandCatalogs = new Map()
  #commandCatalogWaiters = new Map()
  #actionStates = new Map()
  #authoritativeActionStates = new Map()
  #actionProviders
  #loaded = new Set()
  #loads = new Map()
  #sessionListing
  #replaying = new Set()
  #historyLoader
  #ownedSessions = new Set()
  #promptAcknowledgements = new Map()
  #titles = new Map()
  #deletedSessions = new Set()
  #queues = new Map()
  #active = new Set()
  #listeners = new Set()
  #turnGenerations = new Map()
  #cancelledSessions = new Set()
  #promptedSessions = new Set()
  #chunkMessageIDs = new Map()
  #snapshotDirectory
  #restoredSnapshots = new Set()
  #dirtySnapshots = new Set()
  #snapshotWrites = new Map()
  #preserveListedTimestamps
  #reloadOnHistoryRefresh
  #replaySettleMs
  constructor(acp, {
    snapshotDirectory,
    historyLoader,
    preserveListedTimestamps = false,
    reloadOnHistoryRefresh = true,
    replaySettleMs = 0,
    actionProviders = []
  } = {}) {
    this.#acp = acp
    this.#snapshotDirectory = snapshotDirectory
    this.#historyLoader = historyLoader
    this.#preserveListedTimestamps = preserveListedTimestamps
    this.#reloadOnHistoryRefresh = reloadOnHistoryRefresh
    this.#replaySettleMs = replaySettleMs
    this.#actionProviders = actionProviders
    acp.on("notification", (notification) => this.#handleNotification(notification))
  }

  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async listSessions(directory) {
    const sessions = await this.#refreshSessions()
    await Promise.all(sessions.map((session) => this.#restoreSnapshot(session.sessionId)))
    return sessions
      .filter((session) => !directory || sameDirectory(session.cwd, directory))
      .filter((session) => !this.#deletedSessions.has(session.sessionId))
      .map((session) => sessionView(
        session,
        this.#isBusy(session.sessionId) ? "busy" : "idle",
        this.#titleFor(session.sessionId),
        Boolean(this.#historyLoader && !this.#ownedSessions.has(session.sessionId))
      ))
  }

  async createSession({ directory, title, model }) {
    await this.#acp.start()
    const result = await this.#acp.request("session/new", { cwd: directory, mcpServers: [] })
    this.#rememberConfigOptions(result.sessionId, result.configOptions)
    const session = {
      sessionId: result.sessionId,
      cwd: directory,
      title: title || "Remote session",
      updatedAt: new Date().toISOString(),
      _meta: { messageCount: 0 }
    }
    this.#sessions.set(session.sessionId, session)
    this.#messages.set(session.sessionId, [])
    this.#todos.set(session.sessionId, [])
    this.#loaded.add(session.sessionId)
    this.#ownedSessions.add(session.sessionId)
    if (title) this.#titles.set(session.sessionId, title)
    if (model) await this.setModel(session.sessionId, model)
    this.#emit("session.created", session.sessionId)
    this.#persistSnapshot(session.sessionId)
    return sessionView(session, "idle", this.#titleFor(session.sessionId))
  }

  /** Adopt a task session created by an older daemon so PI can open it without session/load. */
  async adoptTaskSession(sessionID, { title, prompt } = {}) {
    await this.#refreshSessions()
    const session = this.#sessions.get(sessionID)
    if (!session || this.#deletedSessions.has(sessionID)) return false
    this.#ownedSessions.add(sessionID)
    this.#loaded.add(sessionID)
    if (title && !this.#titles.has(sessionID)) this.#titles.set(sessionID, title)
    const messages = this.#messages.get(sessionID) ?? []
    if (prompt && !messages.some((message) => message.info?.role === "user" && message.parts?.some((part) => part.text === prompt))) {
      this.#recordPrompt(sessionID, prompt)
    }
    this.#persistSnapshot(sessionID)
    return true
  }

  async renameSession(sessionID, title) {
    const normalized = title.trim()
    if (!normalized) throw new Error("A session title is required")
    await this.#requireSession(sessionID)
    this.#titles.set(sessionID, normalized)
    this.#persistSnapshot(sessionID)
    this.#emit("session.updated", sessionID)
    return sessionView(
      this.#sessions.get(sessionID),
      this.#isBusy(sessionID) ? "busy" : "idle",
      normalized,
      Boolean(this.#historyLoader && !this.#ownedSessions.has(sessionID))
    )
  }

  async deleteSession(sessionID) {
    await this.#requireSession(sessionID)
    if (this.#isBusy(sessionID)) this.abort(sessionID)
    this.#deletedSessions.add(sessionID)
    this.#messages.delete(sessionID)
    this.#todos.delete(sessionID)
    this.#titles.delete(sessionID)
    this.#configOptions.delete(sessionID)
    this.#commandCatalogs.delete(sessionID)
    for (const resolve of this.#commandCatalogWaiters.get(sessionID) ?? []) resolve()
    this.#commandCatalogWaiters.delete(sessionID)
    this.#actionStates.delete(sessionID)
    this.#authoritativeActionStates.delete(sessionID)
    this.#loaded.delete(sessionID)
    this.#ownedSessions.delete(sessionID)
    this.#promptAcknowledgements.delete(sessionID)
    this.#chunkMessageIDs.delete(`${sessionID}:user`)
    this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
    this.#emit("session.deleted", sessionID)
    this.#persistSnapshot(sessionID)
  }

  async messages(sessionID, refresh = false) {
    await this.#refreshSessions()
    await this.#restoreSnapshot(sessionID)
    const externalHistory = Boolean(this.#historyLoader && !this.#ownedSessions.has(sessionID))
    const reloadHistory = refresh && this.#reloadOnHistoryRefresh
    await this.#load(sessionID, reloadHistory || externalHistory)
    return this.#messages.get(sessionID) ?? []
  }

  async todos(sessionID) {
    await this.#refreshSessions()
    await this.#restoreSnapshot(sessionID)
    if (this.#historyLoader && !this.#ownedSessions.has(sessionID)) return []
    await this.#load(sessionID)
    return this.#todos.get(sessionID) ?? []
  }

  async models(sessionID) {
    await this.#loadForConfigOptions(sessionID)
    const option = this.#configOptions.get(sessionID)?.find((item) => item.id === "model")
    return option?.options?.map((candidate) => ({ ...candidate, currentValue: candidate.value === option.currentValue })) ?? []
  }

  async actions(sessionID) {
    if (!this.#commandCatalogs.has(sessionID)) {
      await this.#load(sessionID, true, true)
      await this.#waitForCommandCatalog(sessionID)
    }
    await this.#refreshActionState(sessionID)
    return this.#availableActions(sessionID)
  }

  // The catalog is per ACP session, but a harness advertises the same commands for
  // every session on the machine, so the newest one answers the app's session-less
  // GET /command. Without that fallback the picker is empty until a session loads.
  async commands(sessionID) {
    if (sessionID) {
      if (!this.#commandCatalogs.has(sessionID)) {
        await this.#load(sessionID, true, true)
        await this.#waitForCommandCatalog(sessionID)
      }
      return commandInfoList(this.#commandCatalogs.get(sessionID) ?? [])
    }
    const catalogs = [...this.#commandCatalogs.values()]
    return commandInfoList(catalogs.at(-1) ?? [])
  }

  #waitForCommandCatalog(sessionID) {
    if (this.#commandCatalogs.has(sessionID)) return Promise.resolve()
    return new Promise((resolve) => {
      let waiters = this.#commandCatalogWaiters.get(sessionID)
      if (!waiters) {
        waiters = new Set()
        this.#commandCatalogWaiters.set(sessionID, waiters)
      }
      const finish = () => {
        clearTimeout(timer)
        waiters.delete(finish)
        if (waiters.size === 0) this.#commandCatalogWaiters.delete(sessionID)
        resolve()
      }
      const timer = setTimeout(finish, 500)
      waiters.add(finish)
    })
  }

  async invokeAction(sessionID, actionID) {
    const available = await this.actions(sessionID)
    if (!available.some((action) => action.id === actionID)) throw new Error(`Harness action is not available: ${actionID}`)
    if (!available.some((action) => action.id === actionID && action.enabled)) throw new Error(`Harness action is disabled: ${actionID}`)
    const resolved = resolveExtensionAction(
      this.#actionProviders,
      this.#commandCatalogs.get(sessionID) ?? [],
      actionID
    )
    if (!resolved) throw new Error(`Harness action is not available: ${actionID}`)

    const beforeState = this.#authoritativeActionStates.get(sessionID)
    this.#ownedSessions.add(sessionID)
    this.#active.add(sessionID)
    this.#emit("session.updated", sessionID)
    let applied = null
    let authoritativeState
    try {
      await this.#acp.request("session/prompt", {
        sessionId: sessionID,
        prompt: [{ type: "text", text: `/${resolved.action.command}` }]
      }, 300_000)
      authoritativeState = await this.#refreshActionState(sessionID)
      if (
        authoritativeState?.actionResult?.id === actionID &&
        authoritativeState.actionResult.token !== beforeState?.actionResult?.token
      ) {
        applied = authoritativeState.actionResult.applied
      } else if (
        typeof beforeState?.sessionRevision === "string" &&
        typeof authoritativeState?.sessionRevision === "string"
      ) {
        applied = authoritativeState.sessionRevision !== beforeState.sessionRevision
      }
      await this.#loadSession(sessionID, true, true)
      this.#emit("message.updated", sessionID)
      this.#persistSnapshot(sessionID)
    } finally {
      this.#active.delete(sessionID)
      this.#emit("session.updated", sessionID)
    }
    return {
      action: actionID,
      applied,
      actions: this.#availableActions(sessionID),
      ...(authoritativeState?.sessionRevision ? { sessionRevision: authoritativeState.sessionRevision } : {})
    }
  }

  async #refreshActionState(sessionID, requireCommands = true) {
    const session = this.#sessions.get(sessionID)
    if (!session) return undefined
    const state = await loadExtensionActionState(
      this.#actionProviders,
      requireCommands ? this.#commandCatalogs.get(sessionID) ?? [] : undefined,
      { sessionID, directory: session.cwd, processID: this.#acp.processID }
    )
    if (state) this.#authoritativeActionStates.set(sessionID, state)
    else this.#authoritativeActionStates.delete(sessionID)
    return state
  }

  #actionState(sessionID) {
    let state = this.#actionStates.get(sessionID)
    if (!state) {
      state = new Map()
      this.#actionStates.set(sessionID, state)
    }
    return state
  }

  #availableActions(sessionID) {
    return listExtensionActions(
      this.#actionProviders,
      this.#commandCatalogs.get(sessionID) ?? [],
      this.#actionState(sessionID),
      this.#isBusy(sessionID),
      this.#authoritativeActionStates.get(sessionID)
    )
  }

  #resetActionsForSessionChange(sessionID) {
    resetExtensionActionState(
      this.#actionProviders,
      this.#commandCatalogs.get(sessionID) ?? [],
      this.#actionState(sessionID)
    )
  }

  async setModel(sessionID, model) {
    await this.#loadForConfigOptions(sessionID)
    const option = this.#configOptions.get(sessionID)?.find((item) => item.id === "model")
    // The app addresses models as `provider/model` because that is what OpenCode's API does, but a
    // harness whose ids carry no provider — Claude Code's `sonnet`, `opus[1m]` — is shown under the
    // backend's name to keep it consistent. Resolve against what the agent actually offered rather
    // than trusting either spelling: exact first, then the part after the synthesised provider.
    const value = option?.options?.some((candidate) => candidate.value === model)
      ? model
      : option?.options?.find((candidate) => candidate.value === model.slice(model.indexOf("/") + 1))?.value
    if (!value) throw new Error(`Harness model is not available: ${model}`)
    await this.#acp.request("session/set_config_option", { sessionId: sessionID, configId: "model", value })
    option.currentValue = value
  }

  /**
   * ACP accepts one turn per session at a time, so a prompt sent while the agent is
   * still working is queued rather than rejected. It is recorded straight away, which
   * is what makes it visible in the conversation while it waits.
   */
  async prompt(sessionID, text, model, attachments = []) {
    // Refuse before touching the session: an agent that never advertised image support
    // would reject the block mid-turn, which reads as a failed prompt rather than a
    // rejected attachment.
    if (attachments.length && !this.#acp.promptCapabilities?.image) {
      throw new Error("This harness does not accept images")
    }
    if (this.#historyLoader && !this.#ownedSessions.has(sessionID)) {
      this.#ownedSessions.add(sessionID)
      this.#loaded.delete(sessionID)
      try {
        await this.#load(sessionID)
      } catch (error) {
        this.#ownedSessions.delete(sessionID)
        throw error
      }
    } else {
      await this.#load(sessionID)
    }
    this.#resetActionsForSessionChange(sessionID)
    if (this.#active.has(sessionID)) {
      const messageID = this.#recordPrompt(sessionID, text, attachments)
      const queue = this.#queues.get(sessionID) ?? []
      queue.push({ text, model, messageID, attachments })
      this.#queues.set(sessionID, queue)
      this.#emit("session.updated", sessionID)
      return
    }
    if (model) await this.setModel(sessionID, model)
    this.#startTurn(sessionID, text, false, attachments)
  }

  /** Start a prompt through the session service and resolve only when that turn becomes idle. */
  async promptAndWait(sessionID, text, model, attachments = []) {
    return new Promise((resolve, reject) => {
      let started = false
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        unsubscribe()
        if (error) reject(error)
        else resolve()
      }
      const unsubscribe = this.subscribe((event) => {
        if (event.sessionId !== sessionID) return
        if (event.type === "session.error") {
          finish(new Error(event.message ?? "Harness prompt failed"))
          return
        }
        if (event.type !== "session.updated") return
        if (this.#isBusy(sessionID)) started = true
        else if (started) finish()
      })
      void this.prompt(sessionID, text, model, attachments).catch(finish)
    })
  }

  #startTurn(sessionID, text, recorded = false, attachments = []) {
    const generation = (this.#turnGenerations.get(sessionID) ?? 0) + 1
    this.#turnGenerations.set(sessionID, generation)
    this.#cancelledSessions.delete(sessionID)
    this.#promptedSessions.add(sessionID)
    if (!recorded) this.#recordPrompt(sessionID, text, attachments)
    this.#active.add(sessionID)
    this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
    this.#emit("session.updated", sessionID)
    void this.#acp.request("session/prompt", {
      sessionId: sessionID,
      prompt: [
        ...(text ? [{ type: "text", text }] : []),
        ...attachments.map((attachment) => ({ type: "image", mimeType: attachment.mime, data: attachment.data }))
      ]
    }, 300_000).catch((error) => {
      if (this.#turnGenerations.get(sessionID) === generation) {
        this.#emit("session.error", sessionID, { message: error.message })
      }
    }).finally(() => {
      if (this.#turnGenerations.get(sessionID) !== generation) return
      this.#active.delete(sessionID)
      this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
      this.#emit("session.updated", sessionID)
      this.#persistSnapshot(sessionID)
      void this.#runNextQueued(sessionID)
    })
  }

  async #runNextQueued(sessionID) {
    const queue = this.#queues.get(sessionID)
    if (!queue?.length) return
    const next = queue.shift()
    if (!queue.length) this.#queues.delete(sessionID)
    // The model is applied on dequeue: doing it on enqueue would switch the model
    // underneath the turn that was still running.
    if (next.model) {
      try {
        await this.setModel(sessionID, next.model)
      } catch (error) {
        this.#emit("session.error", sessionID, { message: error.message })
      }
    }
    this.#startTurn(sessionID, next.text, true, next.attachments ?? [])
  }

  /** Cancelling drops anything still queued, including the messages recorded for it. */
  abort(sessionID) {
    if (this.#historyLoader && !this.#ownedSessions.has(sessionID)) {
      throw new Error("This session is not active in the app")
    }
    const queue = this.#queues.get(sessionID)
    if (queue?.length) {
      const discarded = new Set(queue.map((entry) => entry.messageID))
      this.#queues.delete(sessionID)
      const messages = this.#messages.get(sessionID)
      if (messages) {
        this.#messages.set(sessionID, messages.filter((message) => !discarded.has(message.info.id)))
      }
      this.#emit("message.updated", sessionID)
    }
    this.#turnGenerations.set(sessionID, (this.#turnGenerations.get(sessionID) ?? 0) + 1)
    this.#cancelledSessions.add(sessionID)
    this.#active.delete(sessionID)
    this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
    this.#acp.notify("session/cancel", { sessionId: sessionID })
    this.#emit("session.updated", sessionID)
    this.#persistSnapshot(sessionID)
  }

  status(sessionID) {
    return { type: this.#isBusy(sessionID) ? "busy" : "idle" }
  }

  async flushSnapshots() {
    while (this.#snapshotWrites.size > 0) {
      await Promise.all(this.#snapshotWrites.values())
    }
  }

  #snapshotPath(sessionID) {
    const name = Buffer.from(sessionID).toString("base64url")
    return path.join(this.#snapshotDirectory, `${name}.json`)
  }

  async #restoreSnapshot(sessionID) {
    if (!this.#snapshotDirectory || this.#restoredSnapshots.has(sessionID)) return
    this.#restoredSnapshots.add(sessionID)
    try {
      const snapshot = JSON.parse(await readFile(this.#snapshotPath(sessionID), "utf8"))
      if (snapshot?.version !== 1) return
      if (Array.isArray(snapshot.messages)) this.#messages.set(sessionID, mergeFragmentedPiSnapshot(snapshot.messages))
      if (Array.isArray(snapshot.todos)) this.#todos.set(sessionID, snapshot.todos)
      if (typeof snapshot.title === "string" && snapshot.title) this.#titles.set(sessionID, snapshot.title)
      if (snapshot?.deleted === true) this.#deletedSessions.add(sessionID)
    } catch (error) {
      if (error?.code !== "ENOENT") this.#emit("session.error", sessionID, { message: "Stored session snapshot is unreadable" })
    }
  }

  #persistSnapshot(sessionID) {
    if (!this.#snapshotDirectory) return
    this.#dirtySnapshots.add(sessionID)
    if (this.#snapshotWrites.has(sessionID)) return
    const writing = (async () => {
      await mkdir(this.#snapshotDirectory, { recursive: true })
      while (this.#dirtySnapshots.delete(sessionID)) {
        const snapshot = JSON.stringify({
          version: 1,
          messages: this.#messages.get(sessionID) ?? [],
          todos: this.#todos.get(sessionID) ?? [],
          title: this.#titleFor(sessionID),
          deleted: this.#deletedSessions.has(sessionID)
        })
        const target = this.#snapshotPath(sessionID)
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
        await writeFile(temporary, snapshot, { mode: 0o600 })
        await rename(temporary, target)
      }
    })().catch(() => {
      this.#emit("session.error", sessionID, { message: "Session snapshot could not be saved" })
    }).finally(() => {
      this.#snapshotWrites.delete(sessionID)
    })
    this.#snapshotWrites.set(sessionID, writing)
  }

  /** A queued prompt is still outstanding work, so the session must not read as idle between turns. */
  #isBusy(sessionID) {
    return this.#active.has(sessionID) || Boolean(this.#queues.get(sessionID)?.length)
  }

  /**
   * Displaying an external session deliberately skips the ACP load, but config options only
   * arrive with it, so a session this process did not create reported no models at all — and
   * model switching failed too, since it validates against that list. Pay for the load only
   * when the options are genuinely missing, which keeps opening a session cheap.
   */
  async #loadForConfigOptions(sessionID) {
    await this.#load(sessionID)
    if (this.#configOptions.has(sessionID)) return
    await this.#load(sessionID, true, true)
  }

  async #requireSession(sessionID) {
    await this.#refreshSessions()
    await this.#restoreSnapshot(sessionID)
    if (this.#deletedSessions.has(sessionID) || !this.#sessions.has(sessionID)) {
      throw new Error("Harness session not found")
    }
  }

  async #load(sessionID, force = false, requireConfigOptions = false) {
    if (!this.#sessions.has(sessionID)) await this.listSessions()
    if (this.#deletedSessions.has(sessionID)) throw new Error("Harness session not found")
    const session = this.#sessions.get(sessionID)
    if (!session) throw new Error("Harness session not found")
    if (!force && this.#loaded.has(sessionID)) return
    // Config options only arrive with a real ACP session/load, which a harness may refuse —
    // Codex does for any conversation another client holds open. Sharing one in-flight load
    // between callers that need those options and callers that only want the transcript meant
    // the refusal failed `messages` too, so opening such a session broke whenever the app asked
    // for both at once, which it does on every open. Each kind of load is tracked separately,
    // and a caller that never needed the options retries on its own rather than inheriting a
    // failure that does not apply to it.
    const inFlight = this.#loads.get(sessionID)
    if (inFlight && (inFlight.requireConfigOptions || !requireConfigOptions)) {
      try {
        await inFlight.promise
        return
      } catch (error) {
        if (requireConfigOptions || !inFlight.requireConfigOptions) throw error
      }
    }
    const promise = this.#loadSession(sessionID, requireConfigOptions)
    this.#loads.set(sessionID, { promise, requireConfigOptions })
    try {
      await promise
    } finally {
      if (this.#loads.get(sessionID)?.promise === promise) this.#loads.delete(sessionID)
    }
  }

  async #loadSession(sessionID, requireConfigOptions = false, replaceHistory = false) {
    const session = this.#sessions.get(sessionID)
    if (!session) throw new Error("Harness session not found")
    await this.#restoreSnapshot(sessionID)
    const authoritativeState = await this.#refreshActionState(sessionID, false)
    let previousMessages = mergeFragmentedPiSnapshot(this.#messages.get(sessionID) ?? [])
    const previousTodos = this.#todos.get(sessionID) ?? []
    const previousMessageSnapshot = semanticHistorySignature(previousMessages)
    if (this.#historyLoader) {
      try {
        const persistedMessages = await this.#historyLoader(sessionID, {
          activeSessionLeaf: authoritativeState?.activeSessionLeaf
        })
        if (persistedMessages.length > 0 || authoritativeState) {
          previousMessages = authoritativeState
            ? persistedMessages
            : mergeExternalHistory(persistedMessages, previousMessages)
          previousMessages = mergeFragmentedPiSnapshot(previousMessages)
          this.#messages.set(sessionID, previousMessages)
          if (!this.#ownedSessions.has(sessionID) && !requireConfigOptions) {
            this.#todos.set(sessionID, [])
            this.#loaded.add(sessionID)
            this.#persistSnapshot(sessionID)
            return
          }
        }
      } catch {
        this.#emit("session.error", sessionID, { message: "Harness session history could not be read" })
      }
    }
    this.#replaying.add(sessionID)
    this.#messages.set(sessionID, [])
    this.#todos.set(sessionID, [])
    this.#chunkMessageIDs.delete(`${sessionID}:user`)
    this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
    try {
      const result = await this.#acp.request("session/load", { sessionId: sessionID, cwd: session.cwd, mcpServers: [] }, 300_000)
      // PI can resolve session/load just before its final replay notifications drain from stdout,
      // especially through the Windows cmd/npx pipe. Profiles can opt into a short replay tail so
      // those assistant chunks remain historical output instead of being rejected as unsolicited
      // live output. Other ACP harnesses keep the zero-delay default.
      if (this.#replaySettleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.#replaySettleMs))
      }
      this.#rememberConfigOptions(sessionID, result.configOptions)
      const replayedMessages = mergeFragmentedPiSnapshot(this.#messages.get(sessionID) ?? [])
      this.#messages.set(sessionID, replaceHistory ? replayedMessages : mergeReplay(previousMessages, replayedMessages))
      const replayedTodos = this.#todos.get(sessionID) ?? []
      this.#todos.set(sessionID, replaceHistory ? replayedTodos : mergeTodos(previousTodos, replayedTodos))
      if (semanticHistorySignature(this.#messages.get(sessionID) ?? []) !== previousMessageSnapshot) {
        this.#resetActionsForSessionChange(sessionID)
      }
      this.#loaded.add(sessionID)
      this.#persistSnapshot(sessionID)
    } catch (error) {
      this.#messages.set(sessionID, previousMessages)
      this.#todos.set(sessionID, previousTodos)
      throw error
    } finally {
      this.#replaying.delete(sessionID)
    }
  }

  async #refreshSessions() {
    if (!this.#sessionListing) {
      this.#sessionListing = this.#acp.listSessions().then((sessions) => {
        const listed = new Set()
        const refreshed = sessions.map((session) => {
          listed.add(session.sessionId)
          const known = this.#sessions.get(session.sessionId)
          const updatedAt = this.#preserveListedTimestamps && known?.updatedAt
            ? known.updatedAt
            : session.updatedAt ?? known?.updatedAt ?? new Date().toISOString()
          const normalized = { ...session, updatedAt }
          this.#sessions.set(normalized.sessionId, normalized)
          return normalized
        })
        for (const [sessionID, session] of this.#sessions) {
          if (this.#ownedSessions.has(sessionID) && !listed.has(sessionID)) refreshed.push(session)
        }
        return refreshed
      }).finally(() => {
        this.#sessionListing = undefined
      })
    }
    return this.#sessionListing
  }

  #rememberConfigOptions(sessionID, configOptions) {
    if (Array.isArray(configOptions)) this.#configOptions.set(sessionID, configOptions)
  }

  #recordPrompt(sessionID, text, attachments = []) {
    const messageID = randomUUID()
    const messages = this.#messages.get(sessionID) ?? []
    this.#messages.set(sessionID, messages)
    messages.push({
      info: { id: messageID, role: "user", sessionID, time: { created: Date.now() } },
      parts: [
        { id: `${messageID}:text`, type: "text", text },
        ...attachments.map((attachment, index) => ({
          id: `${messageID}:file:${index}`,
          type: "file",
          mime: attachment.mime,
          filename: attachment.filename,
          url: `data:${attachment.mime};base64,${attachment.data}`
        }))
      ]
    })
    this.#promptAcknowledgements.set(sessionID, { text, received: "" })
    this.#emit("message.updated", sessionID)
    this.#persistSnapshot(sessionID)
    return messageID
  }

  /** ACP session listings may carry no title, so keep the creation title or derive one from the first prompt. */
  #titleFor(sessionID) {
    const known = this.#titles.get(sessionID)
    if (known) return known
    const firstPrompt = this.#messages.get(sessionID)?.find((message) => message.info.role === "user")
    const text = firstPrompt?.parts?.[0]?.text?.trim()
    if (!text) return undefined
    const derived = text.split("\n")[0].slice(0, 60)
    this.#titles.set(sessionID, derived)
    return derived
  }

  #isAcknowledgedPromptChunk(sessionID, text) {
    const acknowledgement = this.#promptAcknowledgements.get(sessionID)
    if (!acknowledgement) return false
    const received = acknowledgement.received + text
    if (!acknowledgement.text.startsWith(received)) return false
    acknowledgement.received = received
    if (received === acknowledgement.text) this.#promptAcknowledgements.delete(sessionID)
    return true
  }

  #handleNotification({ method, params }) {
    if (method !== "session/update" || !params?.sessionId || !params.update) return
    const { sessionId, update } = params
    const replaying = this.#replaying.has(sessionId)
    const session = this.#sessions.get(sessionId)
    if (update.sessionUpdate === "available_commands_update") {
      const commands = Array.isArray(update.availableCommands)
        ? update.availableCommands.filter((command) => typeof command?.name === "string")
        : []
      this.#commandCatalogs.set(sessionId, commands)
      for (const resolve of this.#commandCatalogWaiters.get(sessionId) ?? []) resolve()
      this.#commandCatalogWaiters.delete(sessionId)
      if (!replaying) this.#emit("session.updated", sessionId)
      return
    }
    if (update.sessionUpdate === "plan") {
      const todos = update.entries.map((entry, index) => ({
        id: `${sessionId}:${index}`,
        content: entry.content,
        status: entry.status,
        priority: entry.priority ?? "medium"
      }))
      this.#todos.set(sessionId, todos)
      if (!replaying && session) session.updatedAt = new Date().toISOString()
      if (!replaying) this.#emit("todo.updated", sessionId)
      if (!replaying) this.#persistSnapshot(sessionId)
      return
    }
    if (update.sessionUpdate === "tool_call") {
      if (!replaying && (!this.#active.has(sessionId) || this.#cancelledSessions.has(sessionId))) return
      const chunkKey = `${sessionId}:assistant`
      const messageID = this.#chunkMessageIDs.get(chunkKey) ?? randomUUID()
      this.#chunkMessageIDs.set(chunkKey, messageID)
      const messages = this.#messages.get(sessionId) ?? []
      this.#messages.set(sessionId, messages)
      let message = messages.find((item) => item.info.id === messageID)
      if (!message) {
        message = {
          info: { id: messageID, role: "assistant", sessionID: sessionId, time: { created: Date.now() } },
          parts: []
        }
        messages.push(message)
      }
      message.parts.push({
        id: update.toolCallId,
        messageID,
        type: "tool",
        tool: update._meta?.toolName ?? update.title,
        callID: update.toolCallId,
        state: {
          status: update.status === "in_progress" ? "running" : update.status,
          input: update.rawInput,
          title: update.title,
          time: { start: Date.now() }
        }
      })
      if (!replaying) this.#emit("message.updated", sessionId)
      return
    }
    if (update.sessionUpdate === "tool_call_update") {
      const tool = (this.#messages.get(sessionId) ?? [])
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.callID === update.toolCallId)
      if (!tool?.state) return
      const output = update.rawOutput ?? update.content
        ?.flatMap((item) => item.type === "content" && item.content?.type === "text" ? [item.content.text] : [])
        .join("")
      tool.state.status = update.status === "in_progress" ? "running" : update.status === "failed" ? "error" : update.status
      if (output) tool.state.output = typeof output === "string" ? output : JSON.stringify(output)
      if (tool.state.time && ["completed", "error"].includes(tool.state.status)) tool.state.time.end = Date.now()
      if (!replaying) this.#emit("message.updated", sessionId)
      return
    }
    const thought = update.sessionUpdate === "agent_thought_chunk"
    const messageChunk = update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk"
    if (!thought && !messageChunk) return
    // A replayed image becomes a file part, so reopening a session still shows what was attached.
    // Replay only: a live turn already recorded its own attachment in #recordPrompt, so accepting an
    // image chunk there would draw the same thumbnail twice. OMP is not observed to echo a live
    // prompt back (see docs/DEPENDENCIES.md), which makes this a guard rather than a workaround.
    const image = replaying
      && messageChunk
      && update.content?.type === "image"
      && typeof update.content.data === "string"
      && update.content.data
      ? {
        mime: typeof update.content.mimeType === "string" && update.content.mimeType ? update.content.mimeType : "image/png",
        data: update.content.data
      }
      : undefined
    if (!image && (update.content?.type !== "text" || !update.content.text)) return
    const role = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant"
    const partType = thought ? "reasoning" : image ? "file" : "text"
    // Acknowledgements only suppress a live echo of the prompt we just recorded;
    if (role === "assistant" && !replaying && this.#cancelledSessions.has(sessionId)) return
    if (role === "assistant" && !replaying && !this.#active.has(sessionId) && !this.#promptedSessions.has(sessionId)) return
    if (role === "user" && !replaying && this.#isAcknowledgedPromptChunk(sessionId, update.content.text)) return
    if (role === "user" && !image && isHarnessInjectedText(update.content.text)) return
    if (!replaying && session) session.updatedAt = new Date().toISOString()
    const counterpartKey = `${sessionId}:${role === "user" ? "assistant" : "user"}`
    this.#chunkMessageIDs.delete(counterpartKey)
    const chunkKey = `${sessionId}:${role}`
    // PI sends a new message id for every streaming fragment. During a live turn the bridge's
    // id is authoritative, so all adjacent fragments remain one Markdown message. Replay keeps
    // adapter ids because it reconstructs historical conversation boundaries.
    const messageID = !replaying && role === "assistant"
      ? this.#chunkMessageIDs.get(chunkKey) ?? update.messageId ?? randomUUID()
      : update.messageId ?? this.#chunkMessageIDs.get(chunkKey) ?? randomUUID()
    this.#chunkMessageIDs.set(chunkKey, messageID)
    const messages = this.#messages.get(sessionId) ?? []
    this.#messages.set(sessionId, messages)
    let message = messages.find((item) => item.info.id === messageID)
    if (!message) {
      message = {
        info: { id: messageID, role, sessionID: sessionId, time: { created: Date.now() } },
        parts: []
      }
      messages.push(message)
    }
    const previous = message.parts.at(-1)
    const now = Date.now()
    if (previous?.type === "reasoning" && partType !== "reasoning" && previous.time && !previous.time.end) {
      previous.time.end = now
    }
    if (image) {
      message.parts.push({
        id: `${messageID}:file:${message.parts.length}`,
        messageID,
        type: "file",
        mime: image.mime,
        url: `data:${image.mime};base64,${image.data}`
      })
    } else if (previous?.type === partType) {
      previous.text += update.content.text
    } else {
      message.parts.push({
        id: `${messageID}:${partType}:${message.parts.length}`,
        messageID,
        type: partType,
        text: update.content.text,
        ...(partType === "reasoning" ? { time: { start: now } } : {})
      })
    }
    if (!replaying) this.#emit("message.updated", sessionId)
  }

  #emit(type, sessionId, extra = {}) {
    const event = { type, sessionId, ...extra }
    for (const listener of this.#listeners) listener(event)
  }
}
