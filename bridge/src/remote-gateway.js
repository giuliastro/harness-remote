import http from "node:http"
import https from "node:https"
import { REMOTE_AUTH_HEADERS } from "./remote-request-auth.js"

const MAX_BODY_BYTES = 24 * 1024 * 1024
const MAX_ACTIVE_READS = 24
const MAX_ACTIVE_MUTATIONS = 8
const MAX_ACTIVE_STREAMS = 24
const MAX_BAD_REQUESTS = 10
const FAILURE_WINDOW_MS = 5 * 60_000
const FORWARD_HEADERS = ["accept", "content-type", "x-harness-backend", "last-event-id", "if-none-match"]
export const REMOTE_PAIR_PATH = "/v1/remote/pair"
export const REMOTE_ADDRESSES_PATH = "/v1/remote/addresses"

function validatedAddressCandidates(values) {
  if (!Array.isArray(values)) return []
  const candidates = new Set()
  for (const value of values.slice(0, 32)) {
    if (typeof value !== "string" || value.length > 512) continue
    try {
      const url = new URL(value)
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" ||
          url.search || url.hash || url.hostname !== "127.0.0.1" || !url.port) continue
      candidates.add(`https://127.0.0.1:${url.port}`)
    } catch { /* Ignore malformed candidates. */ }
  }
  return [...candidates]
}

function clientAddress(request) {
  return String(request.socket.remoteAddress ?? "unknown").slice(0, 128)
}

function writeError(response, status, error) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  response.end(JSON.stringify({ error }))
}

async function readBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > maxBytes) throw new Error("body_too_large")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, length)
}

