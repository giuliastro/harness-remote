import { randomUUID } from "node:crypto"
import path from "node:path"

function toEpoch(value) {
  const epoch = Date.parse(value ?? "")
  return Number.isFinite(epoch) ? epoch : Date.now()
}

/** OMP reports native paths; the app may send them in either separator form. */
export function sameDirectory(left, right) {
  if (!left || !right) return false
  const normalize = (value) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, "")
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

function sessionView(session, status = "idle", title = session.title) {
  return {
    id: session.sessionId,
    title: title || `OMP session ${session.sessionId.slice(0, 8)}`,
    directory: session.cwd,
    time: { created: toEpoch(session.updatedAt), updated: toEpoch(session.updatedAt) },
    summary: { additions: 0, deletions: 0, files: 0 },
    model: undefined,
    status
  }
}

export class OmpService {
  #acp
  #sessions = new Map()
  #messages = new Map()
  #todos = new Map()
  #configOptions = new Map()
  #loaded = new Set()
  #loads = new Map()
  #sessionListing
  #replaying = new Set()
  #promptAcknowledgements = new Map()
  #titles = new Map()
  #queues = new Map()
  #active = new Set()
  #listeners = new Set()

  constructor(acp) {
    this.#acp = acp
    acp.on("notification", (notification) => this.#handleNotification(notification))
  }

  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async listSessions(directory) {
    const sessions = await this.#refreshSessions()
    return sessions
      .filter((session) => !directory || sameDirectory(session.cwd, directory))
      .map((session) => sessionView(session, this.#isBusy(session.sessionId) ? "busy" : "idle", this.#titleFor(session.sessionId)))
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
    if (title) this.#titles.set(session.sessionId, title)
    if (model) await this.setModel(session.sessionId, model)
    this.#emit("session.created", session.sessionId)
    return sessionView(session, "idle", this.#titleFor(session.sessionId))
  }

  async messages(sessionID, refresh = false) {
    await this.#refreshSessions()
    await this.#load(sessionID, refresh)
    return this.#messages.get(sessionID) ?? []
  }

  async todos(sessionID) {
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
      throw new Error(`OMP model is not available: ${model}`)
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
    await this.#load(sessionID)
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
    if (!recorded) this.#recordPrompt(sessionID, text)
    this.#active.add(sessionID)
    this.#emit("session.updated", sessionID)
    void this.#acp.request("session/prompt", {
      sessionId: sessionID,
      prompt: [{ type: "text", text }]
    }, 300_000).catch((error) => {
      this.#emit("session.error", sessionID, { message: error.message })
    }).finally(() => {
      this.#active.delete(sessionID)
      this.#emit("session.updated", sessionID)
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
    this.#acp.notify("session/cancel", { sessionId: sessionID })
    this.#emit("session.updated", sessionID)
  }

  status(sessionID) {
    return { type: this.#isBusy(sessionID) ? "busy" : "idle" }
  }

  /** A queued prompt is still outstanding work, so the session must not read as idle between turns. */
  #isBusy(sessionID) {
    return this.#active.has(sessionID) || Boolean(this.#queues.get(sessionID)?.length)
  }

  async #load(sessionID, force = false) {
    if (!this.#sessions.has(sessionID)) await this.listSessions()
    const session = this.#sessions.get(sessionID)
    if (!session) throw new Error("OMP session not found")
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
    if (!session) throw new Error("OMP session not found")
    this.#replaying.add(sessionID)
    this.#messages.set(sessionID, [])
    this.#todos.set(sessionID, [])
    try {
      const result = await this.#acp.request("session/load", { sessionId: sessionID, cwd: session.cwd, mcpServers: [] }, 300_000)
      this.#rememberConfigOptions(sessionID, result.configOptions)
      this.#loaded.add(sessionID)
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
    return messageID
  }

  /** OMP session listings carry no title, so keep the creation title or derive one from the first prompt. */
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
      return
    }
    if (update.sessionUpdate !== "user_message_chunk" && update.sessionUpdate !== "agent_message_chunk") return
    if (update.content?.type !== "text" || !update.content.text) return
    const role = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant"
    // Acknowledgements only suppress a live echo of the prompt we just recorded;
    // a history replay rebuilds from an empty list and must keep every message.
    if (role === "user" && !replaying && this.#isAcknowledgedPromptChunk(sessionId, update.content.text)) return
    const messageID = update.messageId ?? randomUUID()
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
