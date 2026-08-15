import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { desktopRequest, isDesktopPlatform } from "./desktopBridge"
import { streamURL } from "./opencode-events"
import { baseUrl, isValidServerConfig } from "./serverConfig"
import type {
  AgentOption,
  CommandInfo,
  DiffFile,
  FileStatusEntry,
  FileEntry,
  HealthResponse,
  HarnessCapabilities,
  HarnessAction,
  HarnessActionResult,
  MessageEnvelope,
  ModelOption,
  ModelSelection,
  ProjectCurrent,
  PathInfo,
  QuestionRequest,
  PermissionRequest,
  ServerConfig,
  Session,
  SessionStatus,
  TodoItem,
  VcsStatus
} from "./types"

function authHeader(config: ServerConfig): string {
  return `Basic ${btoa(`${config.username}:${config.password}`)}`
}

export { baseUrl, isValidServerConfig }

function withDirectory(path: string, directory?: string): string {
  if (!directory) return path
  const joiner = path.includes("?") ? "&" : "?"
  return `${path}${joiner}directory=${encodeURIComponent(directory)}`
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE"
  body?: unknown
  readTimeout?: number
}

type ResponseWithHeaders<T> = {
  data: T
  headers: Record<string, string>
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
    // `data.message` and `message` are OpenCode's shapes; the bridge answers `{ "error": "..." }`,
    // which fell through to the stringify below and put raw JSON on screen — so every bridge
    // failure reached the user as `{"error":"Internal error: ..."}` instead of the sentence in it.
    const value = body as { data?: { message?: string }, message?: string, error?: string }
    const detail = value.data?.message ?? value.message ?? (typeof value.error === "string" ? value.error : undefined)
    return detail ?? JSON.stringify(body)
  }
  return String(body)
}

function normalizeHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  if (!headers) return {}
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value)])
  )
}

type ConfigProvidersResponse = {
  providers: Array<{
    id: string
    name: string
    models: Record<string, {
      id?: string
      name?: string
      description?: string
      status?: string
      capabilities?: {
        attachment?: boolean
        toolcall?: boolean
        tools?: boolean
      }
      limit?: {
        context?: number
        output?: number
      }
      variants?: Record<string, unknown>
    }>
  }>
  default?: Record<string, string>
}

type AgentResponse = Array<{
  id?: string
  name?: string
  description?: string
  mode: "primary" | "subagent" | "all"
  hidden?: boolean
}>

async function requestWithHeaders<T>(config: ServerConfig, path: string, options: RequestOptions = {}): Promise<ResponseWithHeaders<T>> {
  const method = options.method ?? "GET"
  if (isDesktopPlatform()) {
    const response = await desktopRequest(config, {
      path,
      method,
      body: options.body,
      readTimeout: options.readTimeout
    })
    return { data: response.data as T, headers: response.headers }
  }

  const target = `${baseUrl(config)}${path}`
  const headers: Record<string, string> = {
    Accept: "application/json"
  }
  if (config.username && config.password) {
    headers.Authorization = authHeader(config)
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json"
  }

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
      throw new Error(responseDetail(response.data) || `HTTP ${response.status}`)
    }

    const responseHeaders = normalizeHeaders(response.headers)
    if (response.status === 204) return { data: true as T, headers: responseHeaders }
    return { data: response.data as T, headers: responseHeaders }
  }

  let response: Response
  try {
    response = await fetch(target, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    })
  } catch {
    // Kept short: this text reaches a phone screen. The CORS note only means something in a
    // browser, where it is the usual cause, and nothing at all inside the app.
    const corsHint = config.username && config.password
      ? " In a browser, Basic Auth also needs the bridge started with --cors for this origin."
      : ""
    throw new Error(`Cannot reach ${config.host}:${config.port}.${corsHint}`)
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      // A Response body is a one-shot stream. Read it once and let responseDetail
      // parse JSON when applicable, so a plain-text server error remains useful.
      const body = await response.text()
      detail = responseDetail(body) ?? detail
    } catch {
      // Keep the HTTP status when an interrupted stream cannot be read.
    }
    throw new Error(detail)
  }

  const responseHeaders = normalizeHeaders(Object.fromEntries(response.headers.entries()))
  if (response.status === 204) return { data: true as T, headers: responseHeaders }
  return { data: (await response.json()) as T, headers: responseHeaders }
}

async function request<T>(config: ServerConfig, path: string, options: RequestOptions = {}): Promise<T> {
  return (await requestWithHeaders<T>(config, path, options)).data
}

