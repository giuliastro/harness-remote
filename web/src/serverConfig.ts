import type { ServerConfig } from "./types.js"

/**
 * Kept free of Capacitor imports so it can be unit tested directly: the rules here
 * decide whether the app is allowed to build a URL at all.
 */
export function normalizeServerHost(host: string): string | null {
  const value = host.trim()
  if (!value) return null

  const explicitScheme = /^(https?):\/\//i.test(value)
  // Reject half-typed or unsupported schemes before URL treats e.g. "http:" as a hostname.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !explicitScheme) return null
  let url: URL
  try {
    url = new URL(explicitScheme ? value : `http://${value}`)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  if (!url.hostname || url.username || url.password || url.port || url.search || url.hash) return null
  if (url.pathname !== "/" && url.pathname !== "") return null

  const hostname = url.hostname.toLowerCase()
  return explicitScheme ? `${url.protocol}//${hostname}` : hostname
}

/**
 * Canonicalize the machine endpoint once. Browser, Android and Electron must all resolve the same
 * stored machine even when a user typed LOCALHOST, a trailing slash, or invisible credential
 * whitespace. agentId is routing state, not part of the authorized network endpoint.
 */
export function normalizeServerConfig(config: ServerConfig): ServerConfig | null {
  const host = normalizeServerHost(config.host)
  if (!host || !Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) return null
  const agentId = config.agentId?.trim() || undefined
  return {
    ...config,
    host,
    username: config.username.trim(),
    password: config.password.trim(),
    agentId
  }
}

export function machineBaseUrl(config: ServerConfig): string {
  const host = normalizeServerHost(config.host) ?? config.host.trim()
  const schemeMatch = host.match(/^(https?):\/\//i)
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : "http"
  const cleanHost = schemeMatch ? host.slice(schemeMatch[0].length) : host
  return `${scheme}://${cleanHost}:${config.port}`
}

/**
 * A daemon-backed profile points at one agent below the machine address. Legacy profiles have no
 * agent id, so their base URL remains byte-for-byte identical to previous releases.
 */
export function baseUrl(config: ServerConfig): string {
  const machine = machineBaseUrl(config)
  const agentID = config.agentId?.trim()
  return agentID ? `${machine}/v1/agents/${encodeURIComponent(agentID)}` : machine
}

/**
 * The daemon corrects a stale or wrongly-scoped agent id from this header, so it is what keeps a
 * profile pointed at the harness the user chose even when the path scope cannot be trusted. It lives
 * here rather than beside either transport because the browser and the desktop app have separate
 * request paths, and a header only one of them sent is how the desktop app came to route every
 * server to the daemon's primary agent.
 *
 * A direct OpenCode server does not know the header and may reject it during CORS preflight, so a
 * profile with no agent id — which is what a pre-daemon OpenCode connection looks like — sends none
 * from the browser. Nothing preflights a request made from the desktop app's main process or from a
 * native HTTP client, and a server that does not know the header simply ignores it, so those pass
 * `preflight: false` and keep the hint that tells a daemon which harness was asked for.
 */
export function routingHeaders(
  config: Pick<ServerConfig, "backend" | "agentId">,
  { preflight = true }: { preflight?: boolean } = {}
): Record<string, string> {
  if (preflight && config.backend === "opencode" && !config.agentId?.trim()) return {}
  return { "X-Harness-Backend": config.backend }
}

/** Useful when a caller already has a path and does not build through baseUrl. */
export function agentScopedPath(config: ServerConfig, path: string): string {
  const agentID = config.agentId?.trim()
  if (!agentID) return path
  const normalized = path.startsWith("/") ? path : `/${path}`
  return `/v1/agents/${encodeURIComponent(agentID)}${normalized}`
}

/**
 * Credentials are typed on a phone keyboard into fields that show nothing back — the password one
 * is masked, and a trailing space accepted from a suggestion is invisible in both. The stored
 * config keeps whatever was typed; trimming here, at the single point the bytes are built, means a
 * stray space cannot silently produce a 401 that reads as a wrong password.
 */
function credentials(config: ServerConfig): { username: string; password: string } {
  return { username: config.username.trim(), password: config.password.trim() }
}

export function hasCredentials(config: ServerConfig): boolean {
  const { username, password } = credentials(config)
  return Boolean(username) && Boolean(password)
}

/**
 * `btoa` encodes Latin-1, so `à` in a password became one byte where every other client sends the
 * two UTF-8 bytes the server decodes, and anything above U+00FF threw outright. Encode the pair as
 * UTF-8 first, then base64 those bytes.
 */
export function authHeader(config: ServerConfig): string {
  const { username, password } = credentials(config)
  const utf8 = new TextEncoder().encode(`${username}:${password}`)
  let binary = ""
  for (const byte of utf8) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

/**
 * A host typed one character at a time passes through states such as `http:` and `http://` that
 * produce an unparseable base URL. Callers must check this before building any URL, because a throw
 * on the render path blanks the whole app and a persisted invalid host reproduces that crash on
 * every launch.
 */
export function isValidServerConfig(config: ServerConfig): boolean {
  return normalizeServerConfig(config) !== null
}
