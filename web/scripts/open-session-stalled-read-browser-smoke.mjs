import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

/*
 * Production-browser regression: an open Session keeps updating after one transcript read stalls.
 *
 * The daemon answers one transcript read with headers and part of the body, then never finishes it,
 * which is what a connection does across sleep, a locked screen or a network change. Before the fix
 * the request deadline stopped at the headers, that read stayed pending forever, and every later
 * live event, poll and foreground refresh queued behind it: the open Session kept showing old
 * messages until the user opened another Session and came back. New messages must now appear while
 * the Session stays open.
 */

const PREVIEW_PORT = 4189
const DAEMON_PORT = 4435
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const DIRECTORY = "/work/stalled-read"
const SESSION_ID = "stalled-read-session"
const TITLE = "Stalled read Session"
const HISTORY_USER = "STALLED-HISTORY-USER"
const HISTORY_REPLY = "STALLED-HISTORY-REPLY"
const NEW_USER = "WRITTEN-FROM-THE-PHONE"
const NEW_REPLY = "REPLY-WRITTEN-WHILE-THE-READ-WAS-STUCK"

let stallNextRead = false
let stalledReads = 0
const sseResponses = new Set()

function message(id, role, text, created) {
  return {
    info: { id, role, sessionID: SESSION_ID, time: { created, ...(role === "assistant" ? { completed: created + 1 } : {}) } },
    parts: [{ id: `${id}-text`, type: "text", text }]
  }
}

const transcript = [
  message("history-user", "user", HISTORY_USER, 1_000),
  message("history-reply", "assistant", HISTORY_REPLY, 1_001)
]

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Harness-Backend",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": "X-Has-More, X-Next-Cursor, X-Session-Model",
    "Access-Control-Max-Age": "600"
  }
}

function json(response, statusCode, value, extraHeaders = {}) {
  response.writeHead(statusCode, { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders })
  response.end(JSON.stringify(value))
}

function emitLiveEvent(type) {
  const frame = `data: ${JSON.stringify({ directory: DIRECTORY, payload: { type, properties: { sessionID: SESSION_ID, info: { sessionID: SESSION_ID } } } })}\n\n`
  for (const response of [...sseResponses]) {
    try { response.write(frame) } catch { sseResponses.delete(response) }
  }
}

function startFakeDaemon() {
  const server = http.createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders())
      response.end()
      return
    }
    const url = new URL(request.url || "/", `http://127.0.0.1:${DAEMON_PORT}`)
    if (request.method === "GET" && url.pathname === "/v1/machine") {
      json(response, 200, {
        machine: { id: "machine-stalled-read", name: "Stalled Read Test", createdAt: new Date().toISOString() },
        agents: [{
          id: "claude",
          label: "Claude Code",
          backend: "claude",
          transport: "acp",
          managed: true,
          state: "available",
          capabilities: { sessions: true, prompt: true, abort: true, streaming: true, models: false }
        }]
      })
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/projects") {
      json(response, 200, { projects: [{ id: "project-stalled", machineId: "machine-stalled-read", name: "stalled-read", path: DIRECTORY, kind: "git", configured: true }] })
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/agents/claude/experimental/session") {
      json(response, 200, [{ id: SESSION_ID, title: TITLE, directory: DIRECTORY, external: true, time: { created: 1_000, updated: 2_000 } }])
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/agents/claude/session/status") {
      json(response, 200, { [SESSION_ID]: { type: "idle" } })
      return
    }
    if (request.method === "GET" && url.pathname === `/v1/agents/claude/session/${SESSION_ID}/message`) {
      if (stallNextRead) {
        // Headers and the start of the body arrive; the rest never does.
        stallNextRead = false
        stalledReads += 1
        response.writeHead(200, { "Content-Type": "application/json", ...corsHeaders(), "X-Has-More": "0" })
        response.write("[{\"info\":")
        return
      }
      json(response, 200, transcript, { "X-Has-More": "0" })
      return
    }
    if (request.method === "GET" && url.pathname.includes("/global/event")) {
      response.writeHead(200, { ...corsHeaders(), "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
      response.write(": connected\n\n")
      sseResponses.add(response)
      request.on("close", () => sseResponses.delete(response))
      return
    }
    if (request.method === "GET" && (url.pathname.includes("/question") || url.pathname.includes("/permission"))) {
      json(response, 200, [])
      return
    }
    if (request.method === "GET" && (url.pathname.endsWith("/capabilities") || url.pathname.endsWith("/models"))) {
      json(response, 200, url.pathname.endsWith("/models") ? { models: [], stale: false } : { attachments: false, commands: false })
      return
    }
    json(response, 404, { error: `No fake route for ${request.method} ${url.pathname}` })
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(DAEMON_PORT, "127.0.0.1", () => resolve(server))
  })
}

function startPreview() {
  const command = process.platform === "win32" ? "npm.cmd" : "npm"
  return spawn(command, ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(PREVIEW_PORT), "--strictPort"], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    detached: process.platform !== "win32"
  })
}

async function ready(url) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Preview did not become ready: ${url}`)
}

function stopPreview(child) {
  if (!child || !child.pid) return
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"])
    else process.kill(-child.pid, "SIGTERM")
  } catch {}
}

const daemon = await startFakeDaemon()
const preview = startPreview()
let browser
try {
  await ready(APP_ORIGIN)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, locale: "en-US" })
  const page = await context.newPage()
  await page.addInitScript(({ key, port }) => {
    localStorage.setItem(key, JSON.stringify([{
      id: "machine-stalled-read",
      name: "Stalled Read Test",
      config: { backend: "claude", host: "127.0.0.1", port, username: "harness", password: "testpw" }
    }]))
  }, { key: STORAGE_KEY, port: DAEMON_PORT })
  await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: new RegExp(TITLE) }).click()
  await page.getByText(HISTORY_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 20_000 })

  // The next transcript read stalls mid-body. Meanwhile the phone adds a turn and the daemon keeps
  // announcing it, as it would while this window is open.
  stallNextRead = true
  transcript.push(message("phone-user", "user", NEW_USER, 3_000), message("phone-reply", "assistant", NEW_REPLY, 3_001))
  emitLiveEvent("message.updated")
  const deadline = Date.now() + 70_000
  while (Date.now() < deadline) {
    if (stalledReads > 0) emitLiveEvent("message.updated")
    if (await page.getByText(NEW_REPLY, { exact: true }).count()) break
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  assert.equal(stalledReads, 1, "the fake daemon must have stalled one transcript read")
  assert.equal(
    await page.getByText(NEW_REPLY, { exact: true }).count(),
    1,
    "the open Session must show the new reply without navigating away after a stalled read"
  )
  assert.equal(await page.getByText(NEW_USER, { exact: true }).count(), 1)
  console.log("open Session stalled read browser smoke passed")
} finally {
  await browser?.close()
  stopPreview(preview)
  try { daemon.closeAllConnections?.() } catch {}
  daemon.close()
}
