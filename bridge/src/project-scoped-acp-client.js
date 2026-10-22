import path from "node:path"
import { EventEmitter } from "node:events"

const CURSOR_PREFIX = "hr-project-scope:"
const DISCOVERY_PROJECTS_PER_PAGE = 2
const MAX_PROJECT_PROCESSES = 3
let liveProcesses = 0
const processWaiters = []

// Shared by the user connection, catalog connection, and technical-session cleanup.
// A slot is returned only after the old process has actually exited.
export async function acquireProjectProcessSlot() {
  if (liveProcesses >= MAX_PROJECT_PROCESSES) await new Promise((resolve) => processWaiters.push(resolve))
  else liveProcesses += 1
  let released = false
  return () => {
    if (released) return
    released = true
    const next = processWaiters.shift()
    if (next) next()
    else liveProcesses -= 1
  }
}

function normalizedDirectory(directory) {
  return path.resolve(directory)
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function encodeCursor(cursors) {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursors), "utf8").toString("base64url")}`
}

function decodeCursor(cursor) {
  if (typeof cursor !== "string" || !cursor.startsWith(CURSOR_PREFIX)) {
    throw new Error("Invalid project-scoped ACP Session cursor")
  }
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"))
  } catch {
    throw new Error("Invalid project-scoped ACP Session cursor")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid project-scoped ACP Session cursor")
  }
  return parsed
}

function sessionUpdatedAt(session) {
  const parsed = Date.parse(session?.updatedAt ?? "")
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Multiplex an ACP adapter whose native Session index is tied to its process working directory.
 *
 * MiMo 0.1.x resolves a different project database from each cwd. Starting it once from the common
 * ancestor of several configured roots does not produce their union; it selects a third project.
 * This facade keeps the generic AcpService API while owning one real adapter per configured root.
 */
export class ProjectScopedAcpClient extends EventEmitter {
  #roots
  #createClient
  #clients = new Map()
  #sessionRoots = new Map()
  #temporary = new Set()
  #poolTail = Promise.resolve()
  #discoveryTail = Promise.resolve()
  #pages = new Map()
  #epoch = 0
  #maxClients
  #metadata

  constructor({ roots, createClient, maxClients = 2 }) {
    super()
    if (!Array.isArray(roots) || roots.length === 0) throw new Error("Project-scoped ACP requires at least one root")
    if (typeof createClient !== "function") throw new Error("Project-scoped ACP requires a client factory")
    this.#roots = [...new Set(roots.map(normalizedDirectory))]
    this.#createClient = createClient
    this.#maxClients = Math.max(1, Math.min(2, maxClients))
  }

  get agentInfo() { return this.#metadata?.agentInfo }
  get promptCapabilities() { return this.#metadata?.promptCapabilities ?? {} }
  get sessionCapabilities() { return this.#metadata?.sessionCapabilities ?? {} }
  get processID() { return this.#clients.values().next().value?.client.processID }

  diagnostics() {
    const projects = [...this.#clients.entries()].map(([root, entry]) => ({
      root,
      ...(entry.client.diagnostics?.() ?? {}),
      activeRequests: entry.busy
    }))
    return {
      state: projects.some((project) => project.state === "running") ? "running" : "configured",
      projectScoped: true,
      configuredProjectCount: this.#roots.length,
      activeProjectCount: this.#clients.size,
      maxProjectCount: this.#maxClients,
      temporaryProcessCount: this.#temporary.size,
      processBudget: { limit: MAX_PROJECT_PROCESSES, live: liveProcesses, waiting: processWaiters.length },
      projects
    }
  }

  async start(...args) {
    // Machine/status reads must not keep the oldest project artificially most-recently-used.
    // Re-enter start only when the actual child needs a handshake or restart.
    const first = this.#clients.values().next().value
    if (this.#metadata && first?.client.diagnostics?.().state === "running") return
    const root = this.#clients.keys().next().value ?? this.#roots[0]
    await this.#withClient(root, () => {}, args)
  }

  async listSessionPage(cursor) {
    const key = cursor || ""
    const cached = this.#pages.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.promise
    const epoch = this.#epoch
    const promise = this.#discoveryTail.catch(() => {}).then(() => this.#listSessionPage(cursor, epoch))
    this.#discoveryTail = promise.catch(() => {})
    const item = { promise, expiresAt: Date.now() + 30_000 }
    this.#pages.set(key, item)
    if (this.#pages.size > 32) this.#pages.delete(this.#pages.keys().next().value)
    void promise.catch(() => { if (this.#pages.get(key) === item) this.#pages.delete(key) })
    return promise
  }

  async #listSessionPage(cursor, epoch) {
    this.#assertEpoch(epoch)
    const requested = cursor ? decodeCursor(cursor) : Object.fromEntries(this.#roots.map((root) => [root, null]))
    const pendingProjects = Object.entries(requested)
    for (const [root] of pendingProjects) {
      if (!this.#roots.includes(root)) throw new Error("Project-scoped ACP cursor references an unknown root")
    }
    // Pages may be requested concurrently by several UI surfaces. Serialize the scan, share equal
    // requests, and wait for each temporary reader to exit before moving to the next project.
    const pages = []
    for (const [root, projectCursor] of pendingProjects.slice(0, DISCOVERY_PROJECTS_PER_PAGE)) {
      this.#assertEpoch(epoch)
      const read = async (client) => {
        const page = await client.listSessionPage(projectCursor || undefined)
        for (const session of page.sessions) {
          // A parent/global index can enumerate a Session served only from its own cwd. Discovery
          // must never overwrite the writer association established by a successful new/load RPC.
          if (!this.#sessionRoots.has(session.sessionId)) {
            this.#sessionRoots.set(session.sessionId, session.cwd ? normalizedDirectory(session.cwd) : root)
          }
        }
        return page
      }
      const page = this.#clients.has(root)
        ? await this.#withClient(root, read)
        : await this.#readTemporary(root, read, epoch)
      pages.push({ root, page })
    }
    const sessions = pages
      .flatMap(({ page }) => page.sessions)
      .filter((session, index, all) => all.findIndex((candidate) => candidate.sessionId === session.sessionId) === index)
      .sort((left, right) => sessionUpdatedAt(right) - sessionUpdatedAt(left))
    const next = Object.fromEntries([
      ...pendingProjects.slice(DISCOVERY_PROJECTS_PER_PAGE),
      ...pages.flatMap(({ root, page }) => page.nextCursor ? [[root, page.nextCursor]] : [])
    ])
    return {
      sessions,
      ...(Object.keys(next).length ? { nextCursor: encodeCursor(next) } : {})
    }
  }

  async listSessions() {
    const sessions = new Map()
    const seenCursors = new Set()
    let cursor
    do {
      const page = await this.listSessionPage(cursor)
      for (const session of page.sessions) sessions.set(session.sessionId, session)
      cursor = page.nextCursor
      if (cursor && seenCursors.has(cursor)) throw new Error("Project-scoped ACP repeated a Session cursor")
      if (cursor) seenCursors.add(cursor)
    } while (cursor)
    return [...sessions.values()].sort((left, right) => sessionUpdatedAt(right) - sessionUpdatedAt(left))
  }

  async request(method, params = {}, ...rest) {
    const root = this.#rootForRequest(method, params)
    const result = await this.#withClient(root, async (client) => {
      const response = await client.request(method, params, ...rest)
      const sessionID = response?.sessionId ?? params?.sessionId
      if (typeof sessionID === "string" && sessionID) this.#sessionRoots.set(sessionID, root)
      return response
    })
    if (method !== "session/load" && method !== "session/resume") this.#pages.clear()
    return result
  }

  async withSession(sessionID, directory, operation) {
    const root = this.#sessionRoots.get(sessionID) ?? (directory ? normalizedDirectory(directory) : this.#roots[0])
    return this.#withClient(root, operation)
  }

  notify(method, params = {}) {
    const entry = this.#clients.get(this.#rootForRequest(method, params))
    if (!entry) throw new Error("The project adapter is closed; reopen the Session before continuing")
    return entry.client.notify(method, params)
  }

  async close() {
    this.#epoch += 1
    this.#pages.clear()
    const entries = [...this.#clients.entries()]
    this.#clients.clear()
    await Promise.all([...entries.map(([root, entry]) => this.#stopEntry(root, entry)),
      ...[...this.#temporary].map((entry) => this.#stopEntry(null, entry))])
  }

  #assertEpoch(epoch) {
    if (epoch !== this.#epoch) throw new Error("Project adapter discovery was closed")
  }

  async #stopEntry(root, entry) {
    if (entry.closing) return entry.closing
    entry.retiring = true
    entry.closing = (async () => {
      if (root) {
        const sessionIDs = [...this.#sessionRoots].filter(([, owner]) => owner === root).map(([id]) => id)
        if (sessionIDs.length) this.emit("sessions-closed", sessionIDs)
      }
      await entry.client.close?.()
      entry.release()
      this.#temporary.delete(entry)
    })()
    return entry.closing
  }

  async #readTemporary(root, read, epoch) {
    const release = await acquireProjectProcessSlot()
    let entry
    try {
      this.#assertEpoch(epoch)
      entry = { client: this.#createClient(root), release }
      this.#temporary.add(entry)
      return await read(entry.client)
    } finally {
      if (entry) await this.#stopEntry(null, entry)
      else release()
    }
  }

  async #withClient(root, operation, startArgs = []) {
    const epoch = this.#epoch
    const acquiring = this.#poolTail.catch(() => {}).then(async () => {
      this.#assertEpoch(epoch)
      let entry = this.#clients.get(root)
      if (!entry) {
        if (this.#clients.size >= this.#maxClients) {
          const oldestIdle = () => [...this.#clients].filter(([, item]) => item.busy === 0)
            .sort(([, left], [, right]) => left.lastUsed - right.lastUsed)[0]
          let idle = oldestIdle()
          // Completed RPCs keep their lease through the caller's current microtask chain, so the
          // service can adopt the native handle before an eviction invalidates it.
          if (!idle) { await new Promise((resolve) => setImmediate(resolve)); idle = oldestIdle() }
          if (!idle) throw new Error(`MiMo is busy in ${this.#maxClients} projects. Stop or finish one before opening another project.`)
          this.#clients.delete(idle[0])
          await this.#stopEntry(...idle)
        }
        const release = await acquireProjectProcessSlot()
        try {
          this.#assertEpoch(epoch)
          entry = { client: this.#createClient(root), release, busy: 0, lastUsed: Date.now() }
          this.#clients.set(root, entry)
          this.#forwardEvents(root, entry)
        } catch (error) { release(); throw error }
      }
      entry.busy += 1
      return entry
    })
    this.#poolTail = acquiring.catch(() => {})
    const entry = await acquiring
    try {
      await entry.client.start(...startArgs)
      this.#metadata = { agentInfo: entry.client.agentInfo, promptCapabilities: entry.client.promptCapabilities,
        sessionCapabilities: entry.client.sessionCapabilities }
      return await operation(entry.client)
    } finally {
      entry.lastUsed = Date.now()
      setImmediate(() => { entry.busy -= 1 })
    }
  }

  #forwardEvents(root, entry) {
    for (const eventName of ["notification", "agent-request", "request", "stderr", "protocol-error", "permission"]) {
      entry.client.on?.(eventName, (...args) => this.emit(eventName, ...args))
    }
    entry.client.on?.("exit", (...args) => {
      // Retiring one idle project is normal pool maintenance, not a machine disconnection.
      // Broadcasting that exit made the browser reconnect and rediscover every project.
      if (entry.retiring) return
      const sessionIDs = [...this.#sessionRoots].filter(([, owner]) => owner === root).map(([id]) => id)
      if (sessionIDs.length) this.emit("sessions-closed", sessionIDs)
      if (![...this.#clients.values()].some((other) => other !== entry && other.client.processID)) {
        this.emit("exit", ...args)
      }
    })
  }

  #rootForDirectory(directory) {
    if (typeof directory !== "string" || !directory) return this.#roots[0]
    const resolved = normalizedDirectory(directory)
    return this.#roots
      .filter((root) => isWithin(root, resolved))
      .sort((left, right) => right.length - left.length)[0] ?? this.#roots[0]
  }

  #rootForRequest(method, params) {
    // MiMo can enumerate a historical Session from a parent/global index while refusing to load it
    // in that same process. session/load succeeds only when the adapter itself starts in the
    // Session's native cwd. Bind the returned id to that process so prompt/model/cancel stay on it.
    if (["session/new", "session/load", "session/resume"].includes(method)
      && typeof params?.cwd === "string" && params.cwd) {
      return normalizedDirectory(params.cwd)
    }
    if (typeof params?.sessionId === "string" && this.#sessionRoots.has(params.sessionId)) {
      return this.#sessionRoots.get(params.sessionId)
    }
    if (typeof params?.cwd === "string" && params.cwd) return this.#rootForDirectory(params.cwd)
    return this.#roots[0]
  }
}
