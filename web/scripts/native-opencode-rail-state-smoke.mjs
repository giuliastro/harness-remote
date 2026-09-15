import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const PREVIEW_PORT = 4189
const DAEMON_PORT = 4439
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const MACHINE_ID = "machine-opencode-rail-state"
const DIRECTORY = "/work/opencode-rail-state"
const WORKING_ID = "opencode-rail-working"
const READY_ID = "opencode-rail-ready"
const WORKING_TITLE = "Rail Working Session"
const READY_TITLE = "Rail Ready Session"
const PROMPT = "RAIL-STATE-PROMPT"
const FINAL = "RAIL-STATE-FINAL"

let sessions
let statuses
let transcripts
let sseResponses
let promptCount
let clock

function resetState() {
  clock = 20_000
  promptCount = 0
  sseResponses = new Set()
  statuses = new Map([
    [WORKING_ID, { type: "idle" }],
    [READY_ID, { type: "idle" }]
  ])
  transcripts = new Map([
    [WORKING_ID, []],
    [READY_ID, []]
  ])
  sessions = new Map([
    [WORKING_ID, {
      id: WORKING_ID,
      title: WORKING_TITLE,
      directory: DIRECTORY,
      time: { created: 2_000, updated: 4_000 }
    }],
    [READY_ID, {
      id: READY_ID,
      title: READY_TITLE,
      directory: DIRECTORY,
      time: { created: 1_000, updated: 3_000 }
    }]
  ])
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Harness-Backend",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600"
  }
}

function json(response, status, value, extraHeaders = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders })
  response.end(JSON.stringify(value))
}

async function requestJSON(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString("utf8")
  return raw ? JSON.parse(raw) : null
}

function emit(type, properties) {
  const frame = `data: ${JSON.stringify({
    directory: DIRECTORY,
    payload: { type, properties }
  })}\n\n`
  for (const response of [...sseResponses]) {
    try { response.write(frame) }
    catch { sseResponses.delete(response) }
  }
}

function appendUser(sessionID, text) {
  const created = clock++
  const list = transcripts.get(sessionID) || []
  list.push({
    info: {
      id: `user-${created}`,
      role: "user",
      sessionID,
      time: { created },
      model: { providerID: "openai", modelID: "gpt-5.6-codex" }
    },
    parts: [{ id: `user-${created}-text`, type: "text", text }]
  })
  transcripts.set(sessionID, list)
}

function finishTurn(sessionID) {
  const created = clock++
  const list = transcripts.get(sessionID) || []
  list.push({
    info: {
      id: `assistant-${created}`,
      role: "assistant",
      sessionID,
      time: { created, completed: created },
      finish: "stop",
      providerID: "openai",
      modelID: "gpt-5.6-codex"
    },
    parts: [{ id: `assistant-${created}-text`, type: "text", text: FINAL }]
  })
  transcripts.set(sessionID, list)
  const session = sessions.get(sessionID)
  if (session) session.time.updated = created
  statuses.set(sessionID, { type: "idle" })
  emit("session.status", { sessionID, status: { type: "idle" } })
}

function startFakeDaemon() {
  const server = http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders())
      response.end()
      return
    }

    const url = new URL(request.url || "/", `http://127.0.0.1:${DAEMON_PORT}`)

    if (request.method === "GET" && url.pathname === "/v1/machine") {
      json(response, 200, {
        machine: { id: MACHINE_ID, name: "OpenCode rail-state machine", createdAt: new Date().toISOString() },
        agents: [{
          id: "opencode",
          label: "OpenCode",
          backend: "opencode",
          transport: "http",
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
          },
          contract: { sessions: { stop: "native-abort" } }
        }]
      })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/projects") {
      json(response, 200, {
        projects: [{
          id: "project-opencode-rail-state",
          machineId: MACHINE_ID,
          name: "opencode-rail-state",
          path: DIRECTORY,
          kind: "git",
          configured: true
        }]
      })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/opencode/experimental/session") {
      json(response, 200, [...sessions.values()])
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/opencode/session/status") {
      json(response, 200, Object.fromEntries(statuses))
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/opencode/models") {
      json(response, 200, {
        models: [{
          providerID: "openai",
          providerName: "OpenAI",
          modelID: "gpt-5.6-codex",
          modelName: "GPT-5.6 Codex",
          isDefault: true,
          tools: true
        }],
        stale: false,
        refreshedAt: new Date().toISOString(),
        source: "opencode-rail-state-smoke"
      })
      return
    }

    if (request.method === "GET" && url.pathname.includes("/global/event")) {
      response.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      })
      response.write(": connected\n\n")
      sseResponses.add(response)
      request.on("close", () => sseResponses.delete(response))
      return
    }

    const messageMatch = /^\/v1\/agents\/opencode\/session\/([^/]+)\/message$/.exec(url.pathname)
    if (request.method === "GET" && messageMatch) {
      const sessionID = decodeURIComponent(messageMatch[1])
      const all = transcripts.get(sessionID) || []
      const requestedLimit = Number(url.searchParams.get("limit")) || all.length
      json(response, 200, all.slice(Math.max(0, all.length - requestedLimit)), { "X-Has-More": "0" })
      return
    }

    const promptMatch = /^\/v1\/agents\/opencode\/session\/([^/]+)\/prompt$/.exec(url.pathname)
    if (request.method === "POST" && promptMatch) {
      const sessionID = decodeURIComponent(promptMatch[1])
      const body = await requestJSON(request)
      promptCount += 1
      appendUser(sessionID, body?.text || "")
      statuses.set(sessionID, { type: "busy" })
      const session = sessions.get(sessionID)
      if (session) session.time.updated = clock++
      emit("session.status", { sessionID, status: { type: "busy" } })
      json(response, 200, { status: "accepted", clientRequestId: body?.clientRequestId })
      setTimeout(() => finishTurn(sessionID), 850)
      return
    }

    if (request.method === "GET" && (url.pathname.includes("/question") || url.pathname.includes("/permission"))) {
      json(response, 200, [])
      return
    }

    if (request.method === "GET" && url.pathname.endsWith("/vcs")) {
      json(response, 200, {})
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
    detached: process.platform !== "win32"
  })
}

