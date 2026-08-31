import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const PREVIEW_PORT = 4176
const DAEMON_PORT = 4422
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const MACHINE_ID = "machine-opencode-v3-first"
const SESSION_ID = "native-opencode-v3-first-1"
const CREATED_SESSION_ID = "native-opencode-created-1"
const DIRECTORY = "/work/native-opencode-v3-first"
const SUCCESS_PROMPT = "OPENCODE-SUCCESS-PROMPT"
const SUCCESS_REPLY = "OPENCODE-SINGLE-FINAL-REPLY"
const SECOND_PROMPT = "OPENCODE-SECOND-PROMPT"
const SECOND_REPLY = "OPENCODE-SECOND-REPLY"
const INTERRUPT_PROMPT = "OPENCODE-TRANSIENT-INTERRUPTION-PROMPT"
const INTERRUPT_REPLY = "OPENCODE-RECOVERED-FINAL-REPLY"
const TERMINAL_INTERRUPT_PROMPT = "OPENCODE-TERMINAL-INTERRUPTION-PROMPT"
const LATE_RECOVERY_PROMPT = "OPENCODE-LATE-RECOVERY-PROMPT"
const LATE_RECOVERY_REPLY = "OPENCODE-LATE-RECOVERY-FINAL-REPLY"
const CREATE_TITLE = "OpenCode created from Harness Remote"
const CREATE_PROMPT = "OPENCODE-CREATED-FIRST-PROMPT"
const CREATE_REPLY = "OPENCODE-CREATED-FIRST-REPLY"
const REOPEN_PROMPT = "OPENCODE-CREATED-REOPEN-PROMPT"
const REOPEN_REPLY = "OPENCODE-CREATED-REOPEN-REPLY"

function textPart(id, text) {
  return { id, type: "text", text }
}

function message(sessionID, id, role, text, created) {
  const assistant = role === "assistant"
  return {
    info: {
      id,
      role,
      sessionID,
      time: assistant ? { created, completed: created } : { created },
      ...(assistant ? { finish: "stop" } : {})
    },
    parts: [textPart(`${id}-text`, text)]
  }
}

function initialTranscript() {
  return [
    message(SESSION_ID, "oc-history-user-1", "user", "OPENCODE-HISTORY-USER-1", 1_000),
    message(SESSION_ID, "oc-history-assistant-1", "assistant", "OPENCODE-HISTORY-ASSISTANT-1", 1_001)
  ]
}

let sessionCatalog
let sessionStatuses
let transcripts
let modelCatalogReads
let promptHttpBodies
let nativePromptDispatches
let ledger
let clock
let sseResponses
let createCount
let createBodies
let claimRequests

function resetFakeState() {
  sessionCatalog = new Map([[SESSION_ID, {
    id: SESSION_ID,
    title: "OpenCode v3-first regression session",
    directory: DIRECTORY,
    external: true,
    time: { created: 1_000, updated: 1_001 }
  }]])
  sessionStatuses = new Map([[SESSION_ID, { type: "idle" }]])
  transcripts = new Map([[SESSION_ID, initialTranscript()]])
  modelCatalogReads = 0
  promptHttpBodies = []
  nativePromptDispatches = 0
  ledger = new Map()
  clock = 10_000
  sseResponses = new Set()
  createCount = 0
  createBodies = []
  claimRequests = 0
}

function transcript(sessionID) {
  const current = transcripts.get(sessionID)
  if (current) return current
  const created = []
  transcripts.set(sessionID, created)
  return created
}

function replyFor(prompt) {
  if (prompt === SUCCESS_PROMPT) return SUCCESS_REPLY
  if (prompt === SECOND_PROMPT) return SECOND_REPLY
  if (prompt === INTERRUPT_PROMPT) return INTERRUPT_REPLY
  if (prompt === LATE_RECOVERY_PROMPT) return LATE_RECOVERY_REPLY
  if (prompt === CREATE_PROMPT) return CREATE_REPLY
  if (prompt === REOPEN_PROMPT) return REOPEN_REPLY
  return `OpenCode reply for ${prompt}`
}

