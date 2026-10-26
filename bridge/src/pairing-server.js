import http from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { createRequire } from "node:module"
import { networkInterfaces } from "node:os"
import { allowedOrigin, applyCorsHeaders, matchesCredentials, guardRequestHandler, writeJSON } from "./http-policy.js"

export const PAIRING_CLAIM_PATH = "/v1/pairing/claim"
export const PAIRING_GRANT_PATH = "/v1/pairing/grant"
export const PAIRING_TTL_MS = 5 * 60 * 1_000
export const PAIRING_TOKEN_MAX_LENGTH = 256
const MAX_PAIRING_BODY_BYTES = 4_096
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|tun|tap|utun)/i
// A Node listener on "localhost" also only accepts loopback traffic, and the whole 127/8 block is
// loopback by definition. Anything not matched here binds somewhere a phone on the network can
// actually reach (a specific interface address or a wildcard).
const LOOPBACK_HOST = /^(localhost|::1|\[::1\]|127(?:\.\d{1,3}){3})$/i
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

/**
 * The daemon's live pairing authority: at most one outstanding grant at a time.
 *
 * "Regenerate" is this replace operation, and the replacement must be immediate. Keeping the old
 * grant alongside a new one would leave a QR that the user has already replaced claimable, which is
 * exactly the window this class exists to close. Everything stays in memory: a daemon restart still
 * invalidates every grant by design, and this class never adds durable authority.
 */
export class MachinePairingGrants {
  constructor({ now = () => Date.now(), randomBytesImpl = randomBytes, ttlMs = PAIRING_TTL_MS, grant } = {}) {
    this.now = now
    this.randomBytesImpl = randomBytesImpl
    this.ttlMs = ttlMs
    this.current = grant ?? this.issue()
  }

  issue() {
    this.current = createOneTimePairingGrant({
      now: this.now,
      randomBytesImpl: this.randomBytesImpl,
      ttlMs: this.ttlMs
    })
    return this.current
  }

  status() {
    const grant = this.current
    return {
      claimed: grant.consumed,
      expired: !grant.consumed && this.now() >= grant.expiresAt,
      expiresAt: grant.expiresAt
    }
  }

  consume(token) {
    return this.current.consume(token)
  }
}

/** True when the daemon bound itself somewhere only this machine can reach. A phone can never open
 *  the endpoint of such a grant, so the client is told instead of being handed a dead QR. */
