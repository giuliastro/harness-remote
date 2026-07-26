import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

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

function messageSignature(message) {
  return `${message?.info?.role ?? ""}\u0000${(message?.parts ?? []).map((part) => part?.text ?? "").join("")}`
}

function mergeReplay(previous, replayed) {
  if (previous.length === 0) return replayed
  if (replayed.length === 0) return previous
  const left = previous.map(messageSignature)
  const right = replayed.map(messageSignature)
  const common = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1))
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      common[leftIndex][rightIndex] = left[leftIndex] === right[rightIndex]
        ? common[leftIndex + 1][rightIndex + 1] + 1
        : Math.max(common[leftIndex + 1][rightIndex], common[leftIndex][rightIndex + 1])
    }
  }
  const merged = []

  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      merged.push(previous[leftIndex])
      leftIndex += 1
      rightIndex += 1
    } else if (common[leftIndex + 1][rightIndex] >= common[leftIndex][rightIndex + 1]) {
      merged.push(previous[leftIndex])
      leftIndex += 1
    } else {
      merged.push(replayed[rightIndex])
      rightIndex += 1
    }
  }
  return [...merged, ...previous.slice(leftIndex), ...replayed.slice(rightIndex)]
}

function mergeExternalHistory(persisted, cached) {
  const persistedIDs = new Set(persisted.map((message) => message.info.id))
  const persistedBySignature = new Map()
  for (const message of persisted) {
    const signature = messageSignature(message)
    const times = persistedBySignature.get(signature) ?? []
    times.push(message.info.time.created)
    persistedBySignature.set(signature, times)
  }
  const cachedOnly = cached.filter((message) => {
    if (persistedIDs.has(message.info.id)) return false
    const duplicateTimes = persistedBySignature.get(messageSignature(message)) ?? []
    return !duplicateTimes.some((created) => Math.abs(created - message.info.time.created) < 30_000)
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

export class AcpService {
  #acp
  #sessions = new Map()
  #messages = new Map()
  #todos = new Map()
  #configOptions = new Map()
  #loaded = new Set()
  #loads = new Map()
  #sessionListing
  #replaying = new Set()
  #historyLoader
  #ownedSessions = new Set()
  #promptAcknowledgements = new Map()
  #titles = new Map()
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
  constructor(acp, { snapshotDirectory, historyLoader } = {}) {
    this.#acp = acp
    this.#snapshotDirectory = snapshotDirectory
    this.#historyLoader = historyLoader
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
      title: title || "Mobile session",
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

  async messages(sessionID, refresh = false) {
    await this.#refreshSessions()
    await this.#restoreSnapshot(sessionID)
    const externalHistory = Boolean(this.#historyLoader && !this.#ownedSessions.has(sessionID))
    await this.#load(sessionID, refresh || externalHistory)
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
    await this.#load(sessionID)
    const option = this.#configOptions.get(sessionID)?.find((item) => item.id === "model")
    return option?.options?.map((candidate) => ({ ...candidate, currentValue: candidate.value === option.currentValue })) ?? []
  }

  async setModel(sessionID, model) {
    await this.#load(sessionID)
    const option = this.#configOptions.get(sessionID)?.find((item) => item.id === "model")
    if (!option?.options?.some((candidate) => candidate.value === model)) {
      throw new Error(`Harness model is not available: ${model}`)
    }
    await this.#acp.request("session/set_config_option", { sessionId: sessionID, configId: "model", value: model })
    option.currentValue = model
  }

  /**
   * ACP accepts one turn per session at a time, so a prompt sent while the agent is
   * still working is queued rather than rejected. It is recorded straight away, which
   * is what makes it visible in the conversation while it waits.
   */
  async prompt(sessionID, text, model) {
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
    if (this.#active.has(sessionID)) {
      const messageID = this.#recordPrompt(sessionID, text)
      const queue = this.#queues.get(sessionID) ?? []
      queue.push({ text, model, messageID })
      this.#queues.set(sessionID, queue)
      this.#emit("session.updated", sessionID)
      return
    }
    if (model) await this.setModel(sessionID, model)
    this.#startTurn(sessionID, text)
  }

  #startTurn(sessionID, text, recorded = false) {
    const generation = (this.#turnGenerations.get(sessionID) ?? 0) + 1
    this.#turnGenerations.set(sessionID, generation)
    this.#cancelledSessions.delete(sessionID)
    this.#promptedSessions.add(sessionID)
    if (!recorded) this.#recordPrompt(sessionID, text)
    this.#active.add(sessionID)
    this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
    this.#emit("session.updated", sessionID)
    void this.#acp.request("session/prompt", {
      sessionId: sessionID,
      prompt: [{ type: "text", text }]
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
    this.#startTurn(sessionID, next.text, true)
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
      if (Array.isArray(snapshot.messages)) this.#messages.set(sessionID, snapshot.messages)
      if (Array.isArray(snapshot.todos)) this.#todos.set(sessionID, snapshot.todos)
      if (typeof snapshot.title === "string" && snapshot.title) this.#titles.set(sessionID, snapshot.title)
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
          title: this.#titleFor(sessionID)
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

  async #load(sessionID, force = false) {
    if (!this.#sessions.has(sessionID)) await this.listSessions()
    const session = this.#sessions.get(sessionID)
    if (!session) throw new Error("Harness session not found")
    if (!force && this.#loaded.has(sessionID)) return
    let loading = this.#loads.get(sessionID)
    if (!loading) {
      loading = this.#loadSession(sessionID)
      this.#loads.set(sessionID, loading)
    }
    try {
      await loading
    } finally {
      if (this.#loads.get(sessionID) === loading) this.#loads.delete(sessionID)
    }
  }

  async #loadSession(sessionID) {
    const session = this.#sessions.get(sessionID)
    if (!session) throw new Error("Harness session not found")
    await this.#restoreSnapshot(sessionID)
    let previousMessages = this.#messages.get(sessionID) ?? []
    const previousTodos = this.#todos.get(sessionID) ?? []
    if (this.#historyLoader) {
      try {
        const persistedMessages = await this.#historyLoader(sessionID)
        if (persistedMessages.length > 0) {
          previousMessages = mergeExternalHistory(persistedMessages, previousMessages)
          this.#messages.set(sessionID, previousMessages)
          if (!this.#ownedSessions.has(sessionID)) {
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
      this.#rememberConfigOptions(sessionID, result.configOptions)
      const replayedMessages = this.#messages.get(sessionID) ?? []
      this.#messages.set(sessionID, mergeReplay(previousMessages, replayedMessages))
      const replayedTodos = this.#todos.get(sessionID) ?? []
      this.#todos.set(sessionID, mergeTodos(previousTodos, replayedTodos))
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
        for (const session of sessions) this.#sessions.set(session.sessionId, session)
        return sessions
      }).finally(() => {
        this.#sessionListing = undefined
      })
    }
    return this.#sessionListing
  }

  #rememberConfigOptions(sessionID, configOptions) {
    if (Array.isArray(configOptions)) this.#configOptions.set(sessionID, configOptions)
  }

  #recordPrompt(sessionID, text) {
    const messageID = randomUUID()
    const messages = this.#messages.get(sessionID) ?? []
    this.#messages.set(sessionID, messages)
    messages.push({
      info: { id: messageID, role: "user", sessionID, time: { created: Date.now() } },
      parts: [{ id: `${messageID}:text`, type: "text", text }]
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
    if (!replaying && session) session.updatedAt = new Date().toISOString()
    if (update.sessionUpdate === "plan") {
      const todos = update.entries.map((entry, index) => ({
        id: `${sessionId}:${index}`,
        content: entry.content,
        status: entry.status,
        priority: entry.priority ?? "medium"
      }))
      this.#todos.set(sessionId, todos)
      if (!replaying) this.#emit("todo.updated", sessionId)
      if (!replaying) this.#persistSnapshot(sessionId)
      return
    }
    if (update.sessionUpdate !== "user_message_chunk" && update.sessionUpdate !== "agent_message_chunk") return
    if (update.content?.type !== "text" || !update.content.text) return
    const role = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant"
    // Acknowledgements only suppress a live echo of the prompt we just recorded;
    if (role === "assistant" && !replaying && this.#cancelledSessions.has(sessionId)) return
    if (!update.messageId && role === "assistant" && !replaying && !this.#active.has(sessionId) && !this.#promptedSessions.has(sessionId)) return
    if (role === "user" && !replaying && this.#isAcknowledgedPromptChunk(sessionId, update.content.text)) return
    const chunkKey = `${sessionId}:${role}`
    let messageID = update.messageId
    if (!messageID && replaying) {
      // ACP has no message-boundary identifier. PI's adapter emits one full persisted
      // text block per replay update, so keeping each update separate is safer than
      // concatenating unrelated consecutive user or assistant messages.
      messageID = randomUUID()
    } else if (!messageID) {
      messageID = this.#chunkMessageIDs.get(chunkKey) ?? randomUUID()
      this.#chunkMessageIDs.set(chunkKey, messageID)
    }
    const messages = this.#messages.get(sessionId) ?? []
    this.#messages.set(sessionId, messages)
    let message = messages.find((item) => item.info.id === messageID)
    if (!message) {
      message = {
        info: { id: messageID, role, sessionID: sessionId, time: { created: Date.now() } },
        parts: [{ id: `${messageID}:text`, type: "text", text: "" }]
      }
      messages.push(message)
    }
    message.parts[0].text += update.content.text
    if (!replaying) this.#emit("message.updated", sessionId)
  }

  #emit(type, sessionId, extra = {}) {
    const event = { type, sessionId, ...extra }
    for (const listener of this.#listeners) listener(event)
  }
}
