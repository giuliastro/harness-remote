import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

/*
 * Production-browser regression for daemon loss/recovery while a Native Session stays mounted.
 *
 * The browser opens one real Session projection, then the fake daemon is stopped completely on its
 * listening port. The live stream therefore closes and machine reads fail exactly as they would if
 * the local daemon were restarted. The mounted conversation must become non-interactive while the
 * machine is unavailable. When the same daemon identity comes back on the same port, the existing
 * mounted Session must recover without navigation/reload, preserve its transcript exactly once and
 * accept one new native prompt exactly once.
 *
 * This is fixture-level browser evidence. It deliberately does not claim to replace the real-harness
 * restart gate against installed Codex/Claude/OMP/PI/OpenCode processes.
 */

const PREVIEW_PORT = 4186
const DAEMON_PORT = 4432
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const DIRECTORY = "/work/native-reconnect-browser"
const SESSION_ID = "native-reconnect-claude-1"
const TITLE = "Daemon reconnect Session"
const HISTORY_USER = "RECONNECT-HISTORY-USER"
const HISTORY_REPLY = "RECONNECT-HISTORY-REPLY"
const RECOVERY_PROMPT = "RECONNECT-AFTER-DAEMON-RESTART"
const RECOVERY_REPLY = "RECONNECT-AFTER-DAEMON-RESTART-REPLY"

let clock = 10_000
let status = "idle"
let claimCount = 0
let nativeDispatches = 0
let sseOpened = 0
const promptBodies = []
const promptLedger = new Map()
const liveResponses = new Set()

function textPart(id, text) {
  return { id, type: "text", text }
}

function message(id, role, text, created, completed) {
  return {
    info: {
      id,
      role,
      sessionID: SESSION_ID,
      time: { created, ...(completed ? { completed } : {}) }
    },
    parts: [textPart(`${id}-text`, text)]
  }
}