function toAgentOption(agent: AgentResponse[number]): AgentOption {
  const id = agent.id || agent.name || ""
  return {
    id,
    name: agent.name || id,
    description: agent.description,
    mode: agent.mode,
    hidden: agent.hidden
  }
}

function toModelBody(model?: ModelSelection) {
  if (!model) return undefined
  return { providerID: model.providerID, modelID: model.modelID }
}

function toCreateSessionModel(model?: ModelSelection) {
  if (!model) return undefined
  return { providerID: model.providerID, id: model.modelID, variant: model.variant || undefined }
}

function modelWireName(model?: ModelSelection) {
  if (!model) return undefined
  return `${model.providerID}/${model.modelID}`
}

export const api = {
  eventStream(config: ServerConfig) {
    const headers: Record<string, string> = {}
    if (config.username && config.password) headers.Authorization = authHeader(config)
    return { url: streamURL(baseUrl(config), "global"), headers }
  },

  health(config: ServerConfig) {
    return request<HealthResponse>(config, "/global/health")
  },

  capabilities(config: ServerConfig) {
    return request<HarnessCapabilities>(config, "/v1/capabilities")
  },

  listSessions(config: ServerConfig, directory?: string) {
    return request<Session[]>(config, withDirectory("/session", directory))
  },

  async listGlobalSessions(config: ServerConfig) {
    const sessions: Session[] = []
    let cursor: string | undefined
    do {
      const path = cursor ? `/experimental/session?cursor=${encodeURIComponent(cursor)}` : "/experimental/session"
      const response = await requestWithHeaders<Session[]>(config, path)
      sessions.push(...response.data)
      cursor = response.headers["x-next-cursor"]
    } while (cursor)
    return sessions
  },

  listStatuses(config: ServerConfig, directory?: string) {
    return request<Record<string, SessionStatus>>(config, withDirectory("/session/status", directory))
  },

  loadPath(config: ServerConfig, directory?: string) {
    return request<PathInfo>(config, withDirectory("/path", directory))
  },

  listFiles(config: ServerConfig, path: string, directory?: string) {
    return request<FileEntry[]>(config, withDirectory(`/file?path=${encodeURIComponent(path)}`, directory))
  },

  listCommands(config: ServerConfig) {
    return request<CommandInfo[]>(config, "/command")
  },

  async listAgents(config: ServerConfig, directory?: string) {
    const agents = await request<AgentResponse>(config, withDirectory("/agent", directory))
    return agents.map(toAgentOption).filter((agent) => agent.id && !agent.hidden)
  },

  async listModels(config: ServerConfig, directory?: string, sessionID?: string) {
    const path = withDirectory("/config/providers", directory)
    const sessionPath = sessionID ? `${path}${path.includes("?") ? "&" : "?"}sessionID=${encodeURIComponent(sessionID)}` : path
    const response = await request<ConfigProvidersResponse>(config, sessionPath)
    return response.providers.flatMap((provider) => {
      const defaultModel = response.default?.[provider.id]
      return Object.entries(provider.models).flatMap(([modelID, model]) => {
        const base: ModelOption = {
          providerID: provider.id,
          providerName: provider.name || provider.id,
          modelID: model.id || modelID,
          modelName: model.name || model.id || modelID,
          description: model.description,
          status: model.status,
          contextLimit: model.limit?.context,
          outputLimit: model.limit?.output,
          tools: Boolean(model.capabilities?.toolcall || model.capabilities?.tools),
          attachments: Boolean(model.capabilities?.attachment),
          isDefault: defaultModel === modelID
        }
        const variantIDs = Object.keys(model.variants ?? {})
        return [
          base,
          ...variantIDs.map((variant) => ({ ...base, variant, isDefault: false }))
        ]
      })
    })
  },

  createSession(config: ServerConfig, title?: string, model?: ModelSelection, directory?: string) {
    return request<Session>(config, withDirectory("/session", directory), { method: "POST", body: { title, model: toCreateSessionModel(model) } })
  },

  renameSession(config: ServerConfig, id: string, title: string, directory?: string) {
    return request<Session>(config, withDirectory(`/session/${id}`, directory), { method: "PATCH", body: { title } })
  },

  deleteSession(config: ServerConfig, id: string, directory?: string) {
    return request<boolean>(config, withDirectory(`/session/${id}`, directory), { method: "DELETE" })
  },

  loadMessages(config: ServerConfig, sessionID: string, directory?: string, refreshHistory = false) {
    const refresh = refreshHistory ? "&refresh=1" : ""
    return request<MessageEnvelope[]>(config, withDirectory(`/session/${sessionID}/message?limit=100${refresh}`, directory))
  },

  loadLatestMessage(config: ServerConfig, sessionID: string, directory?: string) {
    return request<MessageEnvelope[]>(config, withDirectory(`/session/${sessionID}/message?limit=1`, directory))
  },

  loadTodo(config: ServerConfig, sessionID: string, directory?: string) {
    return request<TodoItem[]>(config, withDirectory(`/session/${sessionID}/todo`, directory))
  },

  loadDiff(config: ServerConfig, sessionID: string, directory?: string) {
    return request<DiffFile[]>(config, withDirectory(`/session/${sessionID}/diff`, directory))
  },

  loadMessageDiff(config: ServerConfig, sessionID: string, messageID: string, directory?: string) {
    return request<DiffFile[]>(config, withDirectory(`/session/${sessionID}/diff?messageID=${encodeURIComponent(messageID)}`, directory))
  },

  loadProjectCurrent(config: ServerConfig, directory?: string) {
    return request<ProjectCurrent>(config, withDirectory("/project/current", directory))
  },

  loadVcs(config: ServerConfig, directory?: string) {
    return request<VcsStatus>(config, withDirectory("/vcs", directory))
  },

  loadFileStatus(config: ServerConfig, directory?: string) {
    return request<FileStatusEntry[] | Record<string, FileStatusEntry>>(config, withDirectory("/file/status", directory))
  },

  listActions(config: ServerConfig, sessionID: string, directory?: string) {
    return request<HarnessAction[]>(config, withDirectory(`/session/${sessionID}/action`, directory))
  },

  invokeAction(config: ServerConfig, sessionID: string, actionID: string, directory?: string) {
    return request<HarnessActionResult>(config, withDirectory(`/session/${sessionID}/action/${encodeURIComponent(actionID)}`, directory), {
      method: "POST",
      body: {},
      readTimeout: 300_000
    })
  },

  sendPrompt(config: ServerConfig, sessionID: string, text: string, directory?: string, model?: ModelSelection, agentID?: string) {
    return request<boolean>(config, withDirectory(`/session/${sessionID}/prompt_async`, directory), {
      method: "POST",
      body: { parts: [{ type: "text", text }], model: toModelBody(model), agent: agentID, variant: model?.variant || undefined }
    })
  },

  sendCommand(config: ServerConfig, sessionID: string, command: string, argumentsText: string, directory?: string, model?: ModelSelection, agentID?: string) {
    return request<MessageEnvelope>(config, withDirectory(`/session/${sessionID}/command`, directory), {
      method: "POST",
      body: { command, arguments: argumentsText, agent: agentID, model: modelWireName(model), variant: model?.variant || undefined },
      readTimeout: 300_000
    })
  },

  revertMessage(config: ServerConfig, sessionID: string, messageID: string, directory?: string) {
    return request<Session>(config, withDirectory(`/session/${sessionID}/revert`, directory), {
      method: "POST",
      body: { messageID }
    })
  },

  unrevertSession(config: ServerConfig, sessionID: string, directory?: string) {
    return request<Session>(config, withDirectory(`/session/${sessionID}/unrevert`, directory), {
      method: "POST",
      body: {}
    })
  },

  abort(config: ServerConfig, sessionID: string, directory?: string) {
    return request<boolean>(config, withDirectory(`/session/${sessionID}/abort`, directory), {
      method: "POST",
      body: {}
    })
  },

  loadQuestions(config: ServerConfig, directory?: string) {
    return request<QuestionRequest[]>(config, withDirectory("/question", directory))
  },

  replyQuestion(config: ServerConfig, requestID: string, answers: string[][], directory?: string) {
    return request<boolean>(config, withDirectory(`/question/${requestID}/reply`, directory), {
      method: "POST",
      body: { answers }
    })
  },

  rejectQuestion(config: ServerConfig, requestID: string, directory?: string) {
    return request<boolean>(config, withDirectory(`/question/${requestID}/reject`, directory), {
      method: "POST",
      body: {}
    })
  },

  loadPermissions(config: ServerConfig, directory?: string) {
    return request<PermissionRequest[]>(config, withDirectory("/permission", directory))
  },

  replyPermission(config: ServerConfig, requestID: string, reply: "once" | "always" | "reject", directory?: string) {
    return request<boolean>(config, withDirectory(`/permission/${requestID}/reply`, directory), {
      method: "POST",
      body: { reply }
    })
  },
}
