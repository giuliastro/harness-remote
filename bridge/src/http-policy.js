import { timingSafeEqual } from "node:crypto"

/** Returns the request origin when it is explicitly allowed by --cors. */
export function allowedOrigin(request, config) {
  const origin = request.headers.origin
  if (!origin || !config.corsOrigins?.length) return undefined
  return config.corsOrigins.includes(origin) ? origin : undefined
}

/**
 * Credentialed CORS forbids a wildcard origin, so each allowed origin is echoed
 * back individually and responses are marked as origin-dependent for caches.
 */
export function applyCorsHeaders(request, response, config) {
  if (!config.corsOrigins?.length) return
  response.setHeader("Vary", "Origin")
  const origin = allowedOrigin(request, config)
  if (!origin) return
  response.setHeader("Access-Control-Allow-Origin", origin)
  response.setHeader("Access-Control-Allow-Credentials", "true")
  response.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-harness-backend")
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
  // Chromium's Private Network Access preflight is sent when this public PWA
  // connects to a local daemon/bridge (for example github.io -> localhost).
  if (request.headers["access-control-request-private-network"] === "true") {
    response.setHeader("Access-Control-Allow-Private-Network", "true")
  }
}

export function matchesCredentials(request, config) {
  if (!config.username) return true
  const header = request.headers.authorization
  if (!header?.startsWith("Basic ")) return false
  const expected = Buffer.from(`${config.username}:${config.password}`)
  const received = Buffer.from(header.slice("Basic ".length), "base64")
  return received.length === expected.length && timingSafeEqual(received, expected)
}

export function authenticateDaemonRequest(request, response, config) {
  applyCorsHeaders(request, response, config)
  if (request.method === "OPTIONS") {
    response.writeHead(allowedOrigin(request, config) ? 204 : 403)
    response.end()
    return false
  }
  if (!matchesCredentials(request, config)) {
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Harness Remote Daemon"' })
    response.end()
    return false
  }
  return true
}

export function writeJSON(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
  response.end(JSON.stringify(body))
}
