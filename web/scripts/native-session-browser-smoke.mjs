import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const PREVIEW_PORT = 4175
const DAEMON_PORT = 4421
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const SESSION_ID = "native-pi-v3-first-1"
const CREATED_SESSION_ID = "native-pi-created-1"
const DIRECTORY = "/work/native-pi-v3-first"
const SUCCESS_PROMPT = "PI-SUCCESS-PROMPT"
const SUCCESS_REPLY = "PI-SINGLE-FINAL-REPLY"
const ERROR_PROMPT = "PI-ERROR-PROMPT"
const RECOVERY_PROMPT = "PI-RECOVERY-PROMPT"
const RECOVERY_REPLY = "PI-RECOVERY-REPLY"
const LOST_PROMPT = "PI-LOST-HTTP-PROMPT"
const LOST_REPLY = "PI-LOST-HTTP-REPLY"
const DROPPED_RESPONSE_PROMPT = "PI-DROPPED-HTTP-RESPONSE-PROMPT"
const DROPPED_RESPONSE_REPLY = "PI-DROPPED-HTTP-RESPONSE-REPLY"
const CREATE_TITLE = "PI created from Harness Remote"
const CREATE_PROMPT = "PI-CREATED-FIRST-PROMPT"
const CREATE_REPLY = "PI-CREATED-FIRST-REPLY"
const REOPEN_PROMPT = "PI-CREATED-REOPEN-PROMPT"
const REOPEN_REPLY = "PI-CREATED-REOPEN-REPLY"

function textPart(id, text) {
  return { id, type: "text", text }
}

function message(sessionID, id, role, parts, created, error) {
  return {
    info: { id, role, sessionID, time: { created }, ...(error ? { error } : {}) },
    parts
  }
}

function initialTranscript() {
  return [
    message(SESSION_ID, "pi-history-user-1", "user", [textPart("pi-history-user-text-1", "PI-HISTORY-USER-1")], 1_000),
    message(SESSION_ID, "pi-history-assistant-1", "assistant", [textPart("pi-history-assistant-text-1", "PI-HISTORY-ASSISTANT-1")], 1_001),
    message(SESSION_ID, "pi-history-user-2", "user", [textPart("pi-history-user-text-2", "PI-HISTORY-USER-2")], 1_002),
    message(SESSION_ID, "pi-history-assistant-2", "assistant", [textPart("pi-history-assistant-text-2", "PI-HISTORY-ASSISTANT-2")], 1_003)
  ]
}

let sessionCatalog
let transcripts
let claimCount
let modelCatalogReads
let promptHttpBodies
let nativePromptDispatches
let uncertainDelivered
let machineProbeFailuresRemaining
let ledger
let clock
let sseResponses
let liveEventTypes
let createCount
let blockNextSessionList
let releaseBlockedSessionList
let blockNextSessionDelete
let releaseBlockedSessionDelete

function resetFakeState() {
  sessionCatalog = new Map([[SESSION_ID, {
    id: SESSION_ID,
    title: "PI v3-first regression session",
    directory: DIRECTORY,
    external: true,
    time: { created: 1_000, updated: 1_003 }
  }]])
  transcripts = new Map([[SESSION_ID, initialTranscript()]])
  claimCount = 0
  modelCatalogReads = 0
  promptHttpBodies = []
  nativePromptDispatches = 0
  uncertainDelivered = false
  machineProbeFailuresRemaining = 0
  ledger = new Map()
  clock = 10_000
  sseResponses = new Set()
  liveEventTypes = []
  createCount = 0
  blockNextSessionList = false
  releaseBlockedSessionList = null
  blockNextSessionDelete = false
  releaseBlockedSessionDelete = null
}

function emitLiveEvent(type, sessionID = SESSION_ID) {
  liveEventTypes.push(`${sessionID}:${type}`)
  const frame = `data: ${JSON.stringify({ directory: DIRECTORY, payload: { type, properties: { info: { sessionID } } } })}\n\n`
  for (const response of [...sseResponses]) {
    try { response.write(frame) }
    catch { sseResponses.delete(response) }
  }
}

function transcript(sessionID) {
  const current = transcripts.get(sessionID)
  if (current) return current
  const created = []
  transcripts.set(sessionID, created)
  return created
}

