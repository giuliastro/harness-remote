import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const PREVIEW_PORT = 4193
const DAEMON_PORT = 4443
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const MACHINE_ID = "machine-opencode-multiturn-stress"
const DIRECTORY = "/work/opencode-multiturn-stress"
const SESSION_A = "opencode-multiturn-a"
const SESSION_B = "opencode-multiturn-b"
const TITLE_A = "OpenCode Multi-turn A"
const TITLE_B = "OpenCode Multi-turn B"

const turns = [
  { prompt: "STRESS-TURN-1-NORMAL", reply: "STRESS-REPLY-1", mode: "normal" },
  { prompt: "STRESS-TURN-2-RETRY", reply: "STRESS-REPLY-2", mode: "retry", detail: "Temporary route exhaustion on turn 2" },
  { prompt: "STRESS-TURN-3-NORMAL", reply: "STRESS-REPLY-3", mode: "normal" },
  { prompt: "STRESS-TURN-4-ERROR-RECOVER", reply: "STRESS-REPLY-4", mode: "error-recover", detail: "Provider channel failed on turn 4" },
  { prompt: "STRESS-TURN-5-RETRY-NAVIGATE", reply: "STRESS-REPLY-5", mode: "retry-navigate", detail: "Retry while Session A is in background" },
  { prompt: "STRESS-TURN-6-NORMAL", reply: "STRESS-REPLY-6", mode: "normal" }
]

let sessions
let statuses
let transcripts
let promptBodies
let sseResponses
let clock

function resetState() {
  clock = 50_000
  promptBodies = []
  sseResponses = new Set()
  statuses = new Map([
    [SESSION_A, { type: "idle" }],
    [SESSION_B, { type: "idle" }]
  ])
  transcripts = new Map([
    [SESSION_A, []],
    [SESSION_B, []]
  ])
  sessions = new Map([
    [SESSION_A, { id: SESSION_A, title: TITLE_A, directory: DIRECTORY, time: { created: 2_000, updated: 4_000 } }],
    [SESSION_B, { id: SESSION_B, title: TITLE_B, directory: DIRECTORY, time: { created: 1_000, updated: 3_000 } }]
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

function json(response, status, value, extra = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...corsHeaders(), ...extra })
  response.end(JSON.stringify(value))
}

async function readJSON(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString("utf8")
  return raw ? JSON.parse(raw) : {}
}

function emit(type, properties) {
  const frame = `data: ${JSON.stringify({ directory: DIRECTORY, payload: { type, properties } })}\n\n`
  for (const response of [...sseResponses]) {
    try { response.write(frame) } catch { sseResponses.delete(response) }
  }
}

function touchSession(sessionID, updated) {
  const session = sessions.get(sessionID)
  if (session) session.time.updated = updated
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
  touchSession(sessionID, created)
}

function appendAssistant(sessionID, text) {
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
    parts: [{ id: `assistant-${created}-text`, type: "text", text }]
  })
  transcripts.set(sessionID, list)
  touchSession(sessionID, created)
}

function setStatus(sessionID, status, emitEvent = true) {
  statuses.set(sessionID, status)
  if (emitEvent) emit("session.status", { sessionID, status })
}

function finish(sessionID, reply) {
  appendAssistant(sessionID, reply)
  emit("message.updated", { info: { sessionID } })
  setStatus(sessionID, { type: "idle" })
}

function scheduleTurn(sessionID, spec) {
  if (spec.mode === "normal") {
    setTimeout(() => finish(sessionID, spec.reply), 180)
    return
  }

  if (spec.mode === "retry" || spec.mode === "retry-navigate") {
    setTimeout(() => setStatus(sessionID, {
      type: "retry",
      attempt: 2,
      message: spec.detail,
      next: Date.now() + 1_000
    }), 70)
    setTimeout(() => setStatus(sessionID, { type: "busy" }), 230)
    setTimeout(() => finish(sessionID, spec.reply), spec.mode === "retry-navigate" ? 650 : 420)
    return
  }

  if (spec.mode === "error-recover") {
    setTimeout(() => {
      emit("session.error", {
        sessionID,
        error: { name: "ApiError", data: { message: spec.detail } }
      })
      // OpenCode can expose idle beside a terminal-looking error. The lifecycle error must remain
      // visible until real resumed work or durable completion proves recovery.
      setStatus(sessionID, { type: "idle" })
    }, 70)
    setTimeout(() => setStatus(sessionID, { type: "busy" }), 260)
    setTimeout(() => finish(sessionID, spec.reply), 520)
  }
}

