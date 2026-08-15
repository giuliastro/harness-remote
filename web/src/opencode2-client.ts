import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { desktopRequest, isDesktopPlatform } from "./desktopBridge"
import { authHeader, baseUrl, hasCredentials } from "./serverConfig"
import type { AttachmentPart } from "./attachments"
import type { ServerConfig } from "./types"
import type {
  DiffFile,
  FileStatusEntry,
  HealthResponse,
  MessageEnvelope,
  ModelSelection,
  PathInfo,
  PermissionRequest,
  ProjectCurrent,
  QuestionRequest,
  SessionStatus,
  TodoItem,
  VcsStatus
} from "./types"
import {
  toAgentOption,
  toCommandOption,
  toDiffFile,
  toFileEntry,
  toMessageEnvelope,
  toModelOption,
  toSession,
  type V2Message,
  type V2Session
} from "./opencode2-mappers"

/**
 * OpenCode 2 (beta) HTTP client.
 *
 * The v2 server API is a rewrite of the v1 surface this app originally spoke: every endpoint lives
 * under `/api/*`, responses are wrapped as `{ data, location?, cursor? }` (pagination cursors ride in
 * the body, not a header), sessions carry their working directory as `location.directory`, and the
 * v1 question flow is replaced by "forms". This module maps those shapes back into the app's existing
 * types so the rest of the UI needs no v2-specific branches.
 */

function unauthorizedDetail(config: ServerConfig): string {
  return hasCredentials(config)
    ? "HTTP 401: the server rejected these credentials."
    : "HTTP 401: this server requires a username and password, and none were sent."
}

function responseDetail(body: unknown): string | null {
  if (!body) return null
  if (typeof body === "string") {
    try {
      return responseDetail(JSON.parse(body)) ?? body
    } catch {
      return body
    }
  }
  if (typeof body === "object") {
    const value = body as { message?: string; _tag?: string }
    return value.message ?? (typeof value._tag === "string" ? value._tag : null) ?? JSON.stringify(body)
  }
  return String(body)
}

type V2Response<T> = {
  data: T
  location?: { directory?: string }
  cursor?: { previous?: string; next?: string }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE"
  body?: unknown
  readTimeout?: number
}

/** One v2 request: builds the `/api/*` path, sends Basic Auth, unwraps `{ data }`, treats 204 as success. */
async function v2Request<T>(config: ServerConfig, path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET"
  if (isDesktopPlatform()) {
    const response = await desktopRequest(config, {
      path,
      method,
      body: options.body,
      readTimeout: options.readTimeout
    })
    if (response.status === 204) return true as T
    return response.data as T
  }

  const target = `${baseUrl(config)}${path}`
  const headers: Record<string, string> = { Accept: "application/json" }
  if (hasCredentials(config)) headers.Authorization = authHeader(config)
  if (options.body !== undefined) headers["Content-Type"] = "application/json"

  if (Capacitor.isNativePlatform()) {
    let response
    try {
      response = await CapacitorHttp.request({
        url: target,
        method,
        headers,
        data: options.body,
        connectTimeout: 12_000,
        readTimeout: options.readTimeout ?? 30_000
      })
    } catch {
      throw new Error(`Cannot reach ${config.host}:${config.port}.`)
    }
    if (response.status >= 400) {
      if (response.status === 401) throw new Error(responseDetail(response.data) || unauthorizedDetail(config))
      throw new Error(responseDetail(response.data) || `HTTP ${response.status}`)
    }
    if (response.status === 204) return true as T
    return (response.data as V2Response<T>).data
  }

  let response: Response
  try {
    response = await fetch(target, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    })
  } catch {
    throw new Error(`Cannot reach ${config.host}:${config.port}.`)
  }

  if (!response.ok) {
    let detail = response.status === 401 ? unauthorizedDetail(config) : `HTTP ${response.status}`
    try {
      const body = await response.text()
      detail = responseDetail(body) ?? detail
    } catch {
      // Keep the HTTP status when an interrupted stream cannot be read.
    }
    throw new Error(detail)
  }
  if (response.status === 204) return true as T
  const body = await response.json() as V2Response<T>
  return body.data
}

/** Cursor pagination: v2 carries `cursor.next` in the body rather than a response header. */
async function v2ListAll<T>(config: ServerConfig, path: string, options: RequestOptions = {}): Promise<T[]> {
  const items: T[] = []
  let cursor: string | undefined
  do {
    const cursorPath = cursor ? `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}` : path
    const response = await v2Request<V2Response<T[]>>(config, cursorPath, options)
    items.push(...response.data)
    cursor = response.cursor?.next
  } while (cursor)
  return items
}