function appendSuccessTurn(sessionID, prompt, requestId, reply) {
  const base = clock
  clock += 20
  transcript(sessionID).push(
    message(sessionID, `pi-user-${requestId}`, "user", [textPart(`pi-user-text-${requestId}`, prompt)], base),
    message(sessionID, `pi-assistant-reason-${requestId}`, "assistant", [{ id: `pi-reason-${requestId}`, type: "reasoning", text: "PI reasoning marker" }], base + 1),
    message(sessionID, `pi-assistant-note-${requestId}`, "assistant", [textPart(`pi-note-${requestId}`, "PI working note before tool")], base + 2),
    message(sessionID, `pi-assistant-tool-start-${requestId}`, "assistant", [{
      id: `pi-tool-start-${requestId}`,
      type: "tool",
      tool: "shell",
      callID: `pi-call-${requestId}`,
      state: { status: "running", title: "PI tool", input: { command: "printf pi" } }
    }], base + 3),
    message(sessionID, `pi-assistant-tool-finish-${requestId}`, "assistant", [{
      id: `pi-tool-finish-${requestId}`,
      type: "tool",
      tool: "shell",
      callID: `pi-call-${requestId}`,
      state: { status: "completed", title: "PI tool", input: { command: "printf pi" }, output: "PI tool completed" }
    }], base + 4),
    message(sessionID, `pi-assistant-final-${requestId}`, "assistant", [textPart(`pi-final-${requestId}`, reply)], base + 5)
  )
  const entry = sessionCatalog.get(sessionID)
  if (entry) entry.time.updated = base + 5
}

function appendErrorTurn(sessionID, prompt, requestId) {
  const base = clock
  clock += 20
  const liveUserID = `pi-live-error-user-${requestId}`
  const liveAssistantID = `pi-live-error-assistant-${requestId}`
  const messages = transcript(sessionID)
  messages.push(
    message(sessionID, liveUserID, "user", [textPart(`${liveUserID}-text`, prompt)], base),
    message(sessionID, liveAssistantID, "assistant", [], base + 1, {
      name: "PIError",
      message: "PI live synthetic failure",
      data: { message: "PI live synthetic failure" }
    })
  )
  const entry = sessionCatalog.get(sessionID)
  if (entry) entry.time.updated = base + 1

  // PI's ACP failure can be visible before JSONL flushes. Replace both transport ids and even the
  // provider sentence later, exactly like the real live->journal transition that used to require
  // navigating away and back before the mounted chat became correct.
  setTimeout(() => {
    const current = transcript(sessionID)
    const index = current.findIndex((item) => item.info.id === liveUserID)
    if (index < 0) return
    current.splice(index, 2,
      message(sessionID, `pi-error-user-${requestId}`, "user", [textPart(`pi-error-user-text-${requestId}`, prompt)], base),
      message(sessionID, `pi-error-assistant-${requestId}`, "assistant", [], base + 1, {
        name: "PIError",
        message: "PI synthetic failure",
        data: { message: "PI synthetic failure" }
      })
    )
  }, 900)
}