function appendTurn(sessionID, prompt, requestId) {
  const base = clock
  clock += 10
  transcript(sessionID).push(
    message(sessionID, `oc-user-${requestId}`, "user", prompt, base),
    message(sessionID, `oc-assistant-${requestId}`, "assistant", replyFor(prompt), base + 1)
  )
  const entry = sessionCatalog.get(sessionID)
  if (entry) entry.time.updated = base + 1
}

function appendInterruptedTurn(sessionID, prompt, requestId) {
  const base = clock
  clock += 10
  transcript(sessionID).push(
    message(sessionID, `oc-user-${requestId}`, "user", prompt, base),
    {
      info: {
        id: `oc-assistant-${requestId}-interrupted`,
        role: "assistant",
        sessionID,
        time: { created: base + 1, completed: base + 2 },
        finish: "tool-calls"
      },
      parts: [
        { id: `oc-assistant-${requestId}-reasoning`, type: "reasoning", text: "Provider retry in progress" },
        { id: `oc-assistant-${requestId}-step-finish`, type: "step-finish" }
      ]
    }
  )
  const entry = sessionCatalog.get(sessionID)
  if (entry) entry.time.updated = base + 2
}

function finishInterruptedTurn(sessionID, prompt, requestId) {
  const completed = clock++
  transcript(sessionID).push(message(
    sessionID,
    `oc-assistant-${requestId}-recovered`,
    "assistant",
    replyFor(prompt),
    completed
  ))
  const entry = sessionCatalog.get(sessionID)
  if (entry) entry.time.updated = completed
}

function appendPendingTurn(sessionID, prompt, requestId) {
  const base = clock
  clock += 10
  transcript(sessionID).push(
    message(sessionID, `oc-user-${requestId}`, "user", prompt, base),
    {
      info: { id: `oc-assistant-${requestId}`, role: "assistant", sessionID, time: { created: base + 1 } },
      parts: []
    }
  )
  const entry = sessionCatalog.get(sessionID)
  if (entry) entry.time.updated = base + 1
}

function finishPendingTurn(sessionID, prompt, requestId) {
  const current = transcript(sessionID)
  const assistant = current.find((item) => item.info.id === `oc-assistant-${requestId}`)
  if (!assistant) return
  const completed = clock++
  assistant.info = { ...assistant.info, time: { ...assistant.info.time, completed }, finish: "stop" }
  assistant.parts = [textPart(`oc-assistant-${requestId}-text`, replyFor(prompt))]
  const entry = sessionCatalog.get(sessionID)
  if (entry) entry.time.updated = completed
}

function emitLiveEvent(sessionID, type = "message.updated") {
  const frame = `data: ${JSON.stringify({ directory: DIRECTORY, payload: { type, properties: { info: { sessionID } } } })}\n\n`
  for (const response of [...sseResponses]) {
    try { response.write(frame) }
    catch { sseResponses.delete(response) }
  }
}

