import http from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { createRequire } from "node:module"
import { networkInterfaces } from "node:os"
import { allowedOrigin, applyCorsHeaders, writeJSON } from "./http-policy.js"

export const PAIRING_CLAIM_PATH = "/v1/pairing/claim"
export const PAIRING_TTL_MS = 5 * 60 * 1_000
export const PAIRING_TOKEN_MAX_LENGTH = 256
const MAX_PAIRING_BODY_BYTES = 4_096
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|tun|tap|utun)/i
const require = createRequire(import.meta.url)

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

export function createOneTimePairingGrant({
  now = () => Date.now(),
  randomBytesImpl = randomBytes,
  ttlMs = PAIRING_TTL_MS
} = {}) {
  const issuedAt = now()
  return new OneTimePairingGrant({
    token: randomBytesImpl(32).toString("base64url"),
    expiresAt: issuedAt + ttlMs,
    now
  })
}

function pairingAddresses(host, interfaces = networkInterfaces()) {
  const normalized = String(host ?? "").trim()
  if (normalized !== "0.0.0.0" && normalized !== "::") return normalized ? [normalized] : []

  const candidates = []
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) candidates.push({ name, address: address.address })
    }
  }
  const preferred = candidates.filter(({ name }) => !VIRTUAL_INTERFACE.test(name))
  return [...new Set((preferred.length ? preferred : candidates).map(({ address }) => address))]
}

function endpointHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
}

export function pairingURI(endpoint, grant) {
  const params = new URLSearchParams({
    endpoint,
    token: grant.token,
    expires: String(grant.expiresAt)
  })
  return `harnessremote://pair?${params.toString()}`
}

export function machinePairingLinks(config, grant, interfaces = networkInterfaces()) {
  return pairingAddresses(config.host, interfaces).map((host) => {
    const endpoint = `http://${endpointHost(host)}:${config.port}`
    return { endpoint, uri: pairingURI(endpoint, grant) }
  })
}

/**
 * Keep QR rendering outside the pairing authority contract. A source checkout that has not installed
 * the optional presentation dependency still gets the exact same one-time URI as plain text; npx and
 * normal installs render the compact terminal QR because qrcode-terminal is installed by package.json.
 */
export function renderPairingQRCode(uri, { load = () => require("qrcode-terminal") } = {}) {
  try {
    const qrcode = load()
    if (!qrcode || typeof qrcode.generate !== "function") return null
    let output = ""
    qrcode.generate(uri, { small: true }, (rendered) => {
      if (typeof rendered === "string") output = rendered
    })
    return output.trim() ? output : null
  } catch {
    return null
  }
}

/** Startup output keeps long-lived credentials as a manual fallback, while the QR/link itself contains
 * only a high-entropy one-time grant. Render one QR for the preferred LAN endpoint and keep every
 * discovered endpoint as text so multi-interface machines remain recoverable without guessing. */
export function announceMachinePairing(config, grant, {
  write = (text) => process.stdout.write(text),
  interfaces,
  renderQR = renderPairingQRCode
} = {}) {
  const links = machinePairingLinks(config, grant, interfaces)
  if (!links.length) return []
  write("\nPair a phone (one use, valid for 5 minutes):\n")
  const qr = renderQR(links[0].uri)
  if (qr) {
    write(`${qr}\n`)
    write(`Scan the QR above for ${links[0].endpoint}.\n`)
  }
  if (links.length > 1) write("If that network is not reachable from your phone, use another link below.\n")
  write("Pairing links:\n")
  for (const { uri } of links) write(`  ${uri}\n`)
  write("The QR/link contains a one-time token, not the daemon password.\n")
  return links
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