export const opencode2Api = {
  eventStream(config: ServerConfig) {
    const headers: Record<string, string> = {}
    if (hasCredentials(config)) headers.Authorization = authHeader(config)
    return { url: `${baseUrl(config)}/api/event`, headers }
  },

  health(config: ServerConfig) {
    return v2Request<HealthResponse>(config, "/api/health").then((health) => ({ ...health, backend: "opencode2" }))
  },

  capabilities() {
    // The v2 server has no capability handshake; the app uses the static defaults for this backend.
    return Promise.resolve(undefined)
  },

  async listSessions(config: ServerConfig, _directory?: string) {
    const list = await v2Request<V2Session[]>(config, "/api/session")
    return list.map(toSession)
  },

  async listGlobalSessions(config: ServerConfig) {
    const all = await v2ListAll<V2Session>(config, "/api/session")
    return all.map(toSession)
  },

  async listStatuses(config: ServerConfig, _directory?: string) {
    // v2 exposes only the set of sessions actively being executed; anything else is idle.
    const active = await v2Request<Record<string, unknown>>(config, "/api/session/active")
    const statuses: Record<string, SessionStatus> = {}
    for (const id of Object.keys(active ?? {})) statuses[id] = { type: "busy" }
    return statuses
  },

  async loadPath(config: ServerConfig, _directory?: string) {
    const location = await v2Request<{ directory: string }>(config, "/api/location")
    const resolved = location.directory ?? ""
    return { home: resolved, state: "", config: "", worktree: resolved, directory: resolved } as PathInfo
  },

  async listFiles(config: ServerConfig, path: string, directory?: string) {
    const response = await v2Request<{
      location?: { directory?: string }
      data: Array<{ path: string; type: "file" | "directory" }>
    }>(config, `/api/fs/list?path=${encodeURIComponent(path)}`)
    const root = response.location?.directory ?? directory ?? ""
    return (response.data ?? []).map((entry) => toFileEntry(entry, root))
  },

  async listCommands(config: ServerConfig) {
    const response = await v2Request<{ data: Array<{ name: string; description?: string }> }>(config, "/api/command")
    return (response.data ?? []).map(toCommandOption)
  },

  async listAgents(config: ServerConfig, _directory?: string) {
    const response = await v2Request<{ data: Array<{ id: string; name?: string; description?: string; mode?: string; hidden?: boolean }> }>(config, "/api/agent")
    return (response.data ?? []).map(toAgentOption).filter((agent) => agent.id && !agent.hidden)
  },

  async listModels(config: ServerConfig, _directory?: string, _sessionID?: string) {
    const [response, defaultResponse] = await Promise.all([
      v2Request<{ data: Array<Record<string, unknown>> }>(config, "/api/model"),
      v2Request<{ data?: Record<string, unknown> | null }>(config, "/api/model/default").catch(() => ({ data: null }))
    ])
    const defaultModelID = defaultResponse?.data && typeof defaultResponse.data === "object"
      ? ((defaultResponse.data as { modelID?: string }).modelID ?? (defaultResponse.data as { id?: string }).id)
      : undefined
    return (response.data ?? []).flatMap((model) => toModelOption(model as Parameters<typeof toModelOption>[0], defaultModelID))
  },

  async createSession(config: ServerConfig, title?: string, model?: ModelSelection, directory?: string) {
    const created = await v2Request<V2Session>(config, "/api/session", {
      method: "POST",
      body: {
        title,
        model: model ? { id: model.modelID, providerID: model.providerID, variant: model.variant } : undefined,
        location: directory ? { directory } : undefined
      }
    })
    return toSession(created)
  },

  async renameSession(config: ServerConfig, id: string, title: string, _directory?: string) {
    await v2Request<boolean>(config, `/api/session/${encodeURIComponent(id)}/rename`, { method: "POST", body: { title } })
    return toSession({ id, title, time: { created: 0, updated: 0 } })
  },

  async deleteSession(config: ServerConfig, id: string, _directory?: string) {
    await v2Request<boolean>(config, `/api/session/${encodeURIComponent(id)}`, { method: "DELETE" })
    return true
  },

  async loadMessages(config: ServerConfig, sessionID: string, _directory?: string, _refreshHistory = false) {
    // `order=asc` makes the server return oldest-first, matching how the app renders transcripts.
    const response = await v2Request<{ data: V2Message[] }>(config, `/api/session/${encodeURIComponent(sessionID)}/message?limit=100&order=asc`)
    return (response.data ?? []).map((message) => toMessageEnvelope(message, sessionID))
  },

  async loadLatestMessage(config: ServerConfig, sessionID: string, _directory?: string) {
    const response = await v2Request<{ data: V2Message[] }>(config, `/api/session/${encodeURIComponent(sessionID)}/message?limit=1&order=desc`)
    return (response.data ?? []).map((message) => toMessageEnvelope(message, sessionID))
  },

  async loadTodo(_config: ServerConfig, _sessionID: string, _directory?: string): Promise<TodoItem[]> {
    return []
  },

  async loadDiff(config: ServerConfig, _sessionID: string, directory?: string) {
    const response = await v2Request<{ data: Array<{ file: string; patch?: string; additions?: number; deletions?: number; status?: string }> }>(config, `/api/vcs/diff?mode=working${directory ? `&location%5Bdirectory%5D=${encodeURIComponent(directory)}` : ""}`)
    return (response.data ?? []).map(toDiffFile)
  },

  async loadMessageDiff(_config: ServerConfig, _sessionID: string, _messageID: string, _directory?: string): Promise<DiffFile[]> {
    // v2 exposes only the working-copy diff, not a per-message snapshot.
    return []
  },

  async loadProjectCurrent(config: ServerConfig, _directory?: string) {
    return v2Request<ProjectCurrent>(config, "/api/project/current")
  },

  async loadVcs(config: ServerConfig, _directory?: string) {
    const response = await v2Request<{ data?: { branch?: Record<string, unknown> } }>(config, "/api/vcs")
    const branch = response?.data?.branch
    return { branch: branch && typeof branch === "object" ? JSON.stringify(branch) : undefined } as VcsStatus
  },

  async loadFileStatus(config: ServerConfig, _directory?: string) {
    const response = await v2Request<{ data: Array<{ file: string; status?: string; additions?: number; deletions?: number }> }>(config, "/api/vcs/status")
    return (response.data ?? []).map((entry) => ({ path: entry.file, file: entry.file, status: entry.status })) as FileStatusEntry[]
  },

  listActions() {
    return Promise.resolve([])
  },

  invokeAction() {
    return Promise.reject(new Error("Session actions are not supported on OpenCode 2"))
  },

  async sendPrompt(config: ServerConfig, sessionID: string, text: string, _directory?: string, model?: ModelSelection, agentID?: string, attachments: AttachmentPart[] = []) {
    // Model and agent are per-session on v2; apply them before prompting so the next turn uses them.
    if (model) {
      await v2Request<boolean>(config, `/api/session/${encodeURIComponent(sessionID)}/model`, {
        method: "POST",
        body: { model: { id: model.modelID, providerID: model.providerID, variant: model.variant } }
      }).catch(() => undefined)
    }
    if (agentID) {
      await v2Request<boolean>(config, `/api/session/${encodeURIComponent(sessionID)}/agent`, {
        method: "POST",
        body: { agent: agentID }
      }).catch(() => undefined)
    }
    await v2Request<boolean>(config, `/api/session/${encodeURIComponent(sessionID)}/prompt`, {
      method: "POST",
      body: {
        text,
        files: attachments.map((attachment) => ({ uri: attachment.url, name: attachment.filename || "attachment" })),
        delivery: "steer",
        resume: true
      },
      readTimeout: 300_000
    })
    return true
  },

  async sendCommand(config: ServerConfig, sessionID: string, command: string, argumentsText: string, _directory?: string, model?: ModelSelection, agentID?: string) {
    if (model) {
      await v2Request<boolean>(config, `/api/session/${encodeURIComponent(sessionID)}/model`, {
        method: "POST",
        body: { model: { id: model.modelID, providerID: model.providerID, variant: model.variant } }
      }).catch(() => undefined)
    }
    if (agentID) {
      await v2Request<boolean>(config, `/api/session/${encodeURIComponent(sessionID)}/agent`, {
        method: "POST",
        body: { agent: agentID }
      }).catch(() => undefined)
    }
    await v2Request<boolean>(config, `/api/session/${encodeURIComponent(sessionID)}/command`, {
      method: "POST",
      body: { command, arguments: argumentsText || undefined },
      readTimeout: 300_000
    })
    return { info: { id: "", role: "user", sessionID, time: { created: Date.now() } }, parts: [] } as MessageEnvelope
  },

  async revertMessage(config: ServerConfig, sessionID: string, messageID: string, _directory?: string) {
    const revert = await v2Request<{ messageID: string; partID?: string }>(config, `/api/session/${encodeURIComponent(sessionID)}/revert/stage`, {
      method: "POST",
      body: { messageID, files: true }
    })
    return toSession({ id: sessionID, time: { created: 0, updated: 0 }, revert: { messageID: revert.messageID, partID: revert.partID } })
  },

  async unrevertSession(config: ServerConfig, sessionID: string, _directory?: string) {
    await v2Request<boolean>(config, `/api/session/${encodeURIComponent(sessionID)}/revert/clear`, { method: "POST" })
    return toSession({ id: sessionID, time: { created: 0, updated: 0 } })
  },

  async abort(config: ServerConfig, sessionID: string, _directory?: string) {
    await v2Request<boolean>(config, `/api/session/${encodeURIComponent(sessionID)}/interrupt`, { method: "POST" })
    return true
  },

  async loadQuestions(config: ServerConfig, _directory?: string) {
    const response = await v2Request<{ data: Array<{
      id: string
      sessionID: string
      title?: string
      fields: Array<{
        key: string
        title?: string
        description?: string
        type?: string
        options?: Array<{ value: string; label: string; description?: string }>
        custom?: boolean
      }>
    }> }>(config, "/api/form/request")
    return (response.data ?? []).map((form): QuestionRequest => ({
      id: form.id,
      sessionID: form.sessionID,
      questions: form.fields.map((field) => {
        const isMulti = field.type === "multiselect"
        return {
          question: field.title ?? field.key,
          header: form.title ?? field.title ?? field.key,
          options: (field.options ?? []).map((option) => ({ label: option.label, description: option.description ?? "" })),
          multiple: isMulti,
          custom: field.custom ?? false
        }
      })
    }))
  },

  async replyQuestion(config: ServerConfig, requestID: string, answers: string[][], directory?: string) {
    const forms = await opencode2Api.loadQuestions(config, directory)
    const form = forms.find((candidate) => candidate.id === requestID)
    if (!form) throw new Error("Question form is no longer pending")
    const answer: Record<string, string | string[]> = {}
    form.questions.forEach((question, index) => {
      const key = form.questions.length === 1 ? form.questions[0]!.question : question.question
      answer[key] = (answers[index] ?? []).length > 1 ? answers[index]! : (answers[index] ?? [])[0] ?? ""
    })
    await v2Request<boolean>(config, `/api/session/${encodeURIComponent(form.sessionID)}/form/${encodeURIComponent(requestID)}/reply`, {
      method: "POST",
      body: { answer }
    })
    return true
  },

  async rejectQuestion(config: ServerConfig, requestID: string, directory?: string) {
    const forms = await opencode2Api.loadQuestions(config, directory)
    const form = forms.find((candidate) => candidate.id === requestID)
    if (form) {
      await v2Request<boolean>(config, `/api/session/${encodeURIComponent(form.sessionID)}/form/${encodeURIComponent(requestID)}/cancel`, { method: "POST" })
    }
    return true
  },

  async loadPermissions(config: ServerConfig, _directory?: string) {
    const response = await v2Request<{ data: Array<{
      id: string
      sessionID: string
      action: string
      resources: string[]
      save?: string[]
      metadata?: Record<string, unknown>
      source?: { type?: string; messageID?: string; id?: string }
    }> }>(config, "/api/permission/request")
    return (response.data ?? []).map((request): PermissionRequest => ({
      id: request.id,
      sessionID: request.sessionID,
      permission: request.action,
      patterns: request.resources,
      metadata: request.metadata ?? {},
      always: request.save ?? [],
      tool: request.source
        ? { messageID: request.source.messageID ?? "", callID: request.source.id ?? "" }
        : undefined
    }))
  },

  async replyPermission(config: ServerConfig, requestID: string, reply: "once" | "always" | "reject", directory?: string) {
    const requests = await opencode2Api.loadPermissions(config, directory)
    const request = requests.find((candidate) => candidate.id === requestID)
    if (request) {
      await v2Request<boolean>(config, `/api/session/${encodeURIComponent(request.sessionID)}/permission/${encodeURIComponent(requestID)}/reply`, {
        method: "POST",
        body: { reply }
      })
    }
    return true
  }
}