/** A separate HTTPS ingress. It never forwards an unverified request to the LAN HTTP daemon. */
export function createRemoteGatewayServer({
  tls,
  authenticator,
  upstreamPort,
  username,
  password,
  pairing,
  addressCandidates = [],
  now = () => Date.now(),
  createServer = https.createServer,
  requestUpstream = http.request
}) {
  if (!tls?.key || !tls?.cert || !authenticator || !Number.isInteger(upstreamPort)
    || upstreamPort < 1 || upstreamPort > 65535) throw new Error("Incomplete remote gateway configuration")
  if (pairing && (!pairing.grants?.consume || !pairing.registry?.pair || typeof pairing.machineID !== "string")) {
    throw new Error("Incomplete remote pairing configuration")
  }
  const failures = new Map()
  let activeReads = 0
  let activeMutations = 0
  let activeStreams = 0
  const server = createServer({ key: tls.key, cert: tls.cert, minVersion: "TLSv1.3" }, async (request, response) => {
    // SSE connections stay open for the lifetime of a machine subscription. Keep a
    // separate bounded pool so they cannot consume the slots needed for commands.
    const isStream = request.method === "GET" && typeof request.headers.accept === "string" &&
      /(?:^|,)\s*text\/event-stream(?:\s*;[^,]*)?(?:,|$)/i.test(request.headers.accept)
    const isRead = request.method === "GET" || request.method === "HEAD"
    if ((isStream && activeStreams >= MAX_ACTIVE_STREAMS) ||
      (!isStream && isRead && activeReads >= MAX_ACTIVE_READS) ||
      (!isStream && !isRead && activeMutations >= MAX_ACTIVE_MUTATIONS)) {
      writeError(response, 503, "Remote gateway is busy")
      return
    }
    if (isStream) activeStreams += 1
    else if (isRead) activeReads += 1
    else activeMutations += 1
    response.once("close", () => {
      if (isStream) activeStreams -= 1
      else if (isRead) activeReads -= 1
      else activeMutations -= 1
    })
    const address = clientAddress(request)
    const current = now()
    for (const [peer, entry] of failures) {
      if (current - entry.startedAt >= FAILURE_WINDOW_MS) failures.delete(peer)
    }
    const failure = failures.get(address)
    if (failure && current - failure.startedAt < FAILURE_WINDOW_MS && failure.count >= MAX_BAD_REQUESTS) {
      writeError(response, 429, "Too many failed remote requests")
      return
    }
    if (failures.size > 1024) {
      // Memory remains bounded under hostile source-address churn. Fail closed for unknown peers.
      writeError(response, 503, "Remote gateway is busy")
      return
    }

    let body
    try {
      body = await readBody(request, isRead ? 0 : MAX_BODY_BYTES)
    } catch {
      writeError(response, 413, "Remote request is too large")
      return
    }
    if (request.url === REMOTE_PAIR_PATH && pairing) {
      if (request.method !== "POST" || body.length > 4096 || request.headers["content-type"] !== "application/json") {
        writeError(response, 400, "Invalid pairing request")
        return
      }
      let fields
      try { fields = JSON.parse(body.toString("utf8")) } catch { /* rejected below */ }
      if (!fields || typeof fields.token !== "string" || typeof fields.publicKey !== "string"
        || typeof fields.name !== "string") {
        writeError(response, 400, "Invalid pairing request")
        return
      }
      const claim = pairing.grants.consume(fields.token)
      if (!claim.ok) {
        const previous = failures.get(address)
        failures.set(address, previous && current - previous.startedAt < FAILURE_WINDOW_MS
          ? { startedAt: previous.startedAt, count: previous.count + 1 }
          : { startedAt: current, count: 1 })
        writeError(response, claim.status, "Pairing grant rejected")
        return
      }
      try {
        const deviceID = await pairing.registry.pair({ publicKey: fields.publicKey, name: fields.name })
        failures.delete(address)
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
        response.end(JSON.stringify({ version: 1, machineID: pairing.machineID, deviceID }))
      } catch {
        writeError(response, 400, "Invalid device key or name")
      }
      return
    }
    const auth = authenticator.authenticate({ headers: request.headers, method: request.method, target: request.url, body })
    if (!auth) {
      const previous = failures.get(address)
      failures.set(address, previous && current - previous.startedAt < FAILURE_WINDOW_MS
        ? { startedAt: previous.startedAt, count: previous.count + 1 }
        : { startedAt: current, count: 1 })
      writeError(response, 401, "Remote request was not authenticated")
      return
    }
    failures.delete(address)
    // Legacy pairing grants can mint reusable Basic credentials. They must never
    // be reachable through the device-key ingress, even by a paired device.
    const normalizedPath = new URL(request.url, "http://localhost").pathname
    if (normalizedPath === "/v1/pairing/grant" || normalizedPath === "/v1/pairing/claim") {
      writeError(response, 403, "Legacy pairing is unavailable remotely")
      return
    }
    if (request.url === REMOTE_ADDRESSES_PATH) {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET", "cache-control": "no-store" })
        response.end()
        return
      }
      const current = now()
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
      response.end(JSON.stringify({ addresses: validatedAddressCandidates(addressCandidates), generatedAt: current }))
      return
    }
    // A device may revoke its own key. Let the already authenticated DELETE receive
    // its confirmation; every subsequent request still fails authentication.
    const selfRevocation = request.method === "DELETE" &&
      request.url === `/v1/remote/devices/${auth.deviceID}`

    const headers = { host: `127.0.0.1:${upstreamPort}`, "content-length": String(body.length) }
    if (username) headers.authorization = `Basic ${Buffer.from(`${username}:${password ?? ""}`).toString("base64")}`
    for (const name of FORWARD_HEADERS) {
      const value = request.headers[name]
      if (typeof value === "string" && value.length < 8192) headers[name] = value
    }
    for (const name of Object.values(REMOTE_AUTH_HEADERS)) delete headers[name]

    let upstream
    try {
      upstream = requestUpstream({ hostname: "127.0.0.1", port: upstreamPort, path: request.url,
        method: request.method, headers, agent: false }, (incoming) => {
      const confirmingSelfRevocation = selfRevocation && incoming.statusCode === 200
      if (!authenticator.active(auth.deviceID) && !confirmingSelfRevocation) {
        incoming.destroy()
        writeError(response, 401, "Device revoked")
        return
      }
      const responseHeaders = {}
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization", "set-cookie", "www-authenticate"].includes(name)) continue
        responseHeaders[name] = value
      }
      response.writeHead(incoming.statusCode ?? 502, responseHeaders)
      const revocationCheck = setInterval(() => {
        if (!authenticator.active(auth.deviceID) && !confirmingSelfRevocation) {
          incoming.destroy()
          response.destroy()
        }
      }, 1_000)
      revocationCheck.unref?.()
      incoming.on("data", (chunk) => {
        if (!authenticator.active(auth.deviceID) && !confirmingSelfRevocation) {
          incoming.destroy()
          response.destroy()
          return
        }
        if (!response.write(chunk)) incoming.pause()
      })
      response.on("drain", () => incoming.resume())
      incoming.on("end", () => response.end())
      incoming.on("error", () => response.destroy())
      incoming.on("close", () => clearInterval(revocationCheck))
      })
    } catch {
      writeError(response, 400, "Invalid remote request")
      return
    }
    upstream.setTimeout(30_000, () => upstream.destroy(new Error("upstream_timeout")))
    upstream.on("error", () => {
      if (!response.headersSent) writeError(response, 502, "Local gateway unavailable")
      else response.destroy()
    })
    response.on("close", () => upstream.destroy())
    upstream.end(body)
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.maxHeadersCount = 64
  server.maxConnections = 80
  return server
}
