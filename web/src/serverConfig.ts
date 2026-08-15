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

/**
 * A host typed one character at a time passes through states such as `http:` and
 * `http://` that produce an unparseable base URL. Callers must check this before
 * building any URL, because a throw on the render path blanks the whole app and a
 * persisted invalid host reproduces that crash on every launch.
 */

export function isValidServerConfig(config: ServerConfig): boolean {
  if (!config.host.trim() || !Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) return false
  try {
    const url = new URL(baseUrl(config))
    return Boolean(url.hostname)
  } catch {
    return false
  }
}
