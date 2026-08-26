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

function emitLiveEvent(sessionID) {
  const frame = `data: ${JSON.stringify({ directory: DIRECTORY, payload: { type: "message.updated", properties: { info: { sessionID } } } })}\n\n`
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
      json(response, 200, Object.fromEntries([...sessionCatalog.keys()].map((sessionID) => [sessionID, { type: "idle" }])))
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
        appendTurn(sessionID, body.text, requestId)
      }
      if (body.text === SUCCESS_PROMPT) {
        emitLiveEvent(sessionID)
        await new Promise((resolve) => setTimeout(resolve, 500))
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
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")))
  await waitFor(() => promptHttpBodies.length === httpBefore + 1, "OpenCode success HTTP attempt")
  assert.equal(nativePromptDispatches, dispatchBefore + 1, "one OpenCode Send must dispatch one native prompt")
  assert.equal(claimRequests, 0, "OpenCode Send must never cross the ACP claim endpoint")
  assert.equal(promptHttpBodies[httpBefore].sessionID, SESSION_ID, "OpenCode Send must target the existing native Session id")
  assert.deepEqual(promptHttpBodies[httpBefore].model, { providerID: "openai", modelID: "gpt-5.6-codex" })
  assert.equal(promptHttpBodies[httpBefore].variant, "high")
  assert.equal(typeof promptHttpBodies[httpBefore].clientRequestId, "string")
  await page.getByText(SUCCESS_REPLY, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
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