const MODEL_CATALOG = {
  models: [
    {
      providerID: "openai",
      providerName: "OpenAI",
      modelID: "gpt-5.6-codex",
      modelName: "GPT-5.6 Codex",
      description: "OpenCode coding model",
      isDefault: true,
      tools: true,
      contextLimit: 200000,
      outputLimit: 64000
    },
    {
      providerID: "openai",
      providerName: "OpenAI",
      modelID: "gpt-5.6-codex",
      modelName: "GPT-5.6 Codex",
      description: "OpenCode coding model high effort",
      variant: "high",
      tools: true,
      contextLimit: 200000,
      outputLimit: 64000
    }
  ],
  stale: false,
  refreshedAt: new Date().toISOString(),
  source: "native-opencode-v3-first-smoke"
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
        machine: { id: MACHINE_ID, name: "OpenCode v3-first Test", createdAt: new Date().toISOString() },
        agents: [{
          id: "opencode",
          label: "OpenCode",
          backend: "opencode",
          transport: "http",
          managed: true,
          state: "available",
          capabilities: { sessions: true, prompt: true, abort: true, streaming: true, models: true },
          contract: { sessions: { stop: "native-abort" } }
        }]
      })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/projects") {
      json(response, 200, {
        projects: [{ id: "project-opencode-v3-first", machineId: MACHINE_ID, name: "native-opencode-v3-first", path: DIRECTORY, kind: "git", configured: true }]
      })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/opencode/experimental/session") {
      json(response, 200, [...sessionCatalog.values()])
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/opencode/session/status") {
      json(response, 200, Object.fromEntries([...sessionCatalog.keys()].map((sessionID) => [
        sessionID,
        sessionStatuses.get(sessionID) || { type: "idle" }
      ])))
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/opencode/models") {
      modelCatalogReads += 1
      json(response, 200, MODEL_CATALOG)
      return
    }

    const messageMatch = /^\/v1\/agents\/opencode\/session\/([^/]+)\/message$/.exec(url.pathname)
    if (request.method === "GET" && messageMatch) {
      const sessionID = decodeURIComponent(messageMatch[1])
      json(response, 200, transcript(sessionID), { "X-Has-More": "0" })
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

    if (request.method === "POST" && url.pathname === "/v1/agents/opencode/session") {
      const body = await requestJSON(request)
      createCount += 1
      createBodies.push({ directory: url.searchParams.get("directory"), body })
      const created = {
        id: CREATED_SESSION_ID,
        title: typeof body?.title === "string" && body.title.trim() ? body.title.trim() : "Remote session",
        directory: url.searchParams.get("directory") || DIRECTORY,
        external: false,
        time: { created: clock, updated: clock }
      }
      sessionCatalog.set(CREATED_SESSION_ID, created)
      sessionStatuses.set(CREATED_SESSION_ID, { type: "idle" })
      transcripts.set(CREATED_SESSION_ID, [])
      json(response, 200, created)
      return
    }

    const claimMatch = /^\/v1\/agents\/opencode\/session\/([^/]+)\/claim$/.exec(url.pathname)
    if (request.method === "POST" && claimMatch) {
      claimRequests += 1
      json(response, 409, { error: "OpenCode must not use ACP claim" })
      return
    }

    const promptMatch = /^\/v1\/agents\/opencode\/session\/([^/]+)\/prompt$/.exec(url.pathname)
    if (request.method === "POST" && promptMatch) {
      const sessionID = decodeURIComponent(promptMatch[1])
      const body = await requestJSON(request)
      promptHttpBodies.push({ sessionID, ...body })
      const requestId = body?.clientRequestId
      if (!requestId) {
        json(response, 400, { error: "missing clientRequestId" })
        return
      }
      const ledgerKey = `${sessionID}:${requestId}`
      if (!ledger.has(ledgerKey)) {
        nativePromptDispatches += 1
        ledger.set(ledgerKey, body)
        if (body.text === SUCCESS_PROMPT) appendPendingTurn(sessionID, body.text, requestId)
        else if (body.text === INTERRUPT_PROMPT || body.text === TERMINAL_INTERRUPT_PROMPT || body.text === LATE_RECOVERY_PROMPT) appendInterruptedTurn(sessionID, body.text, requestId)
        else appendTurn(sessionID, body.text, requestId)
      }
      if (body.text === SUCCESS_PROMPT) {
        // Accept while the native transcript contains the real assistant envelope but no content yet.
        // This is the OpenCode transition that used to replace the animated pending row with a
        // timestamp-only row and make preparation look finished.
        json(response, 200, { status: "accepted", clientRequestId: requestId })
        emitLiveEvent(sessionID)
        setTimeout(() => {
          finishPendingTurn(sessionID, body.text, requestId)
          emitLiveEvent(sessionID)
        }, 3_000)
        return
      }
      if (body.text === INTERRUPT_PROMPT) {
        sessionStatuses.set(sessionID, { type: "idle" })
        json(response, 200, { status: "accepted", clientRequestId: requestId })
        // Reproduce the field report: one completed OpenCode step with no final text, plus a very
        // short idle edge, while the provider/router automatically recovers the same user turn.
        emitLiveEvent(sessionID, "message.updated")
        emitLiveEvent(sessionID, "session.status")
        setTimeout(() => {
          sessionStatuses.set(sessionID, { type: "busy" })
          emitLiveEvent(sessionID, "session.status")
        }, 250)
        setTimeout(() => {
          finishInterruptedTurn(sessionID, body.text, requestId)
          sessionStatuses.set(sessionID, { type: "idle" })
          emitLiveEvent(sessionID, "message.updated")
          emitLiveEvent(sessionID, "session.status")
        }, 2_000)
        return
      }
      if (body.text === LATE_RECOVERY_PROMPT) {
        sessionStatuses.set(sessionID, { type: "idle" })
        json(response, 200, { status: "accepted", clientRequestId: requestId })
        emitLiveEvent(sessionID, "message.updated")
        emitLiveEvent(sessionID, "session.status")
        // Stay idle long enough for Harness Remote to confirm the interruption, then reproduce a
        // slower automatic provider retry. The busy edge must retract the banner before final text.
        setTimeout(() => {
          sessionStatuses.set(sessionID, { type: "busy" })
          emitLiveEvent(sessionID, "session.status")
          emitLiveEvent(sessionID, "message.updated")
        }, 1_600)
        setTimeout(() => {
          finishInterruptedTurn(sessionID, body.text, requestId)
          sessionStatuses.set(sessionID, { type: "idle" })
          emitLiveEvent(sessionID, "message.updated")
          emitLiveEvent(sessionID, "session.status")
        }, 3_200)
        return
      }
      if (body.text === TERMINAL_INTERRUPT_PROMPT) {
        sessionStatuses.set(sessionID, { type: "idle" })
        json(response, 200, { status: "accepted", clientRequestId: requestId })
        emitLiveEvent(sessionID, "message.updated")
        emitLiveEvent(sessionID, "session.status")
        // A second stable idle edge proves this one really stopped; unlike the transient case there
        // is no intervening busy edge and no recovered final assistant envelope.
        setTimeout(() => emitLiveEvent(sessionID, "session.status"), 1_100)
        return
      }
      json(response, 200, { status: "accepted", clientRequestId: requestId })
      return
    }

    const stopMatch = /^\/v1\/agents\/opencode\/session\/([^/]+)\/stop$/.exec(url.pathname)
    if (request.method === "POST" && stopMatch) {
      json(response, 200, { status: "accepted" })
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
      name: "OpenCode v3-first Test",
      config: { backend: "opencode", host: "127.0.0.1", port, username: "harness", password: "testpw" }
    }]))
  }, { key: STORAGE_KEY, port: DAEMON_PORT, machineID: MACHINE_ID })
}

