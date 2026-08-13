import type { ServerConfig } from "./types.js"

/**
 * Kept free of Capacitor imports so it can be unit tested directly: the rules here
 * decide whether the app is allowed to build a URL at all.
 */
export function baseUrl(config: ServerConfig): string {
  const host = config.host.trim()
  const schemeMatch = host.match(/^(https?):\/\//)
  const scheme = schemeMatch ? schemeMatch[1] : "http"
  const cleanHost = schemeMatch ? host.slice(schemeMatch[0].length) : host
  return `${scheme}://${cleanHost}:${config.port}`
}

/** Legacy server profiles have no agent id, so their wire paths remain byte-for-byte unchanged. */
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

export function isValidServerConfig(config: ServerConfig): boolean {
  if (!config.host.trim() || !Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) return false
  try {
    const url = new URL(baseUrl(config))
    return Boolean(url.hostname)
  } catch {
    return false
  }
}
