import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

/*
 * Production-browser regression for the shared mounted Native Session contract on Claude Code.
 *
 * Claude already has provider-level bridge tests for stale busy status, unfinished tool activity and
 * Stop. This smoke protects the UI/controller boundary: after a prompt is accepted, the harness can
 * persist its final reply (or provider error) and become idle without emitting a convenient final
 * SSE event. The already-mounted Session must converge by authoritative readback, remain usable and
 * never require navigation/reload.
 */

const PREVIEW_PORT = 4185
const DAEMON_PORT = 4431
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const DIRECTORY = "/work/native-claude-browser"
const SESSION_ID = "native-claude-browser-1"
const TITLE = "Claude mounted convergence"
const HISTORY_USER = "CLAUDE-HISTORY-USER"
const HISTORY_REPLY = "CLAUDE-HISTORY-REPLY"
const SUCCESS_PROMPT = "CLAUDE-BROWSER-SUCCESS"
const SUCCESS_REPLY = "CLAUDE-BROWSER-SUCCESS-REPLY"
const ERROR_PROMPT = "CLAUDE-BROWSER-ERROR"
const ERROR_TEXT = "Claude synthetic provider failure"
const RECOVERY_PROMPT = "CLAUDE-BROWSER-RECOVERY"
const RECOVERY_REPLY = "CLAUDE-BROWSER-RECOVERY-REPLY"

let clock = 10_000
let status = "idle"
let claimCount = 0
let nativeDispatches = 0
const promptBodies = []
const promptLedger = new Map()
const sseResponses = new Set()

function textPart(id, text) {
  return { id, type: "text", text }
}

function message(id, role, parts, created, extraInfo = {}) {
  return {
    info: {
      id,
      role,
      sessionID: SESSION_ID,
      time: { created, ...(extraInfo.completed ? { completed: extraInfo.completed } : {}) },
      ...(extraInfo.error ? { error: extraInfo.error } : {})
    },
    parts
  }
}

const transcript = [
  message("claude-history-user", "user", [textPart("claude-history-user-text", HISTORY_USER)], 1_000),
  message("claude-history-assistant", "assistant", [textPart("claude-history-assistant-text", HISTORY_REPLY)], 1_001, { completed: 1_002 })
]

const MODEL_CATALOG = {
  models: [{
    providerID: "claude",
    providerName: "Claude Code",
    modelID: "sonnet",
    modelName: "Claude Sonnet",
    isDefault: true,
    tools: true
  }],
  stale: false,
  refreshedAt: new Date().toISOString(),
  source: "native-claude-browser-smoke"
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Harness-Backend",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600"
  }
}

function json(response, statusCode, value, extraHeaders = {}) {
  response.writeHead(statusCode, { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders })
  response.end(JSON.stringify(value))
}

async function requestJSON(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString("utf8")
  return raw ? JSON.parse(raw) : {}
}

function appendUser(prompt, requestID) {
  const created = clock
  clock += 10
  transcript.push(message(`claude-user-${requestID}`, "user", [textPart(`claude-user-text-${requestID}`, prompt)], created))
  return created
}

function appendSuccess(prompt, requestID, reply) {
  const created = appendUser(prompt, requestID)
  transcript.push(message(
    `claude-assistant-${requestID}`,
    "assistant",
    [textPart(`claude-assistant-text-${requestID}`, reply)],
    created + 1,
    { completed: created + 2 }
  ))
}

function appendFailure(prompt, requestID) {
  const created = appendUser(prompt, requestID)
  transcript.push(message(
    `claude-error-${requestID}`,
    "assistant",
    [],
    created + 1,
    {
      completed: created + 2,
      error: {
        name: "ClaudeProviderError",
        message: ERROR_TEXT,
        data: { message: ERROR_TEXT }
      }
    }
  ))
}

