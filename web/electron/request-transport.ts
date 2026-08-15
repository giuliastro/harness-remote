import { baseUrl } from "../src/serverConfig.js"
import type { DesktopProfile, DesktopRequest, DesktopRequestResult } from "./ipc-contract.js"

export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000
const METHODS = new Set(["GET", "POST", "PATCH", "DELETE"])
const MAX_PATH_LENGTH = 8192
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024

function transportError(code: Exclude<DesktopRequestResult, { ok: true }>['error']['code'], message: string): DesktopRequestResult {
  return { ok: false, error: { code, message } }
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

function validPath(path: unknown): path is string {
  return typeof path === "string"
    && path.length <= MAX_PATH_LENGTH
    && path.startsWith("/")
    && !path.startsWith("//")
    && !/[\\\u0000-\u001f\u007f]/.test(path)
}

function targetURL(profile: DesktopProfile, path: string): URL | null {
  if (!validPath(path)) return null
  let target: URL
  let approved: URL
  try {
    target = new URL(path, baseUrl(profile))
    approved = new URL(baseUrl(profile))
  } catch {
    return null
  }
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
  const target = targetURL(profile, request.path)
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
  const headers: Record<string, string> = { Accept: "application/json" }
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
    if (response.status >= 300 && response.status < 400) return transportError("redirect", "Server redirect was rejected")
    const body = await readBoundedBody(response, (reader) => { activeReader = reader })
    if (timedOut) return transportError("timeout", "Request timed out")
    if (body === null) return transportError("response-too-large", "Server response is too large")
    const headersOut = normalizeHeaders(response.headers)
    if (!response.ok) return transportError("http", responseDetail(body) || `HTTP ${response.status}`)
    if (response.status === 204) return { ok: true, response: { status: response.status, data: true, headers: headersOut } }
    if (!body) return { ok: true, response: { status: response.status, data: true, headers: headersOut } }
    try {
      return { ok: true, response: { status: response.status, data: JSON.parse(body) as unknown, headers: headersOut } }
    } catch {
      return transportError("http", "Server returned invalid JSON")
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