const MODEL_CATALOG = {
  models: [
    {
      providerID: "pi",
      providerName: "PI",
      modelID: "pi-coding",
      modelName: "PI Coding",
      description: "PI coding model",
      isDefault: true,
      tools: true,
      contextLimit: 200000,
      outputLimit: 64000
    },
    {
      providerID: "pi",
      providerName: "PI",
      modelID: "pi-coding",
      modelName: "PI Coding",
      description: "PI coding model high effort",
      variant: "high",
      tools: true,
      contextLimit: 200000,
      outputLimit: 64000
    }
  ],
  stale: false,
  refreshedAt: new Date().toISOString(),
  source: "native-pi-v3-first-smoke"
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Harness-Backend",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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
      if (machineProbeFailuresRemaining > 0) {
        machineProbeFailuresRemaining -= 1
        json(response, 500, { error: "synthetic mobile reconnect probe failure" })
        return
      }
      json(response, 200, {
        machine: { id: "machine-pi-v3-first", name: "PI v3-first Test", createdAt: new Date().toISOString() },
        agents: [{
          id: "pi",
          label: "PI",
          backend: "pi",
          transport: "acp",
          managed: true,
          state: "available",
          capabilities: { sessions: true, prompt: true, abort: true, streaming: true, models: true, sessionDelete: true },
          contract: { sessions: { stop: "owned-session-native-cancel" } }
        }]
      })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/projects") {
      json(response, 200, {
        projects: [{ id: "project-pi-v3-first", machineId: "machine-pi-v3-first", name: "native-pi-v3-first", path: DIRECTORY, kind: "git", configured: true }]
      })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/pi/experimental/session") {
      if (blockNextSessionList) {
        blockNextSessionList = false
        await new Promise((resolve) => { releaseBlockedSessionList = resolve })
        releaseBlockedSessionList = null
      }
      json(response, 200, [...sessionCatalog.values()])
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/pi/session/status") {
      json(response, 200, Object.fromEntries([...sessionCatalog.keys()].map((sessionID) => [sessionID, { type: "idle" }])))
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/pi/models") {
      modelCatalogReads += 1
      json(response, 200, MODEL_CATALOG)
      return
    }

    const messageMatch = /^\/v1\/agents\/pi\/session\/([^/]+)\/message$/.exec(url.pathname)
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

    if (request.method === "POST" && url.pathname === "/v1/agents/pi/session") {
      const body = await requestJSON(request)
      createCount += 1
      const created = {
        id: CREATED_SESSION_ID,
        title: typeof body?.title === "string" && body.title.trim() ? body.title.trim() : "Remote session",
        directory: url.searchParams.get("directory") || DIRECTORY,
        external: false,
        time: { created: clock, updated: clock }
      }
      sessionCatalog.set(CREATED_SESSION_ID, created)
      transcripts.set(CREATED_SESSION_ID, [])
      json(response, 200, created)
      return
    }

    const deleteMatch = /^\/v1\/agents\/pi\/session\/([^/]+)$/.exec(url.pathname)
    if (request.method === "DELETE" && deleteMatch) {
      const sessionID = decodeURIComponent(deleteMatch[1])
      if (blockNextSessionDelete) {
        blockNextSessionDelete = false
        await new Promise((resolve) => { releaseBlockedSessionDelete = resolve })
        releaseBlockedSessionDelete = null
      }
      sessionCatalog.delete(sessionID)
      transcripts.delete(sessionID)
      json(response, 200, true)
      return
    }

    const claimMatch = /^\/v1\/agents\/pi\/session\/([^/]+)\/claim$/.exec(url.pathname)
    if (request.method === "POST" && claimMatch) {
      claimCount += 1
      json(response, 200, { ok: true, sessionID: decodeURIComponent(claimMatch[1]) })
      return
    }

    const promptMatch = /^\/v1\/agents\/pi\/session\/([^/]+)\/prompt$/.exec(url.pathname)
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
        if (body.text === ERROR_PROMPT) appendErrorTurn(sessionID, body.text, requestId)
        else if (body.text === RECOVERY_PROMPT) appendSuccessTurn(sessionID, body.text, requestId, RECOVERY_REPLY)
        else if (body.text === LOST_PROMPT) appendSuccessTurn(sessionID, body.text, requestId, LOST_REPLY)
        else if (body.text === DROPPED_RESPONSE_PROMPT) appendSuccessTurn(sessionID, body.text, requestId, DROPPED_RESPONSE_REPLY)
        else if (body.text === CREATE_PROMPT) {
          // Codex can report the turn idle before its rollout tail is readable. Reproduce that exact
          // lifecycle on a freshly-created Session: accept immediately, emit no convenient SSE event,
          // and make the authoritative transcript appear later. The mounted chat must settle it by
          // itself instead of requiring navigation away and back.
          setTimeout(() => appendSuccessTurn(sessionID, body.text, requestId, CREATE_REPLY), 1_800)
        }
        else if (body.text === REOPEN_PROMPT) appendSuccessTurn(sessionID, body.text, requestId, REOPEN_REPLY)
        else appendSuccessTurn(sessionID, body.text, requestId, SUCCESS_REPLY)
      }

      if (body.text === SUCCESS_PROMPT) {
        emitLiveEvent("message.updated", sessionID)
        emitLiveEvent("session.updated", sessionID)
        await new Promise((resolve) => setTimeout(resolve, 650))
      }

      if (body.text === LOST_PROMPT && !uncertainDelivered) {
        uncertainDelivered = true
        json(response, 202, { status: "uncertain", clientRequestId: requestId })
        return
      }

      json(response, 200, { status: "accepted", clientRequestId: requestId })
      return
    }

    const stopMatch = /^\/v1\/agents\/pi\/session\/([^/]+)\/stop$/.exec(url.pathname)
    if (request.method === "POST" && stopMatch) {
      json(response, 200, { status: "accepted" })
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
  await page.addInitScript(({ key, port }) => {
    localStorage.setItem(key, JSON.stringify([{
      id: "machine-pi-v3-first",
      name: "PI v3-first Test",
      config: { backend: "opencode", host: "127.0.0.1", port, username: "harness", password: "testpw" }
    }]))
  }, { key: STORAGE_KEY, port: DAEMON_PORT })
}