export function pairingBoundToLoopback(host) {
  return LOOPBACK_HOST.test(String(host ?? "").trim())
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
 * the optional presentation dependency still gets the exact same one-time URI internally; npx and
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

/** True only when the optional QR dependency cannot be resolved, not when rendering itself failed. */
export function pairingQRRendererMissing({ resolve = () => require.resolve("qrcode-terminal") } = {}) {
  try {
    resolve()
    return false
  } catch (error) {
    return error?.code === "MODULE_NOT_FOUND"
  }
}

/**
 * The one-time URI and endpoint are implementation details of phone pairing, not useful terminal UI.
 * Show one QR for the preferred reachable endpoint and keep normal machine setup as the fallback.
 * Never dump raw deep links, tokens, alternate interface URLs, or HTTP endpoints below the QR.
 */
export function announceMachinePairing(config, grant, {
  write = (text) => process.stdout.write(text),
  interfaces,
  renderQR = renderPairingQRCode,
  rendererMissing = pairingQRRendererMissing
} = {}) {
  // A QR is only useful if a phone can open its endpoint. These two cases are certain from here, so
  // say so instead of printing a code that can never work.
  if (pairingBoundToLoopback(config.host)) {
    write(`\nPhone pairing unavailable: Harness Remote only accepts connections from this computer (--host ${config.host}).\nRestart without --host to pair a phone.\n`)
    return []
  }
  const links = machinePairingLinks(config, grant, interfaces)
  if (!links.length) {
    write("\nPhone pairing unavailable: this computer has no network address a phone can reach.\nConnect it to the same Wi-Fi or LAN as the phone, then restart.\n")
    return []
  }

  const qr = renderQR(links[0].uri)
  write("\nPhone pairing (optional, valid for 5 minutes)\n")
  if (qr) {
    write(`${qr}\n`)
    write("Scan this QR in Harness Remote to add the machine automatically.\n")
  } else {
    // `npx harness-remote` inside a source checkout runs that checkout, which has no node_modules
    // until someone installs them. Name the cause instead of leaving pairing looking broken.
    if (rendererMissing()) {
      write("QR renderer not installed (qrcode-terminal). In a source checkout run `npm install` in the repository root, or run `npx harness-remote@latest` from another directory.\n")
    }
    write("QR unavailable. Use Machines → Add machine with this machine's address and credentials.\n")
  }
  return links
}

/**
 * What the granting client needs to render a QR, a countdown and an address picker: the one-time
 * URIs and the truth about whether any of them can be reached from another device. A loopback-only
 * daemon reports no links and says why, so the dialog explains the bind instead of showing a QR
 * that cannot work. This never exposes Basic Auth credentials - those still only leave the machine
 * through the claim response.
 */
export function machinePairingGrantResponse(config, grant, interfaces) {
  const loopbackOnly = pairingBoundToLoopback(config.host)
  return {
    version: 1,
    expiresAt: grant.expiresAt,
    loopbackOnly,
    links: loopbackOnly ? [] : machinePairingLinks(config, grant, interfaces)
  }
}

/**
 * The pairing claim is the daemon's only unauthenticated bootstrap route. /v1/pairing/grant is its
 * authenticated counterpart: only a client that already holds this machine's credentials can
 * request or inspect a grant, so it adds no new authority - it only makes the existing one-time
 * bootstrap path issuable on demand instead of once per daemon process. Everything else is passed
 * byte-for-byte to the existing server stack.
 */
function remoteHost(request) {
  const address = String(request.socket?.remoteAddress ?? "")
  return address.startsWith("::ffff:") ? address.slice(7) : address
}

/**
 * Only a phone can prove it reaches this machine: local connections never cross the firewall or the
 * Wi-Fi, so nothing here can test that path. Report the outcome the phone produced instead - a
 * successful claim, or a startup QR that expired without one.
 */
export function watchStartupPairing(grants, grant, links, {
  write = (text) => process.stdout.write(text),
  platform = process.platform,
  setTimer = setTimeout,
  now = () => Date.now()
} = {}) {
  if (!links.length) return null
  const timer = setTimer(() => {
    if (grants.current !== grant || grant.consumed) return
    const lines = [
      "",
      "No phone connected, and the pairing QR has expired.",
      `If you scanned it, the phone could not reach ${links[0].endpoint}: check that it is on the same Wi-Fi (not mobile data or a VPN) and that the firewall allows incoming connections.`
    ]
    if (platform === "win32") lines.push("On Windows, restart with --allow-firewall to allow them.")
    lines.push("Restart Harness Remote for a new QR.")
    write(`${lines.join("\n")}\n`)
  }, Math.max(0, grant.expiresAt - now()))
  timer?.unref?.()
  return timer
}

export function createPairingServer({ innerServer, config, machine, grants, interfaces, createServer = http.createServer, onClaim = () => {} }) {
  return createServer(guardRequestHandler(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    if (url.pathname === PAIRING_GRANT_PATH) {
      handlePairingGrant({ request, response, config, grants, interfaces })
      return
    }
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

    const result = grants.consume(body?.token)
    if (!result.ok) {
      writeJSON(response, result.status, { error: result.error })
      return
    }

    writeJSON(response, 200, {
      version: 1,
      machine: { id: machine.id, name: machine.name },
      credentials: { username: config.username ?? "", password: config.password ?? "" }
    })
    onClaim({ remoteAddress: remoteHost(request) })
  }))
}

function handlePairingGrant({ request, response, config, grants, interfaces }) {
  applyCorsHeaders(request, response, config)
  if (request.method === "OPTIONS") {
    response.writeHead(allowedOrigin(request, config) ? 204 : 403)
    response.end()
    return
  }
  if (!matchesCredentials(request, config)) {
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Harness Remote Daemon"' })
    response.end()
    return
  }
  if (request.method === "POST") {
    // A fresh grant replaces any outstanding one. The returned links are the only place a new URI
    // is disclosed, and the previous URI stops working immediately.
    writeJSON(response, 200, machinePairingGrantResponse(config, grants.issue(), interfaces))
    return
  }
  if (request.method === "GET") {
    writeJSON(response, 200, { version: 1, ...grants.status() })
    return
  }
  response.writeHead(405, { Allow: "GET, POST, OPTIONS", "Cache-Control": "no-store" })
  response.end()
}