function settleTurn(body) {
  // Deliberately no final SSE event. The mounted controller must rediscover this native truth.
  setTimeout(() => {
    if (body.text === ERROR_PROMPT) appendFailure(body.text, body.clientRequestId)
    else if (body.text === RECOVERY_PROMPT) appendSuccess(body.text, body.clientRequestId, RECOVERY_REPLY)
    else appendSuccess(body.text, body.clientRequestId, SUCCESS_REPLY)
    status = "idle"
  }, 900)
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
        machine: { id: "machine-native-claude", name: "Claude Browser Test", createdAt: new Date().toISOString() },
        agents: [{
          id: "claude",
          label: "Claude Code",
          backend: "claude",
          transport: "acp",
          managed: true,
          state: "available",
          capabilities: { sessions: true, prompt: true, abort: true, streaming: true, models: true },
          contract: { sessions: { stop: "owned-session-native-cancel" } }
        }]
      })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/projects") {
      json(response, 200, {
        projects: [{ id: "project-native-claude", machineId: "machine-native-claude", name: "native-claude-browser", path: DIRECTORY, kind: "git", configured: true }]
      })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/claude/experimental/session") {
      json(response, 200, [{
        id: SESSION_ID,
        title: TITLE,
        directory: DIRECTORY,
        external: true,
        time: { created: 1_000, updated: clock }
      }])
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/claude/session/status") {
      json(response, 200, { [SESSION_ID]: { type: status } })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/claude/models") {
      json(response, 200, MODEL_CATALOG)
      return
    }

    if (request.method === "GET" && (url.pathname === "/v1/agents/claude/capabilities" || url.pathname === "/v1/agents/claude/v1/capabilities")) {
      json(response, 200, { attachments: false, commands: false })
      return
    }

    const messageMatch = /^\/v1\/agents\/claude\/session\/([^/]+)\/message$/.exec(url.pathname)
    if (request.method === "GET" && messageMatch) {
      const sessionID = decodeURIComponent(messageMatch[1])
      assert.equal(sessionID, SESSION_ID)
      json(response, 200, transcript, { "X-Has-More": "0" })
      return
    }

    const claimMatch = /^\/v1\/agents\/claude\/session\/([^/]+)\/claim$/.exec(url.pathname)
    if (request.method === "POST" && claimMatch) {
      assert.equal(decodeURIComponent(claimMatch[1]), SESSION_ID)
      claimCount += 1
      json(response, 200, { ok: true, sessionID: SESSION_ID })
      return
    }

    const promptMatch = /^\/v1\/agents\/claude\/session\/([^/]+)\/prompt$/.exec(url.pathname)
    if (request.method === "POST" && promptMatch) {
      assert.equal(decodeURIComponent(promptMatch[1]), SESSION_ID)
      const body = await requestJSON(request)
      promptBodies.push(body)
      assert.equal(typeof body.clientRequestId, "string")
      assert.ok(body.clientRequestId.length > 0, "Claude prompt must carry a durable clientRequestId")

      const ledgerKey = `${SESSION_ID}:${body.clientRequestId}`
      if (!promptLedger.has(ledgerKey)) {
        promptLedger.set(ledgerKey, body)
        nativeDispatches += 1
        status = "busy"
        settleTurn(body)
      }

      json(response, 200, { status: "accepted", clientRequestId: body.clientRequestId, sessionID: SESSION_ID })
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

    if (request.method === "GET" && (url.pathname.includes("/question") || url.pathname.includes("/permission"))) {
      json(response, 200, [])
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
  let lastError
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw lastError || new Error(`Preview did not become ready: ${url}`)
}

async function waitFor(check, description, timeout = 15_000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 75))
  }
  if (lastError) throw lastError
  throw new Error(`Timed out waiting for ${description}`)
}

async function waitForReady(page) {
  await page.locator(".tdw-conversation-state.ready").waitFor({ state: "attached", timeout: 15_000 })
  const composer = page.getByRole("textbox", { name: /Message Claude/ })
  await composer.waitFor({ state: "visible", timeout: 15_000 })
  assert.equal(await composer.isDisabled(), false, "Claude composer must be enabled after mounted convergence")
}

async function sendPrompt(page, text) {
  const composer = page.getByRole("textbox", { name: /Message Claude/ })
  await composer.fill(text)
  const send = page.getByRole("button", { name: "Send" })
  await waitFor(async () => !(await send.isDisabled()), `Claude Send enabled for ${text}`)
  await send.click()
}