const transcript = [
  message("reconnect-history-user", "user", HISTORY_USER, 1_000),
  message("reconnect-history-assistant", "assistant", HISTORY_REPLY, 1_001, 1_002)
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
  source: "native-session-reconnect-smoke"
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

function settlePrompt(body) {
  setTimeout(() => {
    const created = clock
    clock += 10
    transcript.push(
      message(`reconnect-user-${body.clientRequestId}`, "user", body.text, created),
      message(`reconnect-assistant-${body.clientRequestId}`, "assistant", RECOVERY_REPLY, created + 1, created + 2)
    )
    status = "idle"
    // Deliberately emit no final SSE event. Recovered mounted state still has to converge from the
    // authoritative native transcript/status after the daemon itself has disappeared and returned.
  }, 800)
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
        machine: { id: "machine-native-reconnect", name: "Reconnect Browser Test", createdAt: new Date().toISOString() },
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
        projects: [{
          id: "project-native-reconnect",
          machineId: "machine-native-reconnect",
          name: "native-reconnect-browser",
          path: DIRECTORY,
          kind: "git",
          configured: true
        }]
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
      assert.equal(decodeURIComponent(messageMatch[1]), SESSION_ID)
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
      assert.equal(body.text, RECOVERY_PROMPT)
      assert.equal(typeof body.clientRequestId, "string")
      assert.ok(body.clientRequestId.length > 0, "post-reconnect prompt must carry clientRequestId")

      const ledgerKey = `${SESSION_ID}:${body.clientRequestId}`
      if (!promptLedger.has(ledgerKey)) {
        promptLedger.set(ledgerKey, body)
        nativeDispatches += 1
        status = "busy"
        settlePrompt(body)
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
      sseOpened += 1
      liveResponses.add(response)
      request.on("close", () => liveResponses.delete(response))
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

async function waitFor(check, description, timeout = 20_000) {
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

async function waitForComposer(page, enabled) {
  const composer = page.getByRole("textbox", { name: /Message Claude/ })
  await composer.waitFor({ state: "visible", timeout: 15_000 })
  await waitFor(async () => (await composer.isDisabled()) === !enabled, `composer ${enabled ? "enabled" : "disabled"}`)
  return composer
}

async function openSession(page) {
  await page.locator('.hr-native-workspace[aria-label="Sessions"]').waitFor({ state: "visible", timeout: 15_000 })
  await page.getByRole("button", { name: new RegExp(TITLE) }).click()
  await page.getByRole("heading", { name: TITLE }).waitFor({ state: "visible", timeout: 15_000 })
  await page.getByText(HISTORY_USER, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  await page.getByText(HISTORY_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  await waitForComposer(page, true)
}

async function seed(page) {
  await page.addInitScript(({ key, port }) => {
    localStorage.setItem(key, JSON.stringify([{
      id: "machine-native-reconnect",
      name: "Reconnect Browser Test",
      config: { backend: "claude", host: "127.0.0.1", port, username: "harness", password: "testpw" }
    }]))
  }, { key: STORAGE_KEY, port: DAEMON_PORT })
}

async function stopDaemon(server) {
  for (const response of [...liveResponses]) {
    try { response.destroy() } catch {}
  }
  liveResponses.clear()
  try { server.closeAllConnections?.() } catch {}
  await new Promise((resolve) => {
    try { server.close(() => resolve()) }
    catch { resolve() }
  })
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
  await waitFor(() => sseOpened >= 1, "initial live-event connection")

  const initialSseConnections = sseOpened
  assert.equal(await page.getByText(HISTORY_USER, { exact: true }).count(), 1)
  assert.equal(await page.getByText(HISTORY_REPLY, { exact: true }).count(), 1)

  // Remove the daemon underneath an already-mounted Session. A foreground transition forces an
  // immediate machine revalidation while the closed live stream independently enters reconnect.
  await stopDaemon(daemon)
  daemon = null
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")))
  await waitForComposer(page, false)
  assert.equal(nativeDispatches, 0, "machine loss must not dispatch native work")
  assert.equal(promptBodies.length, 0, "machine loss must not invent a prompt request")
  assert.equal(await page.getByText(HISTORY_USER, { exact: true }).count(), 1, "cached transcript duplicated while daemon was down")
  assert.equal(await page.getByText(HISTORY_REPLY, { exact: true }).count(), 1, "cached reply duplicated while daemon was down")

  // Restore the exact same daemon/machine/native Session identity. Recovery must happen in-place:
  // no click on the Session row, no reload, no controller remount.
  daemon = await startFakeDaemon()
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")))
  await waitFor(() => sseOpened > initialSseConnections, "live-event stream to reconnect after daemon restart", 25_000)
  const composer = await waitForComposer(page, true)
  assert.equal(await page.getByText(HISTORY_USER, { exact: true }).count(), 1, "history duplicated after reconnect")
  assert.equal(await page.getByText(HISTORY_REPLY, { exact: true }).count(), 1, "history reply duplicated after reconnect")
  assert.equal(await page.getByRole("heading", { name: TITLE }).count(), 1, "mounted Session disappeared during reconnect")

  await composer.fill(RECOVERY_PROMPT)
  const send = page.getByRole("button", { name: "Send" })
  await waitFor(async () => !(await send.isDisabled()), "post-reconnect Send enabled")
  await send.click()

  await waitFor(() => nativeDispatches === 1, "exactly one post-reconnect native dispatch")
  await page.getByText(RECOVERY_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  await waitForComposer(page, true)

  assert.equal(claimCount, 1, "post-reconnect mutation must acquire writer ownership exactly once")
  assert.equal(promptBodies.length, 1, "post-reconnect Send must create exactly one HTTP prompt operation")
  assert.equal(nativeDispatches, 1, "post-reconnect Send must dispatch exactly one native prompt")
  assert.equal(promptLedger.size, 1, "post-reconnect request id must identify exactly one native mutation")
  assert.equal(await page.getByText(RECOVERY_PROMPT, { exact: true }).count(), 1, "post-reconnect prompt duplicated")
  assert.equal(await page.getByText(RECOVERY_REPLY, { exact: true }).count(), 1, "post-reconnect reply duplicated")
  assert.equal(await page.getByText(HISTORY_USER, { exact: true }).count(), 1, "original history changed after post-reconnect turn")
  assert.equal(await page.getByText(HISTORY_REPLY, { exact: true }).count(), 1, "original history reply changed after post-reconnect turn")
  assert.equal(await page.getByText(/Response interrupted/).count(), 0, "daemon reconnect manufactured Response interrupted")
  assert.deepEqual(pageErrors, [], `browser errors during daemon reconnect: ${pageErrors.join(" | ")}`)

  console.log("mounted Native Session daemon restart/reconnect smoke passed")
  await context.close()
} finally {
  if (browser) await browser.close().catch(() => {})
  if (daemon) await stopDaemon(daemon).catch(() => {})
  stopPreview(preview)
}
