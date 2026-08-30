import { agentScopedPath, machineBaseUrl, routingHeaders } from "../src/serverConfig.js"
import type { DesktopProfile, DesktopRequest, DesktopRequestResult, DesktopRequestRoute } from "./ipc-contract.js"

export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000
const METHODS = new Set(["GET", "POST", "PATCH", "DELETE"])
const MAX_PATH_LENGTH = 8192
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024
const ROUTE_BACKENDS = new Set<DesktopProfile["backend"]>(["opencode", "omp", "pi", "claude", "codex"])
const MAX_AGENT_ID_LENGTH = 128

function transportError(code: Exclude<DesktopRequestResult, { ok: true }>["error"]["code"], message: string, status?: number): DesktopRequestResult {
  return { ok: false, error: { code, message, status } }
}

function normalizeHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers.entries()].map(([key, value]) => [key.toLowerCase(), value]))
}

function responseDetail(body: string): string | null {
  if (!body) return null
  try {
    const parsed = JSON.parse(body) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const value = parsed as { data?: { message?: unknown }; message?: unknown }
      if (typeof value.data?.message === "string") return value.data.message
      if (typeof value.message === "string") return value.message
    }
  } catch {
    // Plain text server errors remain useful.
  }
  return body
}

async function readBoundedBody(response: Response, onReader?: (reader: ReadableStreamDefaultReader<Uint8Array> | undefined) => void): Promise<string | null> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  onReader?.(reader)
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } finally {
    onReader?.(undefined)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/**
 * What the machine daemon answers itself rather than handing to one agent's bridge: the machine
 * descriptor, the project and task surface behind TaskDesk, and any path the caller already scoped
 * to an agent of its own choosing. Prefixing these with the profile's agent aims them at a bridge
 * where they do not exist, so the profile's scope applies to everything except these.
 */
const MACHINE_SCOPED_PATH = /^\/(?:v1\/machine|global\/machine|v1\/projects|v1\/tasks(?:\/|$)|v1\/agents\/)/

function validPath(path: unknown): path is string {
  return typeof path === "string"
    && path.length <= MAX_PATH_LENGTH
    && path.startsWith("/")
    && !path.startsWith("//")
    && !/[\\\u0000-\u001f\u007f]/.test(path)
}

function routedProfile(profile: DesktopProfile, route: DesktopRequestRoute | undefined): DesktopProfile | null {
  if (!route) return profile
  if (!ROUTE_BACKENDS.has(route.backend)) return null
  if (route.agentId !== undefined) {
    const agentId = typeof route.agentId === "string" ? route.agentId.trim() : ""
    if (!agentId || agentId.length > MAX_AGENT_ID_LENGTH || !/^[A-Za-z0-9._-]+$/.test(agentId)) return null
    return { ...profile, backend: route.backend, agentId }
  }
  return { ...profile, backend: route.backend, agentId: undefined }
}

function targetURL(profile: DesktopProfile, path: string): URL | null {
  if (!validPath(path)) return null
  let approved: URL
  try {
    approved = new URL(machineBaseUrl(profile))
  } catch {
    return null
  }
  let target: URL
  try {
    target = new URL(path, approved.origin)
  } catch {
    return null
  }
  const scopedPath = MACHINE_SCOPED_PATH.test(target.pathname) ? path : agentScopedPath(profile, path)
  try {
    target = new URL(scopedPath, approved.origin)
  } catch {
    return null
  }
  target.hash = ""
  return target.origin === approved.origin ? target : null
}

function timeoutFor(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_MS) return 0
  return Math.max(1, Math.floor(value))
}

export async function executeDesktopRequest(profile: DesktopProfile, request: DesktopRequest): Promise<DesktopRequestResult> {
  if (!request || typeof request !== "object" || !validPath(request.path)) return transportError("invalid-path", "Request path is invalid")
  if (request.method !== undefined && (typeof request.method !== "string" || !METHODS.has(request.method))) {
    return transportError("invalid-payload", "Request method is not allowed")
  }
  if (request.readTimeout !== undefined && timeoutFor(request.readTimeout) === 0) {
    return transportError("invalid-payload", "Request timeout is invalid")
  }
  let serializedBody: string | undefined
  if (request.body !== undefined) {
    try {
      serializedBody = JSON.stringify(request.body)
      if (new TextEncoder().encode(serializedBody).byteLength > MAX_REQUEST_BODY_BYTES) {
        return transportError("invalid-payload", "Request body is too large")
      }
    } catch {
      return transportError("invalid-payload", "Request body must be JSON-serializable")
    }
  }
  const targetProfile = routedProfile(profile, request.route)
  if (!targetProfile) return transportError("invalid-payload", "Request route is invalid")
  const target = targetURL(targetProfile, request.path)
  if (!target) return transportError("invalid-path", "Request target is outside approved profile")

  const timeout = timeoutFor(request.readTimeout)
  const controller = new AbortController()
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
    void activeReader?.cancel().catch(() => undefined)
  }, timeout)
  const headers: Record<string, string> = { Accept: "application/json", ...routingHeaders(targetProfile, { preflight: false }) }
  if (profile.username && profile.password) {
    headers.Authorization = `Basic ${Buffer.from(`${profile.username}:${profile.password}`, "utf8").toString("base64")}`
  }
  if (request.body !== undefined) headers["Content-Type"] = "application/json"

  try {
    const response = await fetch(target, {
      method: request.method ?? "GET",
      headers,
      body: serializedBody,
      redirect: "manual",
      signal: controller.signal
    })
    if (response.status >= 300 && response.status < 400) return transportError("redirect", "Server redirect was rejected", response.status)
    const body = await readBoundedBody(response, (reader) => { activeReader = reader })
    if (timedOut) return transportError("timeout", "Request timed out")
    if (body === null) return transportError("response-too-large", "Server response is too large")
    const headersOut = normalizeHeaders(response.headers)
    if (!response.ok) return transportError("http", responseDetail(body) || `HTTP ${response.status}`, response.status)
    if (response.status === 204) return { ok: true, response: { status: response.status, data: true, headers: headersOut } }
    if (!body) return { ok: true, response: { status: response.status, data: true, headers: headersOut } }
    try {
      return { ok: true, response: { status: response.status, data: JSON.parse(body) as unknown, headers: headersOut } }
    } catch {
      return transportError("http", "Server returned invalid JSON", response.status)
    }
  } catch (error) {
    if (timedOut || (error instanceof DOMException && error.name === "AbortError")) {
      return transportError("timeout", "Request timed out")
    }
    return transportError("connection", `Cannot reach ${profile.host}:${profile.port}.`)
  } finally {
    clearTimeout(timer)
  }
}
