#!/usr/bin/env node
// Deterministic machine for the UI-fixes manual test. It is intentionally tiny: one fast ACP
// harness with real rename/delete routes, and two deliberately slow harnesses so the per-harness
// loading notice stays on screen long enough to inspect on desktop and phone.
import http from "node:http"

const port = Number(process.env.UI_TEST_PORT)
const username = process.env.UI_TEST_USERNAME || "uitest"
const password = process.env.UI_TEST_PASSWORD || "uitest-local"
const root = process.env.UI_TEST_ROOT
const machineName = process.env.UI_TEST_MACHINE_NAME || "UI Test"
const machineID = process.env.UI_TEST_MACHINE_ID || "machine-ui-test"

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("UI_TEST_PORT is required")
if (!root) throw new Error("UI_TEST_ROOT is required")

const now = Date.now()
let sessions = [
  ["ui-1", "Riga sessione: cestino e rename", 7],
  ["ui-2", "Ricerca mobile: filtri sopra i risultati", 6],
  ["ui-3", "Avviso harness in caricamento", 5],
  ["ui-4", "Impostazioni connessione in background", 4],
  ["ui-5", "Sessione alpha", 3],
  ["ui-6", "Sessione beta", 2]
].map(([id, title, age]) => ({
  id,
  title,
  directory: root,
  time: { created: now - age * 60_000, updated: now - age * 60_000 },
  status: { type: "idle" }
}))

const agent = (id, label, backend = id) => ({
  id,
  label,
  backend,
  transport: "acp",
  managed: true,
  state: "available",
  capabilities: {
    sessions: true,
    prompt: true,
    abort: true,
    streaming: true,
    models: true,
    commands: true,
    sessionRename: true,
    sessionDelete: true
  }
})

const agents = [
  agent("claude", "Claude Code")
]

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Harness-Backend",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Max-Age": "600"
}

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json", ...CORS })
  response.end(JSON.stringify(value))
}

function authorized(request) {
  const header = request.headers.authorization || ""
  return header === `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function body(request) {
  return new Promise((resolve) => {
    let raw = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => { raw += chunk })
    request.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
    })
  })
}

function sse(response) {
  response.writeHead(200, { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
  response.write(": connected\n\n")
  const timer = setInterval(() => { if (!response.writableEnded) response.write(": keepalive\n\n") }, 15_000)
  timer.unref?.()
  response.on("close", () => clearInterval(timer))
}

const slowResponses = new Set()
const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") { response.writeHead(204, CORS); response.end(); return }
  if (!authorized(request)) {
    response.writeHead(401, { ...CORS, "WWW-Authenticate": 'Basic realm="Harness Remote UI Test"' })
    response.end("Unauthorized")
    return
  }

  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`)
  const path = url.pathname

  if (request.method === "GET" && path === "/v1/machine") {
    json(response, 200, { machine: { id: machineID, name: machineName, createdAt: new Date(now).toISOString() }, agents })
    return
  }
  if (request.method === "GET" && path === "/v1/projects") {
    json(response, 200, { projects: [{ id: "ui-test-project", name: "UI Test Project", path: root }] })
    return
  }
  if (request.method === "GET" && (path === "/global/event" || /^\/v1\/agents\/[^/]+\/global\/event$/.test(path))) {
    sse(response)
    return
  }

  const list = /^\/v1\/agents\/([^/]+)\/experimental\/session$/.exec(path)
  if (request.method === "GET" && list) {
    if (list[1] !== "claude") {
      // Keep the first read open past the client's discovery budget. The UI must show the harness
      // as still loading and then as retrying without hiding the fast harness's Sessions.
      const timer = setTimeout(() => {
        slowResponses.delete(timer)
        if (!response.writableEnded) json(response, 200, [])
      }, 30_000)
      timer.unref?.()
      slowResponses.add(timer)
      response.on("close", () => { clearTimeout(timer); slowResponses.delete(timer) })
      return
    }
    json(response, 200, sessions)
    return
  }

  const status = /^\/v1\/agents\/([^/]+)\/session\/status$/.exec(path)
  if (request.method === "GET" && status) {
    json(response, 200, Object.fromEntries(sessions.map((session) => [session.id, session.status])))
    return
  }

  const one = /^\/v1\/agents\/([^/]+)\/session\/([^/]+)$/.exec(path)
  if (one) {
    const [, agentID, sessionID] = one
    const session = sessions.find((candidate) => candidate.id === sessionID)
    if (!session) { json(response, 404, { error: "Session not found" }); return }
    if (request.method === "GET") { json(response, 200, session); return }
    if (request.method === "PATCH") {
      const payload = await body(request)
      if (typeof payload.title === "string" && payload.title.trim()) session.title = payload.title.trim()
      json(response, 200, session)
      return
    }
    if (request.method === "DELETE") {
      sessions = sessions.filter((candidate) => candidate.id !== sessionID)
      json(response, 200, true)
      return
    }
    json(response, 405, { error: "Method not allowed" })
    return
  }

  const messages = /^\/v1\/agents\/([^/]+)\/session\/([^/]+)\/message$/.exec(path)
  if (request.method === "GET" && messages) { json(response, 200, []); return }
  if (request.method === "GET" && /\/session\/[^/]+\/(question|permission|command)$/.test(path)) { json(response, 200, []); return }
  if (request.method === "GET" && /\/config\/providers$/.test(path)) {
    json(response, 200, { providers: [], default: {} })
    return
  }

  json(response, 404, { error: `No UI-test route for ${request.method} ${path}` })
})

server.listen(port, "0.0.0.0", () => {
  console.log(`UI test daemon ready at http://0.0.0.0:${port}`)
  console.log(`  Machine: ${machineName}`)
  console.log(`  Username: ${username}`)
  console.log(`  Password: ${password}`)
  console.log(`  Project: ${root}`)
})

function shutdown() {
  for (const timer of slowResponses) clearTimeout(timer)
  slowResponses.clear()
  server.closeAllConnections?.()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2_000).unref()
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