async function waitFor(predicate, description, timeout = 12_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function waitForReady(page) {
  try {
    await page.locator(".tdw-conversation-state.ready").waitFor({ state: "attached", timeout: 12_000 })
    const composer = page.getByRole("textbox", { name: "Message PI" })
    await composer.waitFor({ state: "visible", timeout: 12_000 })
    assert.equal(await composer.isDisabled(), false, "v3 composer must be enabled when the Session is ready")
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      state: [...document.querySelectorAll(".tdw-conversation-state")].map((node) => ({
        className: node.className,
        text: node.textContent
      })),
      model: [...document.querySelectorAll(".tdw-model-control")].map((node) => ({
        text: node.textContent,
        trigger: node.querySelector("button")?.textContent,
        disabled: node.querySelector("button")?.hasAttribute("disabled")
      })),
      composer: [...document.querySelectorAll(".uw-composer-shell textarea")].map((node) => ({
        disabled: node.hasAttribute("disabled"),
        value: node.value
      })),
      assistantRows: [...document.querySelectorAll(".uw-message-agent")].slice(-4).map((node) => ({
        text: node.textContent,
        pending: node.classList.contains("uw-message-pending")
      }))
    }))
    console.error("waitForReady diagnostic:", JSON.stringify(diagnostic))
    throw error
  }
}