function startDaemon() {
  const server = http.createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders())
      response.end()
      return
    }

    const url = new URL(request.url || "/", `http://127.0.0.1:${DAEMON_PORT}`)

    if (request.method === "GET" && url.pathname === "/v1/machine") {
      json(response, 200, {
        machine: { id: MACHINE_ID, name: "OpenCode multi-turn stress", createdAt: new Date().toISOString() },
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
        projects: [{ id: "project-opencode-multiturn", machineId: MACHINE_ID, name: "opencode-multiturn", path: DIRECTORY, kind: "git", configured: true }]
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
        models: [{ providerID: "openai", providerName: "OpenAI", modelID: "gpt-5.6-codex", modelName: "GPT-5.6 Codex", isDefault: true, tools: true }],
        stale: false,
        refreshedAt: new Date().toISOString(),
        source: "multiturn-stress"
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
      const limit = Number(url.searchParams.get("limit")) || all.length
      json(response, 200, all.slice(Math.max(0, all.length - limit)), { "X-Has-More": "0" })
      return
    }

    const promptMatch = /^\/v1\/agents\/opencode\/session\/([^/]+)\/prompt$/.exec(url.pathname)
    if (request.method === "POST" && promptMatch) {
      const sessionID = decodeURIComponent(promptMatch[1])
      const body = await readJSON(request)
      promptBodies.push(body)
      appendUser(sessionID, body.text || "")
      setStatus(sessionID, { type: "busy" })
      json(response, 200, { status: "accepted", clientRequestId: body.clientRequestId })
      const spec = turns.find((candidate) => candidate.prompt === body.text)
      assert.ok(spec, `unexpected stress prompt: ${body.text}`)
      scheduleTurn(sessionID, spec)
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
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Preview did not become ready: ${url}`)
}

async function seed(page) {
  await page.addInitScript(({ key, port, machineID }) => {
    localStorage.setItem(key, JSON.stringify([{
      id: machineID,
      name: "OpenCode multi-turn stress",
      config: { backend: "opencode", host: "127.0.0.1", port, username: "harness", password: "testpw" }
    }]))
  }, { key: STORAGE_KEY, port: DAEMON_PORT, machineID: MACHINE_ID })
}

async function waitForRowState(button, state, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await button.evaluate((element, expected) => element.classList.contains(expected), state)) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`Session row did not become ${state}; class=${await button.getAttribute("class")}`)
}

async function waitForDispatchCount(count, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline && promptBodies.length < count) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(promptBodies.length, count, `turn ${count}: prompt must dispatch exactly once without a pre-Send stall`)
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
  try { server?.closeAllConnections?.() } catch {}
  try { server?.close() } catch {}
}

let daemon
let preview
let browser
let context
try {
  resetState()
  daemon = await startDaemon()
  preview = startPreview()
  await ready(APP_ORIGIN)
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1366, height: 768 } })
  const page = await context.newPage()
  await seed(page)
  await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" })

  await page.locator('.hr-native-workspace[aria-label="Sessions"]').waitFor({ state: "visible" })
  const aButton = page.getByRole("button", { name: new RegExp(`Open ${TITLE_A}`) })
  const bButton = page.getByRole("button", { name: new RegExp(`Open ${TITLE_B}`) })
  await aButton.waitFor({ state: "visible", timeout: 5_000 })
  await bButton.waitFor({ state: "visible", timeout: 5_000 })
  await aButton.click()
  await page.getByRole("textbox", { name: "Message OpenCode" }).waitFor({ state: "visible" })

  const streamDeadline = Date.now() + 5_000
  while (Date.now() < streamDeadline && sseResponses.size === 0) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.ok(sseResponses.size > 0, "OpenCode event stream did not connect")

  for (let index = 0; index < turns.length; index += 1) {
    const spec = turns[index]
    const composer = page.getByRole("textbox", { name: "Message OpenCode" })
    await composer.fill(spec.prompt)
    await page.getByRole("button", { name: "Send" }).click()
    await waitForDispatchCount(index + 1)
    await waitForRowState(aButton, "working")

    if (spec.mode === "retry" || spec.mode === "retry-navigate") {
      const notice = page.locator(".tdw-connection-notice")
      await notice.getByText(spec.detail, { exact: false }).waitFor({ state: "visible", timeout: 2_000 })
      assert.match(await notice.textContent(), /OpenCode is retrying/i)
    }

    if (spec.mode === "error-recover") {
      await waitForRowState(aButton, "attention", 2_500)
      await page.getByText(spec.detail, { exact: false }).first().waitFor({ state: "visible", timeout: 2_500 })
    }

    if (spec.mode === "retry-navigate") {
      await bButton.click()
      assert.equal(await bButton.getAttribute("aria-current"), "page")
      await waitForRowState(aButton, "ready", 5_000)
      assert.equal(await aButton.getAttribute("aria-current"), null, "background completion must settle A without reopening it")
      await aButton.click()
      assert.equal(await aButton.getAttribute("aria-current"), "page")
    }

    await page.getByText(spec.reply, { exact: true }).waitFor({ state: "visible", timeout: 5_000 })
    await waitForRowState(aButton, "ready", 5_000)
    await page.getByRole("textbox", { name: "Message OpenCode" }).waitFor({ state: "visible", timeout: 5_000 })
    assert.equal(await page.getByText(spec.reply, { exact: true }).count(), 1, `turn ${index + 1}: assistant reply duplicated`)
    assert.equal(await page.locator(".tdw-connection-notice").count(), 0, `turn ${index + 1}: retry notice leaked after settlement`)
    if (spec.detail) {
      assert.equal(await page.getByText(spec.detail, { exact: false }).count(), 0, `turn ${index + 1}: lifecycle detail leaked into the next stable frame`)
    }

    // Mid-run remount after a clean success: accumulated transcript and Ready state must survive.
    if (index === 2) {
      await bButton.click()
      await aButton.click()
      // The row click mounts the controller synchronously, but persisted transcript hydration is an
      // asynchronous read. Wait for the newest already-durable reply before checking the entire
      // accumulated history; otherwise the test races a legitimate empty first render after remount.
      await page.getByText(turns[index].reply, { exact: true }).waitFor({ state: "visible", timeout: 5_000 })
      for (let prior = 0; prior <= index; prior += 1) {
        assert.equal(await page.getByText(turns[prior].reply, { exact: true }).count(), 1, `turn ${prior + 1}: reply lost or duplicated after remount`)
      }
      await waitForRowState(aButton, "ready")
      await page.getByRole("textbox", { name: "Message OpenCode" }).waitFor({ state: "visible", timeout: 5_000 })
    }
  }

  assert.equal(promptBodies.length, turns.length, "stress run must keep one native dispatch per user turn")
  for (const spec of turns) {
    assert.equal(promptBodies.filter((body) => body.text === spec.prompt).length, 1, `${spec.prompt}: duplicate native dispatch`)
    assert.equal(await page.getByText(spec.reply, { exact: true }).count(), 1, `${spec.reply}: final transcript must contain one copy`)
  }
  assert.equal(await page.getByText(/Provider channel failed|Temporary route exhaustion|Retry while Session A is in background/, { exact: false }).count(), 0, "no prior retry/error detail may survive the six-turn run")

  console.log("native OpenCode multi-turn stress smoke: six sequential turns, retries, recovery, remount and background settlement passed")
} finally {
  if (context) await context.close().catch(() => {})
  if (browser) await browser.close().catch(() => {})
  for (const response of sseResponses || []) {
    try { response.end() } catch {}
  }
  stopPreview(preview)
  stopServer(daemon)
}