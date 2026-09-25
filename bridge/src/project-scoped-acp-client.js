import path from "node:path"
import { EventEmitter } from "node:events"

const CURSOR_PREFIX = "hr-project-scope:"

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

  constructor({ roots, createClient }) {
    super()
    if (!Array.isArray(roots) || roots.length === 0) throw new Error("Project-scoped ACP requires at least one root")
    if (typeof createClient !== "function") throw new Error("Project-scoped ACP requires a client factory")
    this.#roots = [...new Set(roots.map(normalizedDirectory))]
    this.#createClient = createClient
  }

  get agentInfo() { return this.#firstClient()?.agentInfo }
  get promptCapabilities() { return this.#firstClient()?.promptCapabilities ?? {} }
  get sessionCapabilities() { return this.#firstClient()?.sessionCapabilities ?? {} }
  get processID() { return this.#firstClient()?.processID }

  diagnostics() {
    const projects = [...this.#clients.entries()].map(([root, client]) => ({
      root,
      ...(client.diagnostics?.() ?? {})
    }))
    return {
      state: projects.some((project) => project.state === "running") ? "running" : "configured",
      projectScoped: true,
      configuredProjectCount: this.#roots.length,
      activeProjectCount: this.#clients.size,
      projects
    }
  }

  async start(...args) {
    await this.#client(this.#roots[0]).start(...args)
  }

  async listSessionPage(cursor) {
    const requested = cursor ? decodeCursor(cursor) : Object.fromEntries(this.#roots.map((root) => [root, null]))
    const pages = await Promise.all(Object.entries(requested).map(async ([root, projectCursor]) => {
      if (!this.#roots.includes(root)) throw new Error("Project-scoped ACP cursor references an unknown root")
      const page = await this.#client(root).listSessionPage(projectCursor || undefined)
      for (const session of page.sessions) this.#sessionRoots.set(session.sessionId, root)
      return { root, page }
    }))
    const sessions = pages
      .flatMap(({ page }) => page.sessions)
      .filter((session, index, all) => all.findIndex((candidate) => candidate.sessionId === session.sessionId) === index)
      .sort((left, right) => sessionUpdatedAt(right) - sessionUpdatedAt(left))
    const next = Object.fromEntries(pages.flatMap(({ root, page }) => page.nextCursor ? [[root, page.nextCursor]] : []))
    return {
      sessions,
      ...(Object.keys(next).length ? { nextCursor: encodeCursor(next) } : {})
    }
  }

  async listSessions() {
    return (await this.listSessionPage()).sessions
  }

  async request(method, params = {}, ...rest) {
    const root = this.#rootForRequest(method, params)
    const client = this.#client(root)
    await client.start()
    const result = await client.request(method, params, ...rest)
    const sessionID = result?.sessionId ?? params?.sessionId
    if (typeof sessionID === "string" && sessionID) this.#sessionRoots.set(sessionID, root)
    return result
  }

  notify(method, params = {}) {
    return this.#client(this.#rootForRequest(method, params)).notify(method, params)
  }

  close() {
    for (const client of this.#clients.values()) client.close?.()
    this.#clients.clear()
    this.#sessionRoots.clear()
  }

  #firstClient() {
    return this.#clients.get(this.#roots[0])
  }

  #client(root) {
    let client = this.#clients.get(root)
    if (client) return client
    client = this.#createClient(root)
    for (const eventName of ["notification", "agent-request", "request", "exit", "stderr", "protocol-error", "permission"]) {
      client.on?.(eventName, (...args) => this.emit(eventName, ...args))
    }
    this.#clients.set(root, client)
    return client
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