async function openSession(page) {
  await page.locator('.hr-native-workspace[aria-label="Sessions"]').waitFor({ state: "visible", timeout: 15_000 })
  await page.getByRole("button", { name: new RegExp(TITLE) }).click()
  await page.getByRole("heading", { name: TITLE }).waitFor({ state: "visible", timeout: 15_000 })
  await page.getByText(HISTORY_USER, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  await page.getByText(HISTORY_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  await waitForReady(page)
}

async function seed(page) {
  await page.addInitScript(({ key, port }) => {
    localStorage.setItem(key, JSON.stringify([{
      id: "machine-native-claude",
      name: "Claude Browser Test",
      config: { backend: "claude", host: "127.0.0.1", port, username: "harness", password: "testpw" }
    }]))
  }, { key: STORAGE_KEY, port: DAEMON_PORT })
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

let daemon
let preview
let browser
try {
  daemon = await startFakeDaemon()
  preview = startPreview()
  await ready(APP_ORIGIN)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const pageErrors = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await seed(page)
  await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" })
  await openSession(page)

  const beforeSuccess = nativeDispatches
  await sendPrompt(page, SUCCESS_PROMPT)
  await waitFor(() => nativeDispatches === beforeSuccess + 1, "one Claude success native dispatch")
  await page.getByText(SUCCESS_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  await waitForReady(page)
  assert.equal(await page.getByText(SUCCESS_PROMPT, { exact: true }).count(), 1, "Claude success prompt duplicated")
  assert.equal(await page.getByText(SUCCESS_REPLY, { exact: true }).count(), 1, "Claude success reply duplicated")
  assert.equal(await page.getByText(/Response interrupted/).count(), 0, "Claude normal completion manufactured Response interrupted")

  await sendPrompt(page, ERROR_PROMPT)
  await waitFor(() => nativeDispatches === beforeSuccess + 2, "one Claude provider-error native dispatch")
  await page.getByText(ERROR_TEXT, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  await waitForReady(page)
  assert.equal(await page.getByText(ERROR_PROMPT, { exact: true }).count(), 1, "Claude error prompt duplicated")
  assert.equal(await page.getByText(ERROR_TEXT, { exact: true }).count(), 1, "Claude provider error duplicated")

  // Same mounted Session, no reload/remount after the provider failure.
  await sendPrompt(page, RECOVERY_PROMPT)
  await waitFor(() => nativeDispatches === beforeSuccess + 3, "one Claude recovery native dispatch")
  await page.getByText(RECOVERY_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  await waitForReady(page)
  assert.equal(await page.getByText(RECOVERY_PROMPT, { exact: true }).count(), 1, "Claude recovery prompt duplicated")
  assert.equal(await page.getByText(RECOVERY_REPLY, { exact: true }).count(), 1, "Claude recovery reply duplicated")
  assert.equal(await page.getByText(ERROR_TEXT, { exact: true }).count(), 1, "Claude persisted provider failure changed after recovery")
  assert.equal(await page.getByText(/Response interrupted/).count(), 0, "Claude mounted recovery manufactured Response interrupted")

  assert.equal(claimCount, 1, "Claude writer ownership should be acquired once and reused while mounted")
  assert.equal(nativeDispatches, 3, "three Claude Send actions must dispatch exactly three native prompts")
  assert.equal(promptBodies.length, 3, "Claude browser smoke unexpectedly retried prompt HTTP")
  assert.equal(new Set(promptBodies.map((body) => body.clientRequestId)).size, 3, "distinct Claude turns must keep distinct durable clientRequestIds")
  assert.deepEqual(pageErrors, [], `browser errors during Claude mounted convergence: ${pageErrors.join(" | ")}`)

  console.log("native Claude mounted completion, provider-error, and recovery browser smoke passed")
  await context.close()
} finally {
  if (browser) await browser.close().catch(() => {})
  for (const response of sseResponses) {
    try { response.end() } catch {}
  }
  stopPreview(preview)
  stopServer(daemon)
}
