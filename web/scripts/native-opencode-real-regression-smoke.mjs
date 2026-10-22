import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const PREVIEW_PORT = 4178
const DAEMON_PORT = 4424
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const MACHINE_ID = "machine-opencode-real-regressions"
const DIRECTORY = "/work/opencode-real-regressions"
const PRIMARY_ID = "opencode-primary-newer"
const OLDER_BUSY_ID = "opencode-older-busy"
const PRIMARY_TITLE = "Newer OpenCode Session"
const OLDER_TITLE = "Older Working OpenCode Session"
const PROMPT = "OPENCODE-STATUS-COMPLETION-PROMPT"
const REASONING = "OPENCODE-STATUS-COMPLETION-REASONING"
const FINAL = "OPENCODE-STATUS-COMPLETION-FINAL"
const SECOND_PROMPT = "OPENCODE-MODEL-RESTORE-SECOND"
const SECOND_REASONING = "OPENCODE-MODEL-RESTORE-SECOND-REASONING"
const SECOND_FINAL = "OPENCODE-MODEL-RESTORE-SECOND-FINAL"
const LAST_MODEL = { providerID: "anthropic", modelID: "claude-sonnet-4-6", variant: "high" }

let transcripts
let statuses
let sessions
let sseResponses
let promptBodies
let messageReads
let directoryScopedStatusRequests
let statusRequests
let clock

function userMessage(id, text, created, model = LAST_MODEL) {
  return {
    info: {
      id,
      role: "user",
      sessionID: PRIMARY_ID,
      time: { created },
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
        variant: model.variant
      }
    },
    parts: [{ id: `${id}-text`, type: "text", text }]
  }
}

function assistantMessage(id, text, created, model = LAST_MODEL) {
  return {
    info: {
      id,
      role: "assistant",
      sessionID: PRIMARY_ID,
      time: { created, completed: created },
      providerID: model.providerID,
      modelID: model.modelID
    },
    parts: [{ id: `${id}-text`, type: "text", text }]
  }
}

function resetState() {
  transcripts = new Map([
    [PRIMARY_ID, [
      userMessage("history-user", "HISTORY-USING-NONDEFAULT-MODEL", 4_900),
      assistantMessage("history-assistant", "HISTORY-NONDEFAULT-REPLY", 4_950)
    ]],
    [OLDER_BUSY_ID, []]
  ])
  // Deliberately omit PRIMARY_ID. Current OpenCode releases can omit a child-directory Session from
  // GET /session/status without a directory even while that same Session exists in global discovery.
  // Home therefore looks gray/Ready because status enrichment is absent, not because an explicit
  // idle status was observed. The mounted v3 projection must not depend on this map to finish.
  statuses = new Map([
    [OLDER_BUSY_ID, { type: "busy" }]
  ])
  sessions = new Map([
    [PRIMARY_ID, {
      id: PRIMARY_ID,
      title: PRIMARY_TITLE,
      directory: DIRECTORY,
      external: true,
      time: { created: 4_000, updated: 5_000 }
    }],
    [OLDER_BUSY_ID, {
      id: OLDER_BUSY_ID,
      title: OLDER_TITLE,
      directory: DIRECTORY,
      external: true,
      time: { created: 900, updated: 1_000 }
    }]
  ])
  sseResponses = new Set()
  promptBodies = []
  messageReads = []
  directoryScopedStatusRequests = 0
  statusRequests = 0
  clock = 10_000
}