async function openSession(page, title) {
  await page.locator('.hr-native-workspace[aria-label="Sessions"]').waitFor({ state: "visible" })
  await page.getByRole("button", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click()
  await page.locator(".hr-native-session-observer").waitFor({ state: "visible" })
  await page.locator(".tdw-work-thread-conversation").waitFor({ state: "visible" })
  await page.locator(".uw-composer-shell").waitFor({ state: "visible" })
  assert.equal(await page.getByRole("button", { name: "Continue this Session" }).count(), 0, "Session open must never require a visible Continue unlock step")
}

async function sendPrompt(page, text) {
  const composer = page.getByRole("textbox", { name: "Message PI" })
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
  throw new Error(`Timed out waiting for v3 Send after filling ${text}`)
}

async function assertStartupTransitionContract(browser, viewport, mobile) {
  resetFakeState()
  blockNextSessionList = true
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await seed(page)
  await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" })

  const deadline = Date.now() + 12_000
  while (typeof releaseBlockedSessionList !== "function" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(typeof releaseBlockedSessionList, "function", "startup fixture never reached Session discovery")

  const startup = page.locator(".hr-native-workspace-empty.hr-native-startup.connecting")
  await startup.waitFor({ state: "visible", timeout: 12_000 })
  assert.match(await startup.innerText(), /Loading.*Session/i, "machine-connected startup must remain in Loading Sessions")
  assert.equal(await page.locator(".hr-native-workspace-empty.hr-native-startup.offline").count(), 0, "startup must not claim all machines are disconnected while Sessions are still loading")
  assert.equal(await page.locator(".hr-native-machine-group.offline").count(), 0, "an already-connected machine must not render offline during Session discovery")
  const newSession = page.getByRole("button", { name: "New Session" })
  await newSession.waitFor({ state: "visible", timeout: 12_000 })
  assert.equal(await newSession.isDisabled(), true, "New Session must remain disabled until Session discovery settles")

  releaseBlockedSessionList?.()
  await page.getByRole("button", { name: /PI v3-first regression session/ }).waitFor({ state: "visible", timeout: 12_000 })
  assert.equal(await newSession.isDisabled(), false, "New Session must enable only after real Session discovery completes")
  await context.close()
}

async function assertExistingSessionContract(browser, viewport, mobile) {
  resetFakeState()
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await seed(page)
  await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" })

  if (mobile) {
    await page.locator('.hr-mobile-nav button[aria-current="page"]').filter({ hasText: "Sessions" }).waitFor({ state: "visible" })
  }

  await openSession(page, "PI v3-first regression session")
  assert.equal(claimCount, 0, "opening and reading an external PI Session must not claim its writer")
  assert.ok(modelCatalogReads > 0, "the mature v3 controller must load the PI model catalog without claiming writer ownership")
  await waitFor(() => sseResponses.size > 0, "PI v3 live event connection")

  for (const marker of ["PI-HISTORY-USER-1", "PI-HISTORY-ASSISTANT-1", "PI-HISTORY-USER-2", "PI-HISTORY-ASSISTANT-2"]) {
    assert.equal(await page.getByText(marker, { exact: true }).count(), 1, `historical PI marker duplicated: ${marker}`)
  }
  const historyOrder = await page.locator(".uw-transcript").evaluate((element) => {
    const text = element.textContent || ""
    return ["PI-HISTORY-USER-1", "PI-HISTORY-ASSISTANT-1", "PI-HISTORY-USER-2", "PI-HISTORY-ASSISTANT-2"].map((value) => text.indexOf(value))
  })
  assert.ok(historyOrder.every((value) => value >= 0) && historyOrder.every((value, index) => index === 0 || historyOrder[index - 1] < value), `PI history order regressed: ${historyOrder.join(",")}`)

  await page.locator(".tdw-model-trigger").click()
  await page.getByRole("listbox", { name: "Models" }).waitFor({ state: "visible" })
  await page.getByRole("button", { name: "high", exact: true }).click()

  const httpBefore = promptHttpBodies.length
  const dispatchBefore = nativePromptDispatches
  await sendPrompt(page, SUCCESS_PROMPT)
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")))
  await waitFor(() => promptHttpBodies.length >= httpBefore + 1, "PI success HTTP attempt")
  await waitFor(() => liveEventTypes.includes(`${SESSION_ID}:message.updated`) && liveEventTypes.includes(`${SESSION_ID}:session.updated`), "PI live events during Send")
  assert.equal(claimCount, 1, "the first PI mutation must acquire writer ownership exactly once and without a separate button")
  assert.equal(promptHttpBodies.length, httpBefore + 1, "one PI Send click must create one prompt HTTP operation")
  assert.equal(nativePromptDispatches, dispatchBefore + 1, "one PI Send click must dispatch one native session/prompt even during live reconciliation")
  const firstBody = promptHttpBodies[httpBefore]
  assert.equal(firstBody.sessionID, SESSION_ID)
  assert.equal(firstBody.text, SUCCESS_PROMPT)
  assert.deepEqual(firstBody.model, { providerID: "pi", modelID: "pi-coding" })
  assert.equal(firstBody.variant, "high")
  assert.equal(typeof firstBody.clientRequestId, "string")

  await page.getByText(SUCCESS_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  assert.equal(await page.getByText(SUCCESS_PROMPT, { exact: true }).count(), 1, "PI success prompt duplicated")
  assert.equal(await page.getByText(SUCCESS_REPLY, { exact: true }).count(), 1, "PI final answer duplicated")

  const activity = page.locator(".hr-activity").last()
  await activity.locator(".hr-activity-toggle").click()
  await page.getByText("PI reasoning marker", { exact: true }).waitFor({ state: "visible" })
  assert.equal(await page.getByText("PI reasoning marker", { exact: true }).count(), 1, "PI reasoning duplicated")
  assert.equal(await activity.locator(".hr-act-tool").count(), 1, "PI tool updates with different message ids must converge by call identity")
  assert.equal(await page.getByText("PI working note before tool", { exact: true }).count(), 1, "PI working note duplicated")

  const orderedMarkers = [SUCCESS_PROMPT, "PI reasoning marker", "PI working note before tool", "printf pi", SUCCESS_REPLY]
  const ordered = await page.locator(".uw-transcript").evaluate((element, markers) => {
    const text = element.textContent || ""
    return markers.map((value) => text.indexOf(value))
  }, orderedMarkers)
  assert.ok(ordered.every((value) => value >= 0) && ordered.every((value, index) => index === 0 || ordered[index - 1] <= value), `PI activity order regressed: ${ordered.join(",")}`)

  await waitForReady(page)
  await sendPrompt(page, ERROR_PROMPT)
  await waitFor(() => nativePromptDispatches >= dispatchBefore + 2, "PI error native dispatch")
  assert.equal(claimCount, 1, "writer ownership must be reused while the Session stays open")
  assert.equal(nativePromptDispatches, dispatchBefore + 2, "PI error Send dispatched more than once")
  await page.getByText("PI synthetic failure", { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  await page.getByText("PI live synthetic failure", { exact: true }).waitFor({ state: "detached", timeout: 15_000 })
  assert.equal(await page.getByText(ERROR_PROMPT, { exact: true }).count(), 1, "PI error prompt duplicated across live/journal identity replacement")
  assert.equal(await page.getByText("PI synthetic failure", { exact: true }).count(), 1, "PI provider error duplicated")
  assert.equal(await page.getByText("PI live synthetic failure", { exact: true }).count(), 0, "PI live failure survived after the journal became authoritative")

  // Reproduce the user's second interaction in the same mounted PI Session. A successful model/turn
  // after the failed one must produce exactly one reply without first navigating away and back.
  await waitForReady(page)
  await sendPrompt(page, RECOVERY_PROMPT)
  await page.getByText(RECOVERY_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  assert.equal(await page.getByText(RECOVERY_PROMPT, { exact: true }).count(), 1, "PI recovery prompt duplicated after failed model turn")
  assert.equal(await page.getByText(RECOVERY_REPLY, { exact: true }).count(), 1, "PI second interaction produced duplicate replies")
  assert.equal(await page.getByText(ERROR_PROMPT, { exact: true }).count(), 1, "PI failed turn duplicated after recovery")
  assert.equal(await page.getByText("PI synthetic failure", { exact: true }).count(), 1, "PI persisted failure duplicated after recovery")

  await waitForReady(page)
  const lostHttpBefore = promptHttpBodies.length
  const lostDispatchBefore = nativePromptDispatches
  await sendPrompt(page, LOST_PROMPT)
  await waitFor(() => promptHttpBodies.length >= lostHttpBefore + 1, "PI uncertain-delivery HTTP attempt")
  assert.equal(promptHttpBodies.length, lostHttpBefore + 1, "first uncertain-delivery Send must create one HTTP attempt")
  assert.equal(nativePromptDispatches, lostDispatchBefore + 1, "uncertain delivery must correspond to exactly one native PI dispatch")
  await page.getByText(/Prompt delivery is uncertain/).waitFor({ state: "visible", timeout: 10_000 })
  assert.equal(await page.getByRole("textbox", { name: "Message PI" }).inputValue(), LOST_PROMPT, "uncertain prompt must be restored for explicit reconciliation")

  await sendPrompt(page, LOST_PROMPT)
  await waitFor(() => promptHttpBodies.length >= lostHttpBefore + 2, "PI reconciliation retry")
  assert.equal(promptHttpBodies.length, lostHttpBefore + 2, "explicit reconciliation must issue exactly one retry HTTP attempt")
  assert.equal(nativePromptDispatches, lostDispatchBefore + 1, "retry must not dispatch native PI work twice")
  assert.equal(promptHttpBodies[lostHttpBefore].clientRequestId, promptHttpBodies[lostHttpBefore + 1].clientRequestId, "retry must reuse the same durable request id")
  await page.getByText(LOST_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  assert.equal(await page.getByText(LOST_PROMPT, { exact: true }).count(), 1, "reconciliation duplicated the user prompt")
  assert.equal(await page.getByText(LOST_REPLY, { exact: true }).count(), 1, "reconciliation duplicated the assistant reply")

  await waitForReady(page)

  // A transport-level lost response is different from the explicit 202 uncertainty above. The
  // daemon has already executed and persisted the turn while the browser loses only the HTTP reply.
  // The native controller must reconcile that exact durable request against the transcript before
  // surfacing an error, so the UI never invents a machine disconnect for an already-accepted prompt.
  const droppedHttpBefore = promptHttpBodies.length
  const droppedDispatchBefore = nativePromptDispatches
  let droppedClientResponse = false
  const droppedRoute = "**/v1/agents/pi/session/*/prompt"
  await page.route(droppedRoute, async (route) => {
    const request = route.request()
    let body
    try { body = request.postDataJSON() } catch {}
    if (!droppedClientResponse && body?.text === DROPPED_RESPONSE_PROMPT) {
      // Forward the POST all the way to the fake daemon so its ledger/transcript are durable, then
      // discard only the response on the client side. This is deterministic unlike closing the
      // server socket, which Chromium may transparently replay at the HTTP transport layer.
      await route.fetch()
      droppedClientResponse = true
      await route.abort("connectionreset")
      return
    }
    await route.continue()
  })
  await sendPrompt(page, DROPPED_RESPONSE_PROMPT)
  await waitFor(() => promptHttpBodies.length >= droppedHttpBefore + 1, "PI dropped-response HTTP attempt")
  assert.equal(promptHttpBodies.length, droppedHttpBefore + 1, "lost HTTP response must start with exactly one prompt request")
  assert.equal(nativePromptDispatches, droppedDispatchBefore + 1, "lost HTTP response must still correspond to one native dispatch")
  await page.getByText(DROPPED_RESPONSE_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  await waitForReady(page)
  assert.equal(await page.getByText(/Cannot reach/).count(), 0, "transcript-proven delivery must not surface a false transport error")
  assert.equal(await page.getByText(/Reconnecting to machine/).count(), 0, "transcript-proven delivery must not force a false machine reconnect")
  assert.equal(promptHttpBodies.length, droppedHttpBefore + 1, "transcript reconciliation must never resend a prompt whose delivery is already proven")
  assert.equal(nativePromptDispatches, droppedDispatchBefore + 1, "transcript reconciliation must not duplicate native work")
  assert.equal(
    await page.locator(".uw-message-user").getByText(DROPPED_RESPONSE_PROMPT, { exact: true }).count(),
    1,
    "transcript recovery duplicated the dropped-response prompt bubble"
  )
  assert.equal(await page.getByText(DROPPED_RESPONSE_REPLY, { exact: true }).count(), 1, "transcript recovery duplicated the dropped-response reply")
  assert.equal(await page.getByRole("textbox", { name: "Message PI" }).inputValue(), "", "transcript-proven acceptance must leave the composer empty")
  assert.equal(droppedClientResponse, true, "the regression fixture must actually discard the accepted HTTP response")
  await page.unroute(droppedRoute)

  await waitForReady(page)
  const promptsBeforeReload = promptHttpBodies.length
  const dispatchesBeforeReload = nativePromptDispatches
  await page.reload({ waitUntil: "domcontentloaded" })
  await openSession(page, "PI v3-first regression session")
  assert.equal(claimCount, 1, "reopening a Session must stay read-only until another mutation is attempted")
  assert.equal(promptHttpBodies.length, promptsBeforeReload, "refresh must never emit a native PI prompt")
  assert.equal(nativePromptDispatches, dispatchesBeforeReload, "refresh must never dispatch native PI work")
  await page.getByText(LOST_REPLY, { exact: true }).waitFor({ state: "visible" })
  for (const marker of [SUCCESS_PROMPT, SUCCESS_REPLY, ERROR_PROMPT, RECOVERY_PROMPT, RECOVERY_REPLY, LOST_PROMPT, LOST_REPLY, DROPPED_RESPONSE_PROMPT, DROPPED_RESPONSE_REPLY]) {
    assert.equal(await page.getByText(marker, { exact: true }).count(), 1, `refresh duplicated transcript marker: ${marker}`)
  }
  assert.equal(await page.getByRole("button", { name: "Continue with another agent" }).count(), 0, "cross-agent handoff UI must stay disabled during single-Session parity work")

  const composer = await page.locator(".uw-composer-shell").boundingBox()
  const size = page.viewportSize()
  assert.ok(composer && size, "v3 composer geometry unavailable")
  assert.ok(composer.y >= -1 && composer.y + composer.height <= size.height + 1, `v3 composer escaped viewport: ${JSON.stringify({ composer, size })}`)

  await context.close()
}

async function assertMobileDeleteTransitionContract(browser) {
  resetFakeState()
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await seed(page)
  await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" })

  await openSession(page, "PI v3-first regression session")
  await page.getByRole("button", { name: "Delete Session" }).click()
  const dialog = page.getByRole("dialog", { name: "Delete Session" })
  await dialog.waitFor({ state: "visible", timeout: 10_000 })

  // Hold the DELETE itself first. The phone must already be back on the rail with a disabled spinner
  // row while the server operation is still in flight — not only after DELETE has completed.
  blockNextSessionDelete = true
  await dialog.getByRole("button", { name: "Delete Session", exact: true }).click()

  let deadline = Date.now() + 10_000
  while (typeof releaseBlockedSessionDelete !== "function" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(typeof releaseBlockedSessionDelete, "function", "delete fixture never reached the server DELETE")

  const deletingRow = page.locator(".hr-native-session-row.deleting")
  await deletingRow.waitFor({ state: "visible", timeout: 10_000 })
  assert.equal(await deletingRow.count(), 1, "exactly one Session row must own the deletion transition")
  assert.equal(await deletingRow.isDisabled(), true, "a deleting Session must not remain clickable")
  const deletingText = await deletingRow.innerText()
  assert.match(deletingText, /PI v3-first regression session/, "deletion transition must stay attached to the Session being deleted")
  assert.match(deletingText, /Deleting|Eliminazione/i, "deleting Session must explain its transition")
  assert.equal(await deletingRow.locator("svg").count() > 0, true, "deleting Session row must expose a loading indicator")
  assert.notEqual(await page.locator(".hr-refresh-button").getAttribute("aria-busy"), "true", "Session DELETE must not start the global machine refresh spinner")

  // Now let DELETE succeed but hold only the Session-list refresh. The same tombstone bridges that
  // short stale-index window, then disappears as soon as discovery proves the Session is gone.
  blockNextSessionList = true
  releaseBlockedSessionDelete?.()
  deadline = Date.now() + 10_000
  while (typeof releaseBlockedSessionList !== "function" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(typeof releaseBlockedSessionList, "function", "delete fixture never reached the post-delete Session refresh")
  await deletingRow.waitFor({ state: "visible", timeout: 10_000 })
  assert.notEqual(await page.locator(".hr-refresh-button").getAttribute("aria-busy"), "true", "post-delete Session refresh must stay local to the rail")

  releaseBlockedSessionList?.()
  await deletingRow.waitFor({ state: "detached", timeout: 10_000 })
  await context.close()
}

async function assertCreateSessionContract(browser, viewport, mobile) {
  resetFakeState()
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await seed(page)
  await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" })

  await page.getByRole("button", { name: "New Session" }).click()
  await page.getByRole("group", { name: "Create native Session" }).waitFor({ state: "visible" })
  await page.getByPlaceholder("New PI Session").fill(CREATE_TITLE)
  await page.getByRole("button", { name: "Create Session" }).click()

  await page.getByRole("heading", { name: CREATE_TITLE }).waitFor({ state: "visible", timeout: 12_000 })
  await page.locator(".uw-composer-shell").waitFor({ state: "visible" })
  assert.equal(createCount, 1, "one New Session action must create exactly one native PI Session")
  assert.equal(claimCount, 0, "a newly created PI Session is already owned and must not be claimed again")

  const dispatchBefore = nativePromptDispatches
  const liveEventsBeforeFirstPrompt = liveEventTypes.length
  await sendPrompt(page, CREATE_PROMPT)
  await page.getByText(CREATE_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  assert.equal(liveEventTypes.length, liveEventsBeforeFirstPrompt, "fresh Session reply settlement must not depend on receiving a final SSE event")
  assert.equal(claimCount, 0, "the first prompt of a freshly created PI Session must reuse creation ownership")
  assert.equal(nativePromptDispatches, dispatchBefore + 1, "created PI Session first prompt must dispatch exactly once")
  assert.equal(promptHttpBodies.filter((body) => body.sessionID === CREATED_SESSION_ID && body.text === CREATE_PROMPT).length, 1, "created PI Session prompt must target the returned native id exactly once")

  await waitForReady(page)
  await page.reload({ waitUntil: "domcontentloaded" })
  await openSession(page, CREATE_TITLE)
  assert.equal(claimCount, 0, "reopening the created Session must not claim merely to show its transcript")
  assert.equal(await page.getByText(CREATE_PROMPT, { exact: true }).count(), 1, "created Session prompt disappeared or duplicated after reopen")
  assert.equal(await page.getByText(CREATE_REPLY, { exact: true }).count(), 1, "created Session reply disappeared or duplicated after reopen")

  await sendPrompt(page, REOPEN_PROMPT)
  await page.getByText(REOPEN_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  assert.equal(claimCount, 1, "first mutation after discovery-only reopen must reacquire ACP writer transparently")
  assert.equal(await page.getByText(REOPEN_PROMPT, { exact: true }).count(), 1, "reopened Session prompt duplicated")
  assert.equal(await page.getByText(REOPEN_REPLY, { exact: true }).count(), 1, "reopened Session reply duplicated")

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

  console.log("native PI v3-first browser smoke: startup transition desktop")
  await assertStartupTransitionContract(browser, { width: 1366, height: 768 }, false)
  console.log("native PI v3-first browser smoke: startup transition mobile")
  await assertStartupTransitionContract(browser, { width: 390, height: 844 }, true)
  console.log("native PI v3-first browser smoke: existing desktop")
  await assertExistingSessionContract(browser, { width: 1366, height: 768 }, false)
  console.log("native PI v3-first browser smoke: existing mobile")
  await assertExistingSessionContract(browser, { width: 390, height: 844 }, true)
  console.log("native PI v3-first browser smoke: mobile delete transition")
  await assertMobileDeleteTransitionContract(browser)
  console.log("native PI v3-first browser smoke: create desktop")
  await assertCreateSessionContract(browser, { width: 1366, height: 768 }, false)
  console.log("native PI v3-first browser smoke: create mobile")
  await assertCreateSessionContract(browser, { width: 390, height: 844 }, true)
  console.log("native PI v3-first browser smoke: startup loading transition, mobile delete tombstone, open-without-unlock, lazy claim, delayed first-reply settlement, ordered activity, error recovery, uncertain and dropped-response reconciliation, refresh and mobile passed")
} finally {
  if (browser) await browser.close().catch(() => {})
  for (const response of sseResponses || []) {
    try { response.end() } catch {}
  }
  stopPreview(preview)
  stopServer(daemon)
}
