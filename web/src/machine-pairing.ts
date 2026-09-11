import { App } from "@capacitor/app"
import { Capacitor, CapacitorHttp, type PluginListenerHandle } from "@capacitor/core"
import { machineBaseUrl, normalizeServerConfig } from "./serverConfig"
import type { WorkspaceMachine } from "./workspaceMachines"

export type MachinePairingActivation = {
  endpoint: string
  token: string
  expiresAt: number
}

type PairingClaimResponse = {
  version: 1
  machine: { id: string; name: string }
  credentials: { username: string; password: string }
}

const MAX_TOKEN_LENGTH = 256
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/

function cleanText(value: unknown, max = 512): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) return null
  return normalized
}

function normalizedPairingEndpoint(value: string): string | null {
  let endpoint: URL
  try { endpoint = new URL(value) } catch { return null }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") return null
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null
  if (endpoint.pathname !== "/" && endpoint.pathname !== "") return null
  if (!endpoint.hostname || !endpoint.port) return null
  const port = Number(endpoint.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  return `${endpoint.protocol}//${endpoint.hostname}:${port}`
}

/** Accept only the private URI emitted by the HR3 machine daemon startup pairing grant. */
export function parseMachinePairingActivation(url: string, now = Date.now()): MachinePairingActivation | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== "harnessremote:" || parsed.hostname !== "pair") return null

  const endpointRaw = parsed.searchParams.get("endpoint")
  const token = cleanText(parsed.searchParams.get("token"), MAX_TOKEN_LENGTH)
  const expiresAt = Number(parsed.searchParams.get("expires"))
  const endpoint = endpointRaw ? normalizedPairingEndpoint(endpointRaw) : null
  if (!endpoint || !token || !TOKEN_PATTERN.test(token)) return null
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null
  return { endpoint, token, expiresAt }
}

function bodyObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== "string") return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function claimPayload(value: unknown): PairingClaimResponse | null {
  const body = bodyObject(value)
  const machine = bodyObject(body?.machine)
  const credentials = bodyObject(body?.credentials)
  const id = cleanText(machine?.id)
  const name = cleanText(machine?.name)
  const username = typeof credentials?.username === "string" ? credentials.username : null
  const password = typeof credentials?.password === "string" ? credentials.password : null
  if (body?.version !== 1 || !id || !name || username === null || password === null) return null
  return { version: 1, machine: { id, name }, credentials: { username, password } }
}

function errorDetail(value: unknown, fallback: string): string {
  const body = bodyObject(value)
  const detail = cleanText(body?.error, 1_000)
  return detail || fallback
}

function workspaceMachine(endpoint: string, payload: PairingClaimResponse): WorkspaceMachine {
  const url = new URL(endpoint)
  const port = Number(url.port)
  // Preserve explicit https; plain HTTP host spelling matches the existing manual Add Machine flow.
  const host = url.protocol === "https:" ? `https://${url.hostname}` : url.hostname
  const config = normalizeServerConfig({
    backend: "opencode",
    host,
    port,
    username: payload.credentials.username,
    password: payload.credentials.password
  })
  if (!config) throw new Error("The paired machine returned an invalid endpoint.")
  return {
    id: payload.machine.id,
    name: payload.machine.name,
    config: { ...config, backend: "opencode", agentId: undefined }
  }
}

type NativePairingRequest = typeof CapacitorHttp.request

export async function claimMachinePairing(
  activation: MachinePairingActivation,
  options: { nativeRequest?: NativePairingRequest; fetchImpl?: typeof fetch; native?: boolean } = {}
): Promise<WorkspaceMachine> {
  if (Date.now() >= activation.expiresAt) throw new Error("This pairing link has expired.")
  const target = `${activation.endpoint}/v1/pairing/claim`
  const native = options.native ?? Capacitor.isNativePlatform()

  if (native) {
    const request = options.nativeRequest ?? CapacitorHttp.request.bind(CapacitorHttp)
    let response
    try {
      response = await request({
        url: target,
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        data: { token: activation.token },
        connectTimeout: 10_000,
        readTimeout: 10_000
      })
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Could not reach the machine pairing endpoint.")
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(errorDetail(response.data, `Pairing failed with HTTP ${response.status}.`))
    }
    const payload = claimPayload(response.data)
    if (!payload) throw new Error("The machine returned an invalid pairing response.")
    return workspaceMachine(activation.endpoint, payload)
  }

  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(target, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ token: activation.token })
    })
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Could not reach the machine pairing endpoint.")
  }
  let body: unknown = null
  try { body = await response.json() } catch { /* handled below */ }
  if (!response.ok) throw new Error(errorDetail(body, `Pairing failed with HTTP ${response.status}.`))
  const payload = claimPayload(body)
  if (!payload) throw new Error("The machine returned an invalid pairing response.")
  return workspaceMachine(activation.endpoint, payload)
}

function endpointIdentity(machine: WorkspaceMachine): string {
  return machineBaseUrl(machine.config).toLowerCase()
}

/** Pairing may be repeated after the old grant expires. Re-pairing the same physical machine or
 * endpoint updates credentials in place instead of duplicating the machine and breaking local keys. */
export function upsertPairedMachine(machines: WorkspaceMachine[], paired: WorkspaceMachine): WorkspaceMachine[] {
  const endpoint = endpointIdentity(paired)
  const index = machines.findIndex((machine) => machine.id === paired.id || endpointIdentity(machine) === endpoint)
  if (index < 0) return [...machines, paired]
  const current = machines[index]
  const next = [...machines]
  next[index] = { ...paired, id: current.id }
  return next
}

/** Capacitor receives both warm appUrlOpen activations and cold launch URLs. */
export function subscribeAndroidMachinePairing(
  onActivation: (activation: MachinePairingActivation) => void
): () => void {
  if (Capacitor.getPlatform() !== "android") return () => undefined
  let closed = false
  let handle: PluginListenerHandle | undefined
  const seen = new Set<string>()
  const emit = (url: string | undefined) => {
    if (closed || !url || seen.has(url)) return
    const activation = parseMachinePairingActivation(url)
    if (!activation) return
    seen.add(url)
    onActivation(activation)
  }

  void App.addListener("appUrlOpen", ({ url }) => emit(url)).then((created) => {
    if (closed) void created.remove()
    else handle = created
  })
  void App.getLaunchUrl().then((launch) => emit(launch?.url)).catch(() => undefined)

  return () => {
    if (closed) return
    closed = true
    if (handle) void handle.remove()
  }
}