const MODEL_CATALOG = {
  models: [
    {
      providerID: "openai",
      providerName: "OpenAI",
      modelID: "gpt-5.6-codex",
      modelName: "GPT-5.6 Codex",
      isDefault: true,
      tools: true
    },
    {
      providerID: LAST_MODEL.providerID,
      providerName: "Anthropic",
      modelID: LAST_MODEL.modelID,
      modelName: "Claude Sonnet 4.6",
      variant: LAST_MODEL.variant,
      tools: true
    }
  ],
  stale: false,
  refreshedAt: new Date().toISOString(),
  source: "opencode-real-regression-smoke"
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

function appendPrompt(sessionID, body) {
  const list = transcripts.get(sessionID) || []
  const created = clock++
  const model = {
    providerID: body.model?.providerID || LAST_MODEL.providerID,
    modelID: body.model?.modelID || LAST_MODEL.modelID,
    variant: body.variant || LAST_MODEL.variant
  }
  list.push({
    info: {
      id: `user-${created}`,
      role: "user",
      sessionID,
      time: { created },
      model
    },
    parts: [{ id: `user-${created}-text`, type: "text", text: body.text }]
  })
  transcripts.set(sessionID, list)
}

function appendReasoning(sessionID, text, model) {
  const list = transcripts.get(sessionID) || []
  const created = clock++
  const messageID = `assistant-${created}`
  const part = {
    id: `${messageID}-reasoning`,
    messageID,
    sessionID,
    type: "reasoning",
    text
  }
  list.push({
    info: {
      id: messageID,
      role: "assistant",
      sessionID,
      time: { created },
      providerID: model.providerID,
      modelID: model.modelID
    },
    parts: [part]
  })
  transcripts.set(sessionID, list)
  // Older real OpenCode event shapes carry the Session id only inside properties.part. This must
  // still target the mounted Session immediately; otherwise reasoning appears only on a later poll.
  emit("message.part.updated", { part })
  return messageID
}

function markIdle(sessionID) {
  const session = sessions.get(sessionID)
  if (session) session.time.updated = clock++
  // Important ordering: the lifecycle edge arrives first. The terminal assistant envelope is NOT
  // durable yet and there will be no later message.updated event to rescue an eager one-shot read.
  emit("session.status", { sessionID, status: { type: "idle" } })
}

function persistFinal(sessionID, assistantID, text, model) {
  const list = transcripts.get(sessionID) || []
  const assistant = list.find((message) => message.info.id === assistantID)
  assert.ok(assistant, `missing reasoning assistant ${assistantID}`)
  const completed = clock++
  assistant.info.time.completed = completed
  assistant.info.finish = "stop"
  assistant.parts.push({ id: `${assistantID}-text`, type: "text", text })
  assistant.info.providerID = model.providerID
  assistant.info.modelID = model.modelID
  const session = sessions.get(sessionID)
  if (session) session.time.updated = completed
  // Intentionally emit nothing. The mounted Session must settle by re-reading the native transcript.
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
        machine: { id: MACHINE_ID, name: "OpenCode regression machine", createdAt: new Date().toISOString() },
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
        projects: [{
          id: "project-opencode-real-regressions",
          machineId: MACHINE_ID,
          name: "opencode-real-regressions",
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
      statusRequests += 1
      if (url.searchParams.has("directory")) {
        directoryScopedStatusRequests += 1
        json(response, 504, { error: "directory-scoped OpenCode status is intentionally unavailable in this regression" })
        return
      }
      json(response, 200, Object.fromEntries(statuses))
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/opencode/models") {
      json(response, 200, MODEL_CATALOG)
      return
    }

    const messageMatch = /^\/v1\/agents\/opencode\/session\/([^/]+)\/message$/.exec(url.pathname)
    if (request.method === "GET" && messageMatch) {
      const sessionID = decodeURIComponent(messageMatch[1])
      const all = transcripts.get(sessionID) || []
      messageReads.push({
        sessionID,
        at: Date.now(),
        texts: all.flatMap((message) => message.parts || []).map((part) => part.text).filter(Boolean)
      })
      const requestedLimit = Number(url.searchParams.get("limit")) || all.length
      const data = all.slice(Math.max(0, all.length - requestedLimit))
      json(response, 200, data, { "X-Has-More": "0" })
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

    const promptMatch = /^\/v1\/agents\/opencode\/session\/([^/]+)\/prompt$/.exec(url.pathname)
    if (request.method === "POST" && promptMatch) {
      const sessionID = decodeURIComponent(promptMatch[1])
      const body = await requestJSON(request)
      promptBodies.push({ sessionID, receivedAt: Date.now(), ...body })

      const model = {
        providerID: body?.model?.providerID,
        modelID: body?.model?.modelID,
        variant: body?.variant
      }
      appendPrompt(sessionID, body)
      // Do not emit a convenient prompt-level message.updated. The nested part event below must be
      // sufficient to refresh the mounted tail, matching sparse/lossy real OpenCode event delivery.
      json(response, 200, { status: "accepted", clientRequestId: body?.clientRequestId })

      const final = body?.text === SECOND_PROMPT ? SECOND_FINAL : FINAL
      const reasoning = body?.text === SECOND_PROMPT ? SECOND_REASONING : REASONING
      let assistantID
      setTimeout(() => { assistantID = appendReasoning(sessionID, reasoning, model) }, 90)
      setTimeout(() => markIdle(sessionID), 600)
      setTimeout(() => persistFinal(sessionID, assistantID, final, model), 1_000)
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
    try {
      if ((await fetch(url)).ok) return
    } catch {}
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
      name: "OpenCode regression machine",
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

async function openPrimary(page) {
  await page.locator('.hr-native-workspace[aria-label="Sessions"]').waitFor({ state: "visible" })
  const primaryButton = page.getByRole("button", { name: new RegExp(`Open ${PRIMARY_TITLE}`) })
  const olderButton = page.getByRole("button", { name: new RegExp(`Open ${OLDER_TITLE}`) })
  await primaryButton.waitFor({ state: "visible", timeout: 5_000 })
  await olderButton.waitFor({ state: "visible", timeout: 5_000 })

  const titles = await page.locator(".hr-native-session-row .hr-native-session-copy strong").allTextContents()
  assert.deepEqual(
    titles.slice(0, 2),
    [PRIMARY_TITLE, OLDER_TITLE],
    "Session order must follow native recent activity, not Working status"
  )

  await primaryButton.click()
  await page.locator(".tdw-work-thread-conversation").waitFor({ state: "visible" })
  await page.locator(".uw-composer-shell").waitFor({ state: "visible" })
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && sseResponses.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(sseResponses.size > 0, "OpenCode event stream did not connect")
  // Let the initial SSE-connected reconciliation settle before measuring the Send path.
  await new Promise((resolve) => setTimeout(resolve, 150))
}

async function send(page, text) {
  const composer = page.getByRole("textbox", { name: "Message OpenCode" })
  await composer.fill(text)
  const button = page.getByRole("button", { name: "Send" })
  await button.click()
}

async function assertCompletionAndModel(page, text, reasoning, final, label) {
  const before = promptBodies.length
  const statusBefore = statusRequests
  const sendStartedAt = Date.now()
  await send(page, text)

  const promptDeadline = Date.now() + 1_500
  while (Date.now() < promptDeadline && promptBodies.length === before) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(promptBodies.length, before + 1, `${label}: Send must reach OpenCode without a legacy status wait`)
  const body = promptBodies.at(-1)
  assert.ok(body.receivedAt - sendStartedAt < 1_500, `${label}: prompt delivery was artificially delayed before OpenCode started`)
  assert.equal(statusRequests, statusBefore, `${label}: pre-Send reconciliation must not call OpenCode /session/status`)
  assert.equal(body.sessionID, PRIMARY_ID, `${label}: continuation must keep the same native Session id`)
  assert.deepEqual(body.model, {
    providerID: LAST_MODEL.providerID,
    modelID: LAST_MODEL.modelID
  }, `${label}: reopened OpenCode Session must keep the last native model`)
  assert.equal(body.variant, LAST_MODEL.variant, `${label}: reopened OpenCode Session must keep the last native variant`)

  // The only partial-assistant lifecycle signal is message.part.updated with sessionID nested in the
  // part. Prove the mounted tail consumes it before the later session.status fallback instead of
  // inferring renderer visibility from a reasoning block that mature v3 intentionally keeps collapsed.
  const reasoningDeadline = sendStartedAt + 500
  let reasoningRead
  while (Date.now() < reasoningDeadline && !reasoningRead) {
    reasoningRead = messageReads.find((read) => read.sessionID === PRIMARY_ID && read.at >= sendStartedAt && read.texts.includes(reasoning))
    if (!reasoningRead) await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(reasoningRead, `${label}: nested message.part.updated did not refresh the native transcript promptly`)
  assert.ok(reasoningRead.at - sendStartedAt < 500, `${label}: first reasoning tail refresh was artificially delayed`)

  // session.status idle happens before this answer is durable and no final message.updated follows.
  // The Session remains mounted throughout: the answer and Ready state must appear without navigation.
  await page.getByText(final, { exact: true }).waitFor({ state: "visible", timeout: 3_000 })
  await page.locator(".tdw-conversation-state.ready").waitFor({ state: "attached", timeout: 3_000 })
  assert.equal(await page.getByText(text, { exact: true }).count(), 1, `${label}: prompt rendered more than once`)
  assert.equal(await page.getByText(final, { exact: true }).count(), 1, `${label}: final response rendered more than once`)
  assert.equal(promptBodies.length, before + 1, `${label}: one user Send must dispatch exactly one native prompt`)

  // Reasoning text is intentionally collapsed by the mature renderer. Verify it exists in the same
  // activity group without changing the renderer's visibility semantics.
  const activity = page.locator(".hr-activity").last()
  await activity.locator(".hr-activity-toggle").click()
  await page.getByText(reasoning, { exact: true }).waitFor({ state: "visible", timeout: 1_000 })
}

async function runScenario(browser, viewport, label) {
  resetState()
  const context = await browser.newContext({ viewport, hasTouch: viewport.width < 600 })
  const page = await context.newPage()
  await seed(page)
  await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" })

  await openPrimary(page)
  await assertCompletionAndModel(page, PROMPT, REASONING, FINAL, `${label} first turn`)

  // Remount must still be correct, but it is no longer required to make the first final appear.
  await page.reload({ waitUntil: "domcontentloaded" })
  await openPrimary(page)
  await page.getByText(FINAL, { exact: true }).waitFor({ state: "visible", timeout: 2_000 })
  await page.locator(".tdw-conversation-state.ready").waitFor({ state: "attached", timeout: 2_000 })
  assert.equal(await page.getByText(PROMPT, { exact: true }).count(), 1, `${label}: reopen duplicated first prompt`)
  assert.equal(await page.getByText(FINAL, { exact: true }).count(), 1, `${label}: reopen duplicated first final`)

  await assertCompletionAndModel(page, SECOND_PROMPT, SECOND_REASONING, SECOND_FINAL, `${label} reopened turn`)

  assert.equal(directoryScopedStatusRequests, 0, `${label}: recovery must not fall back to an unbounded directory status wait`)
  await context.close()
}

let daemon
let preview
let browser
try {
  resetState()
  daemon = await startFakeDaemon()
  preview = startPreview()
  await ready(APP_ORIGIN)
  browser = await chromium.launch({ headless: true })

  await runScenario(browser, { width: 1366, height: 768 }, "desktop")
  await runScenario(browser, { width: 412, height: 915 }, "mobile")

  console.log("native OpenCode real-regression smoke: mounted completion lag, prompt latency, model restore, single-dispatch and desktop/mobile passed")
} finally {
  if (browser) await browser.close().catch(() => {})
  for (const response of sseResponses || []) {
    try { response.end() } catch {}
  }
  stopPreview(preview)
  stopServer(daemon)
}