async function ready(url) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return }
    catch {}
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Preview did not become ready: ${url}`)
}

function stopPreview(child) {
  if (!child || child.killed || !child.pid) return
  try {
    if (process.platform === "win32") child.kill("SIGTERM")
    else process.kill(-child.pid, "SIGTERM")
  } catch {
    try { child.kill("SIGTERM") } catch {}
  }
}

function stopServer(server) {
  try { server.closeAllConnections?.() } catch {}
  try { server.close() } catch {}
}

async function seed(page) {
  await page.addInitScript(({ key, port, machineID }) => {
    localStorage.setItem(key, JSON.stringify([{
      id: machineID,
      name: "OpenCode rail-state machine",
      config: {
        backend: "opencode",
        host: "127.0.0.1",
        port,
        username: "harness",
        password: "testpw"
      }
    }]))
  }, { key: STORAGE_KEY, port: DAEMON_PORT, machineID: MACHINE_ID })
}

async function waitForRowState(button, state, timeout = 4_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await button.evaluate((element, expected) => element.classList.contains(expected), state)) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  const className = await button.getAttribute("class")
  throw new Error(`Session row did not become ${state}; class=${className}`)
}

let daemon
let preview
let browser
let context
try {
  resetState()
  daemon = await startFakeDaemon()
  preview = startPreview()
  await ready(APP_ORIGIN)
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1366, height: 768 } })
  const page = await context.newPage()
  await seed(page)
  await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" })

  await page.locator('.hr-native-workspace[aria-label="Sessions"]').waitFor({ state: "visible" })
  const workingButton = page.getByRole("button", { name: new RegExp(`Open ${WORKING_TITLE}`) })
  const readyButton = page.getByRole("button", { name: new RegExp(`Open ${READY_TITLE}`) })
  await workingButton.waitFor({ state: "visible", timeout: 5_000 })
  await readyButton.waitFor({ state: "visible", timeout: 5_000 })

  await workingButton.click()
  await page.locator(".uw-composer-shell").waitFor({ state: "visible" })
  const sseDeadline = Date.now() + 5_000
  while (Date.now() < sseDeadline && sseResponses.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(sseResponses.size > 0, "OpenCode event stream did not connect")

  const composer = page.getByRole("textbox", { name: "Message OpenCode" })
  await composer.fill(PROMPT)
  await page.getByRole("button", { name: "Send" }).click()
  const promptDeadline = Date.now() + 1_500
  while (Date.now() < promptDeadline && promptCount === 0) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(promptCount, 1, "one Send must dispatch exactly one OpenCode prompt")
  await waitForRowState(workingButton, "working")

  // Reproduce the real regression: leave A while its turn is still live. The old presentation bridge
  // remembered Working, but no Session-index refresh was triggered when A later completed.
  await readyButton.click()
  await page.locator(".tdw-work-thread-conversation").waitFor({ state: "visible" })
  assert.equal(await readyButton.getAttribute("aria-current"), "page", "Session B must be the selected detail")

  // A must converge from Working -> Ready entirely in the rail. Reopening A is deliberately forbidden
  // until after this assertion; otherwise navigation itself would hide the bug by refreshing A.
  await waitForRowState(workingButton, "ready", 5_000)
  assert.equal(await workingButton.getAttribute("aria-current"), null, "Session A must remain unselected while its row settles")

  await workingButton.click()
  await page.getByText(FINAL, { exact: true }).waitFor({ state: "visible", timeout: 2_000 })
  assert.equal(await page.getByText(FINAL, { exact: true }).count(), 1, "completed OpenCode reply must remain single after reopen")

  console.log("native OpenCode rail-state smoke: Working Session settles to Ready after navigation without reopen")
} finally {
  if (context) await context.close().catch(() => {})
  if (browser) await browser.close().catch(() => {})
  for (const response of sseResponses || []) {
    try { response.end() } catch {}
  }
  stopPreview(preview)
  stopServer(daemon)
}
