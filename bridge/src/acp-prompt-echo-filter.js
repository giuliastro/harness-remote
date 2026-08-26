import { EventEmitter } from "node:events"

const DEFAULT_TAIL_MS = 2_000

function promptText(params) {
  return (Array.isArray(params?.prompt) ? params.prompt : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
}

/**
 * Some ACP adapters echo the user prompt back as `user_message_chunk`. AcpService records the local
 * prompt before dispatch so that it is immediately visible, therefore an adapter echo is only an
 * acknowledgement and must not become another user message. A few adapters can repeat that echo,
 * which defeated the service's single acknowledgement guard.
 *
 * Keep this transport filter deliberately narrow: it is active only for the session/prompt request
 * currently being sent, plus a short drain tail for late stdout notifications. A new request, even
 * with identical text, creates a fresh acknowledgement and therefore remains a distinct real turn.
 */
export class AcpPromptEchoFilter extends EventEmitter {
  #acp
  #pending = new Map()
  #tailMs

  constructor(acp, { tailMs = DEFAULT_TAIL_MS } = {}) {
    super()
    this.#acp = acp
    this.#tailMs = tailMs
    acp.on("notification", (notification) => {
      if (!this.#isPromptEcho(notification)) this.emit("notification", notification)
    })
    acp.on?.("request", (request) => this.emit("request", request))
    acp.on?.("exit", (...args) => this.emit("exit", ...args))
    acp.on?.("stderr", (...args) => this.emit("stderr", ...args))
  }

  get promptCapabilities() { return this.#acp.promptCapabilities }
  get agentInfo() { return this.#acp.agentInfo }
  get processID() { return this.#acp.processID }

  start(...args) { return this.#acp.start(...args) }
  listSessions(...args) { return this.#acp.listSessions(...args) }
  notify(...args) { return this.#acp.notify(...args) }
  close(...args) { return this.#acp.close?.(...args) }

  async request(method, params, ...rest) {
    let acknowledgement
    if (method === "session/prompt" && params?.sessionId) {
      const text = promptText(params)
      if (text) {
        acknowledgement = { text, received: "", complete: false, timer: undefined }
        const previous = this.#pending.get(params.sessionId)
        if (previous?.timer) clearTimeout(previous.timer)
        this.#pending.set(params.sessionId, acknowledgement)
      }
    }
    try {
      return await this.#acp.request(method, params, ...rest)
    } finally {
      if (acknowledgement && this.#pending.get(params.sessionId) === acknowledgement) {
        acknowledgement.timer = setTimeout(() => {
          if (this.#pending.get(params.sessionId) === acknowledgement) this.#pending.delete(params.sessionId)
        }, this.#tailMs)
        acknowledgement.timer.unref?.()
      }
    }
  }

  #isPromptEcho(notification) {
    if (notification?.method !== "session/update") return false
    const sessionID = notification.params?.sessionId
    const update = notification.params?.update
    if (!sessionID || update?.sessionUpdate !== "user_message_chunk") return false
    if (update.content?.type !== "text" || typeof update.content.text !== "string") return false
    const acknowledgement = this.#pending.get(sessionID)
    if (!acknowledgement) return false

    const chunk = update.content.text
    if (acknowledgement.complete) return chunk === acknowledgement.text

    const received = acknowledgement.received + chunk
    if (!acknowledgement.text.startsWith(received)) return false
    acknowledgement.received = received
    if (received === acknowledgement.text) acknowledgement.complete = true
    return true
  }
}
