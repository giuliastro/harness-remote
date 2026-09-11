import http from "node:http"
import { timingSafeEqual } from "node:crypto"
import { allowedOrigin, applyCorsHeaders, writeJSON } from "./http-policy.js"

export const PAIRING_CLAIM_PATH = "/v1/pairing/claim"
export const PAIRING_TOKEN_MAX_LENGTH = 256
const MAX_PAIRING_BODY_BYTES = 4_096

function sameToken(expected, candidate) {
  if (typeof expected !== "string" || typeof candidate !== "string") return false
  const left = Buffer.from(expected, "utf8")
  const right = Buffer.from(candidate, "utf8")
  return left.length === right.length && timingSafeEqual(left, right)
}

async function readPairingBody(request) {
  let body = ""
  for await (const chunk of request) {
    body += chunk
    if (Buffer.byteLength(body, "utf8") > MAX_PAIRING_BODY_BYTES) throw new Error("Pairing request is too large")
  }
  return body ? JSON.parse(body) : {}
}

/**
 * In-memory, process-local claim. A daemon restart invalidates it by design: pairing is a short-lived
 * bootstrap path, never durable authority. Consumption is synchronous so two concurrent valid claims
 * cannot both win after their request bodies have been read.
 */
export class OneTimePairingGrant {
  constructor({ token, expiresAt, now = () => Date.now() }) {
    if (typeof token !== "string" || !token || token.length > PAIRING_TOKEN_MAX_LENGTH) {
      throw new Error("Pairing token is invalid")
    }
    if (!Number.isFinite(expiresAt)) throw new Error("Pairing expiry is invalid")
    this.token = token
    this.expiresAt = Number(expiresAt)
    this.now = now
    this.consumed = false
  }

  consume(candidate) {
    if (this.consumed) return { ok: false, status: 409, error: "This pairing link has already been used." }
    if (this.now() >= this.expiresAt) return { ok: false, status: 410, error: "This pairing link has expired." }
    if (!sameToken(this.token, candidate)) return { ok: false, status: 401, error: "Pairing token is invalid." }
    this.consumed = true
    return { ok: true }
  }
}

/**
 * The pairing claim is the daemon's only unauthenticated bootstrap route. Everything else is passed
 * byte-for-byte to the existing authenticated server stack. The response returns the daemon's
 * existing Basic Auth credentials; it does not create a second authority model.
 */
export function createPairingServer({ innerServer, config, machine, grant, createServer = http.createServer }) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    if (url.pathname !== PAIRING_CLAIM_PATH) {
      innerServer.emit("request", request, response)
      return
    }

    applyCorsHeaders(request, response, config)
    if (request.method === "OPTIONS") {
      response.writeHead(allowedOrigin(request, config) ? 204 : 403)
      response.end()
      return
    }
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST, OPTIONS", "Cache-Control": "no-store" })
      response.end()
      return
    }

    let body
    try {
      body = await readPairingBody(request)
    } catch {
      writeJSON(response, 400, { error: "Pairing request is invalid." })
      return
    }

    const result = grant.consume(body?.token)
    if (!result.ok) {
      writeJSON(response, result.status, { error: result.error })
      return
    }

    writeJSON(response, 200, {
      version: 1,
      machine: { id: machine.id, name: machine.name },
      credentials: { username: config.username ?? "", password: config.password ?? "" }
    })
  })
}