async function waitFor(predicate, description, timeout = 12_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function openSession(page, title) {
  await page.locator('.hr-native-workspace[aria-label="Sessions"]').waitFor({ state: "visible" })
  await page.getByRole("button", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click()
  await page.locator(".hr-native-session-observer").waitFor({ state: "visible" })
  await page.locator(".tdw-work-thread-conversation").waitFor({ state: "visible" })
  await page.locator(".uw-composer-shell").waitFor({ state: "visible" })
  assert.equal(await page.getByRole("button", { name: "Continue this Session" }).count(), 0, "OpenCode Session open must not require a Continue unlock step")
}

async function waitForReady(page) {
  await page.locator(".tdw-conversation-state.ready").waitFor({ state: "attached", timeout: 12_000 })
  const composer = page.getByRole("textbox", { name: "Message OpenCode" })
  await composer.waitFor({ state: "visible", timeout: 12_000 })
  assert.equal(await composer.isDisabled(), false, "OpenCode composer must be enabled")
}

async function sendPrompt(page, text) {
  const composer = page.getByRole("textbox", { name: "Message OpenCode" })
  await composer.fill(text)
  const send = page.getByRole("button", { name: "Send" })
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (!(await send.isDisabled())) {
      await send.click()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for OpenCode Send after filling ${text}`)
}

async function chooseHighVariant(page) {
  await page.locator(".tdw-model-trigger").click()
  await page.getByRole("listbox", { name: "Models" }).waitFor({ state: "visible" })
  await page.getByRole("button", { name: "high", exact: true }).click()
}

async function assertExistingContract(browser, viewport, mobile) {
  resetFakeState()
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await seed(page)
  await page.goto(APP_ORIGIN, { waitUntil: "networkidle" })

  await openSession(page, "OpenCode v3-first regression session")
  assert.equal(claimRequests, 0, "OpenCode open must never use ACP writer claim")
  assert.ok(modelCatalogReads > 0, "OpenCode model catalog must load through the mature controller")
  assert.equal(await page.getByText("OPENCODE-HISTORY-USER-1", { exact: true }).count(), 1)
  assert.equal(await page.getByText("OPENCODE-HISTORY-ASSISTANT-1", { exact: true }).count(), 1)

  await chooseHighVariant(page)
  const httpBefore = promptHttpBodies.length
  const dispatchBefore = nativePromptDispatches
  await sendPrompt(page, SUCCESS_PROMPT)
  const preparingBubble = page.locator(".uw-message-pending")
  const preparing = preparingBubble.locator(".uw-message-working").filter({ hasText: "OpenCode is getting started" })
  // The common pending bubble must exist from the Send click itself, not only after a daemon event.
  await preparing.waitFor({ state: "visible", timeout: 2_000 })
  assert.equal(await preparing.locator(".bui-typing").count(), 1, "OpenCode must use the exact same animated typing dots as the other harnesses")

  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")))
  await waitFor(() => promptHttpBodies.length === httpBefore + 1, "OpenCode success HTTP attempt")
  // The daemon has now published the real assistant envelope with no content. That transport
  // envelope must stay behind the very same pending bubble until actual assistant activity arrives.
  await preparing.waitFor({ state: "visible", timeout: 2_000 })
  assert.equal(await preparing.locator(".bui-typing").count(), 1, "OpenCode pending dots must survive the empty native assistant envelope")
  assert.equal(await preparingBubble.locator("time").count(), 0, "the shared preparation bubble must not look like a completed response")
  assert.equal(await page.locator(".uw-message-agent:not(.uw-message-pending) .uw-message-working").filter({ hasText: "OpenCode is getting started" }).count(), 0, "an empty native OpenCode envelope must not replace the shared preparation bubble")
  assert.equal(await page.locator(".uw-message-working").filter({ hasText: "OpenCode is getting started" }).count(), 1, "OpenCode must expose exactly one preparation identity row")
  assert.equal(await preparingBubble.getByRole("status").count(), 1, "the shared OpenCode preparation row must retain status semantics")
  assert.equal(nativePromptDispatches, dispatchBefore + 1, "one OpenCode Send must dispatch one native prompt")
  assert.equal(claimRequests, 0, "OpenCode Send must never cross the ACP claim endpoint")
  assert.equal(promptHttpBodies[httpBefore].sessionID, SESSION_ID, "OpenCode Send must target the existing native Session id")
  assert.deepEqual(promptHttpBodies[httpBefore].model, { providerID: "openai", modelID: "gpt-5.6-codex" })
  assert.equal(promptHttpBodies[httpBefore].variant, "high")
  assert.equal(typeof promptHttpBodies[httpBefore].clientRequestId, "string")
  await page.getByText(SUCCESS_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  await preparingBubble.waitFor({ state: "detached", timeout: 10_000 })
  assert.equal(await page.getByText(SUCCESS_PROMPT, { exact: true }).count(), 1, "OpenCode prompt duplicated")
  assert.equal(await page.getByText(SUCCESS_REPLY, { exact: true }).count(), 1, "OpenCode reply duplicated")

  await waitForReady(page)
  const promptsBeforeReload = promptHttpBodies.length
  const dispatchesBeforeReload = nativePromptDispatches
  await page.reload({ waitUntil: "networkidle" })
  await openSession(page, "OpenCode v3-first regression session")
  assert.equal(promptHttpBodies.length, promptsBeforeReload, "OpenCode reload must never emit a prompt")
  assert.equal(nativePromptDispatches, dispatchesBeforeReload, "OpenCode reload must never dispatch work")
  assert.equal(claimRequests, 0, "OpenCode reload must never use ACP writer claim")
  assert.equal(await page.getByText(SUCCESS_PROMPT, { exact: true }).count(), 1, "OpenCode reload duplicated the prompt")
  assert.equal(await page.getByText(SUCCESS_REPLY, { exact: true }).count(), 1, "OpenCode reload duplicated the reply")

  await waitForReady(page)
  await sendPrompt(page, SECOND_PROMPT)
  await page.getByText(SECOND_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  assert.equal(promptHttpBodies.at(-1).sessionID, SESSION_ID, "second OpenCode Send must stay on the same native Session")
  assert.equal(promptHttpBodies.filter((body) => body.sessionID === SESSION_ID && body.text === SECOND_PROMPT).length, 1)
  assert.equal(await page.getByText(SECOND_PROMPT, { exact: true }).count(), 1)
  assert.equal(await page.getByText(SECOND_REPLY, { exact: true }).count(), 1)
  assert.equal(claimRequests, 0)

  await waitForReady(page)
  await sendPrompt(page, INTERRUPT_PROMPT)
  // The fake daemon has already journalled a completed tool step and briefly reported idle. The old
  // projection interpreted that as a terminal turn and painted the exact false red banner reported
  // against GLM via TokenRouter, even though the same OpenCode turn resumed automatically.
  await page.waitForTimeout(700)
  assert.equal(
    await page.getByText("Response interrupted", { exact: true }).count(),
    0,
    "a transient OpenCode step interruption must not become a terminal red banner"
  )
  assert.equal(
    await page.getByText("The coding agent stopped before producing a final answer.", { exact: true }).count(),
    0,
    "OpenCode automatic recovery must stay visually live"
  )
  await page.getByText(INTERRUPT_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  assert.equal(await page.getByText(INTERRUPT_PROMPT, { exact: true }).count(), 1)
  assert.equal(await page.getByText(INTERRUPT_REPLY, { exact: true }).count(), 1)
  assert.equal(await page.getByText("Response interrupted", { exact: true }).count(), 0)
  await waitForReady(page)

  // A slower provider retry can begin after the bounded idle confirmation. In that case the banner
  // may briefly be correct, but the busy edge must retract it while the agent is working again.
  await sendPrompt(page, LATE_RECOVERY_PROMPT)
  const lateBanner = page.getByText("Response interrupted", { exact: true })
  await lateBanner.waitFor({ state: "visible", timeout: 12_000 })
  await lateBanner.waitFor({ state: "detached", timeout: 12_000 })
  assert.equal(
    await page.getByText(LATE_RECOVERY_REPLY, { exact: true }).count(),
    0,
    "late-recovery interruption must be retracted on busy before final text exists"
  )
  await page.getByText(LATE_RECOVERY_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 12_000 })
  await waitForReady(page)

  // The suppression is not blanket error hiding: if OpenCode stays idle and never produces a final
  // reply, the same no-final transcript must eventually resolve to the real terminal interruption.
  await sendPrompt(page, TERMINAL_INTERRUPT_PROMPT)
  await page.getByText("Response interrupted", { exact: true }).waitFor({ state: "visible", timeout: 12_000 })
  assert.equal(
    await page.getByText("The coding agent stopped before producing a final answer.", { exact: true }).count(),
    1,
    "a stable terminal OpenCode interruption must remain visible"
  )

  assert.equal(await page.getByRole("button", { name: "Continue with another agent" }).count(), 0, "handoff UI must stay disabled")

  const composer = await page.locator(".uw-composer-shell").boundingBox()
  const size = page.viewportSize()
  assert.ok(composer && size)
  assert.ok(composer.y >= -1 && composer.y + composer.height <= size.height + 1, `OpenCode composer escaped viewport: ${JSON.stringify({ composer, size })}`)

  await context.close()
}

async function assertCreateContract(browser, viewport, mobile) {
  resetFakeState()
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await seed(page)
  await page.goto(APP_ORIGIN, { waitUntil: "networkidle" })

  await page.getByRole("button", { name: "New Session" }).click()
  const panel = page.getByRole("group", { name: "Create native Session" })
  await panel.waitFor({ state: "visible" })
  // Machine, Project, then Coding agent: New Session became machine-scoped, so the harness select
  // is the third combobox in the panel.
  await panel.getByLabel("Coding agent").selectOption("opencode")
  await panel.getByPlaceholder("New OpenCode Session").fill(CREATE_TITLE)
  await page.getByRole("button", { name: "Create Session" }).click()

  await page.getByRole("heading", { name: CREATE_TITLE }).waitFor({ state: "visible", timeout: 12_000 })
  await page.locator(".uw-composer-shell").waitFor({ state: "visible" })
  assert.equal(createCount, 1, "one OpenCode New Session action must create exactly one native Session")
  assert.equal(createBodies[0].directory, DIRECTORY, "OpenCode create must keep the selected Project directory")
  assert.equal(createBodies[0].body?.title, CREATE_TITLE, "OpenCode create must forward the title")
  assert.equal(createBodies[0].body?.model, undefined, "OpenCode create must preserve the harness native model default")
  assert.equal(claimRequests, 0, "OpenCode create must not use ACP claim")

  const dispatchBefore = nativePromptDispatches
  await sendPrompt(page, CREATE_PROMPT)
  await page.getByText(CREATE_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  assert.equal(nativePromptDispatches, dispatchBefore + 1, "created OpenCode first prompt must dispatch once")
  assert.equal(promptHttpBodies.filter((body) => body.sessionID === CREATED_SESSION_ID && body.text === CREATE_PROMPT).length, 1, "created OpenCode first prompt must target the returned native id")
  assert.equal(claimRequests, 0)

  await waitForReady(page)
  await page.reload({ waitUntil: "networkidle" })
  await openSession(page, CREATE_TITLE)
  assert.equal(await page.getByText(CREATE_PROMPT, { exact: true }).count(), 1, "created OpenCode prompt disappeared or duplicated after reload")
  assert.equal(await page.getByText(CREATE_REPLY, { exact: true }).count(), 1, "created OpenCode reply disappeared or duplicated after reload")
  assert.equal(claimRequests, 0)

  await sendPrompt(page, REOPEN_PROMPT)
  await page.getByText(REOPEN_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  assert.equal(promptHttpBodies.at(-1).sessionID, CREATED_SESSION_ID, "reopened OpenCode prompt must stay on the created native Session")
  assert.equal(promptHttpBodies.filter((body) => body.sessionID === CREATED_SESSION_ID && body.text === REOPEN_PROMPT).length, 1)
  assert.equal(await page.getByText(REOPEN_PROMPT, { exact: true }).count(), 1)
  assert.equal(await page.getByText(REOPEN_REPLY, { exact: true }).count(), 1)
  assert.equal(claimRequests, 0, "OpenCode must never acquire ACP writer ownership")

  await context.close()
}

let daemon
let preview
let browser
try {
  resetFakeState()
  daemon = await startFakeDaemon()
  preview = startPreview()
  await ready(APP_ORIGIN)
  browser = await chromium.launch({ headless: true })

  console.log("native OpenCode v3-first browser smoke: existing desktop")
  await assertExistingContract(browser, { width: 1366, height: 768 }, false)
  console.log("native OpenCode v3-first browser smoke: existing mobile")
  await assertExistingContract(browser, { width: 390, height: 844 }, true)
  console.log("native OpenCode v3-first browser smoke: create desktop")
  await assertCreateContract(browser, { width: 1366, height: 768 }, false)
  console.log("native OpenCode v3-first browser smoke: create mobile")
  await assertCreateContract(browser, { width: 390, height: 844 }, true)
  console.log("native OpenCode v3-first browser smoke: existing same-Session, create, reload, second Send and mobile passed")
} finally {
  if (browser) await browser.close().catch(() => {})
  for (const response of sseResponses || []) {
    try { response.end() } catch {}
  }
  stopPreview(preview)
  stopServer(daemon)
}
