import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const PREVIEW_PORT = 4181
const DAEMON_PORT = 4427
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const MACHINE_ID = "machine-opencode-permission-regression"
const SESSION_ID = "opencode-permission-regression-session"
const SESSION_TITLE = "OpenCode permission reliability"
const DIRECTORY = "/work/opencode-permission-regression"
const PERMISSION_ID = "per_regression_1"
const DENY_PROMPT = "OPENCODE-PERMISSION-DENY"
const ALLOW_PROMPT = "OPENCODE-PERMISSION-ALLOW"
const ALLOW_FINAL = "Permission accepted and the turn completed normally."

let transcript
let status
let pendingPermission
let permissionReplies
let promptBodies
let sseResponses
let clock
let activePrompt

function textPart(id, text) {
  return { id, type: "text", text }
}

function userMessage(id, text, created) {
  return {
    info: { id, role: "user", sessionID: SESSION_ID, time: { created } },
    parts: [textPart(`${id}-text`, text)]
  }
}

function assistantToolMessage(id, created) {
  return {
    info: { id, role: "assistant", sessionID: SESSION_ID, time: { created } },
    parts: [
      { id: `${id}-reasoning`, messageID: id, sessionID: SESSION_ID, type: "reasoning", text: "The requested operation needs approval." },
      {
        id: `${id}-tool`,
        messageID: id,
        sessionID: SESSION_ID,
        type: "tool",
        tool: "bash",
        callID: "call-permission-regression",
        state: {
          status: "running",
          input: { command: "cat /tmp/harness-remote-permission-test" },
          time: { start: created }
        }
      }
    ]
  }
}

function resetState() {
  transcript = [
    userMessage("history-user", "Earlier prompt", 1_000),
    {
      info: { id: "history-assistant", role: "assistant", sessionID: SESSION_ID, time: { created: 1_001, completed: 1_001 }, finish: "stop" },
      parts: [textPart("history-assistant-text", "Earlier reply")]
    }
  ]
  status = { type: "idle" }
  pendingPermission = null
  permissionReplies = []
  promptBodies = []
  sseResponses = new Set()
  clock = 10_000
  activePrompt = null
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Harness-Backend",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "600"
  }
}

function json(response, code, value, extra = {}) {
  response.writeHead(code, { "Content-Type": "application/json", ...corsHeaders(), ...extra })
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

function beginPermissionTurn(body) {
  const created = clock++
  const assistantID = `assistant-${created}`
  transcript.push(userMessage(`user-${created}`, body.text, created))
  transcript.push(assistantToolMessage(assistantID, created + 1))
  activePrompt = { text: body.text, assistantID }
  status = { type: "busy" }
  emit("message.part.updated", { sessionID: SESSION_ID, part: transcript.at(-1).parts[0] })
  emit("session.status", { sessionID: SESSION_ID, status })

  setTimeout(() => {
    if (!activePrompt || activePrompt.assistantID !== assistantID) return
    // Reproduce the dangerous edge: an approval request is visible while lifecycle enrichment is
    // terminal-looking. The request itself is authoritative evidence that the turn is waiting for
    // the user and must never manufacture a red terminal interruption before a decision exists.
    status = { type: "idle" }
    pendingPermission = {
      id: PERMISSION_ID,
      sessionID: SESSION_ID,
      permission: "external_directory",
      patterns: ["/tmp/*"],
      metadata: { reason: "Read a file outside the project" },
      always: ["/tmp/*"],
      tool: { messageID: assistantID, callID: "call-permission-regression" }
    }
    emit("permission.asked", pendingPermission)
  }, 180)
}

function resolvePermission(reply) {
  const current = pendingPermission
  assert.ok(current, "permission reply arrived without a pending request")
  pendingPermission = null
  emit("permission.replied", {
    sessionID: SESSION_ID,
    permissionID: current.id,
    response: reply
  })

  const assistant = transcript.find((message) => message.info.id === activePrompt?.assistantID)
  assert.ok(assistant, "active assistant envelope disappeared")
  const tool = assistant.parts.find((part) => part.type === "tool")
  assert.ok(tool, "active tool part disappeared")

  if (reply === "reject") {
    tool.state = {
      ...tool.state,
      status: "error",
      error: "The user rejected permission to use this specific tool call.",
      time: { ...tool.state.time, end: clock++ }
    }
    assistant.info.time.completed = clock++
    assistant.info.finish = "tool-calls"
    status = { type: "idle" }
    emit("message.part.updated", { sessionID: SESSION_ID, part: tool })
    // Deliberately no final message.updated. A denied tool may terminate the OpenCode turn here.
    return
  }

  status = { type: "busy" }
  emit("session.status", { sessionID: SESSION_ID, status })
  setTimeout(() => {
    tool.state = {
      ...tool.state,
      status: "completed",
      output: "allowed",
      title: "Allowed",
      time: { ...tool.state.time, end: clock++ }
    }
    assistant.parts.push(textPart(`${assistant.info.id}-final`, ALLOW_FINAL))
    assistant.info.time.completed = clock++
    assistant.info.finish = "stop"
    status = { type: "idle" }
    // Deliberately emit no message.updated after the final text. The bounded reconciliation after
    // permission.replied must recover the durable final while this Session remains mounted.
  }, 350)
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
        machine: { id: MACHINE_ID, name: "OpenCode permission regression", createdAt: new Date().toISOString() },
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
            questions: true,
            permissions: true
          },
          contract: { sessions: { stop: "native-abort" } }
        }]
      })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/projects") {
      json(response, 200, {
        projects: [{ id: "project-opencode-permission", machineId: MACHINE_ID, name: "opencode-permission-regression", path: DIRECTORY, kind: "git", configured: true }]
      })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/project-outcome") {
      json(response, 200, { projectId: "project-opencode-permission", outcome: null })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/session-links") {
      json(response, 200, { links: [] })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/opencode/experimental/session") {
      json(response, 200, [{
        id: SESSION_ID,
        title: SESSION_TITLE,
        directory: DIRECTORY,
        external: true,
        time: { created: 900, updated: clock }
      }])
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/opencode/session/status") {
      json(response, 200, { [SESSION_ID]: status })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/opencode/models") {
      json(response, 200, {
        models: [{ providerID: "openai", providerName: "OpenAI", modelID: "gpt-5.6-codex", modelName: "GPT-5.6 Codex", isDefault: true, tools: true }],
        stale: false,
        refreshedAt: new Date().toISOString(),
        source: "permission-regression"
      })
      return
    }

    const messageMatch = /^\/v1\/agents\/opencode\/session\/([^/]+)\/message$/.exec(url.pathname)
    if (request.method === "GET" && messageMatch) {
      json(response, 200, transcript, { "X-Has-More": "0" })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/opencode/permission") {
      json(response, 200, pendingPermission ? [pendingPermission] : [])
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/opencode/question") {
      json(response, 200, [])
      return
    }

    const permissionReply = /^\/v1\/agents\/opencode\/permission\/([^/]+)\/reply$/.exec(url.pathname)
    if (request.method === "POST" && permissionReply) {
      const body = await readJSON(request)
      permissionReplies.push({ id: decodeURIComponent(permissionReply[1]), body })
      json(response, 200, true)
      setTimeout(() => resolvePermission(body.reply), 20)
      return
    }

    const promptMatch = /^\/v1\/agents\/opencode\/session\/([^/]+)\/prompt$/.exec(url.pathname)
    if (request.method === "POST" && promptMatch) {
      const body = await readJSON(request)
      promptBodies.push(body)
      beginPermissionTurn(body)
      json(response, 200, { status: "accepted", clientRequestId: body.clientRequestId })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/opencode/global/event") {
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

    if (request.method === "GET" && url.pathname.endsWith("/command")) {
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
  const viteCLI = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url))
  return spawn(process.execPath, [viteCLI, "preview", "--host", "127.0.0.1", "--port", String(PREVIEW_PORT), "--strictPort"], {
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

async function seed(page) {
  await page.addInitScript(({ key, port, machineID }) => {
    localStorage.setItem(key, JSON.stringify([{
      id: machineID,
      name: "OpenCode permission regression",
      config: { backend: "opencode", host: "127.0.0.1", port, username: "harness", password: "testpw" }
    }]))
  }, { key: STORAGE_KEY, port: DAEMON_PORT, machineID: MACHINE_ID })
}

async function openSession(page) {
  await page.locator('.hr-native-workspace[aria-label="Sessions"], .hr-native-home[aria-label="Sessions"]').first().waitFor({ state: "visible" })
  await page.getByRole("button", { name: new RegExp(`Open ${SESSION_TITLE}`) }).click()
  await page.locator(".tdw-work-thread-conversation").waitFor({ state: "visible" })
  await page.getByRole("textbox", { name: "Message OpenCode" }).waitFor({ state: "visible" })
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && sseResponses.size === 0) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.ok(sseResponses.size > 0, "OpenCode event stream did not connect")
}

async function send(page, text) {
  await page.getByRole("textbox", { name: "Message OpenCode" }).fill(text)
  await page.getByRole("button", { name: "Send" }).click()
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && promptBodies.at(-1)?.text !== text) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(promptBodies.at(-1)?.text, text, "prompt did not reach the native OpenCode route")
}

async function waitForPermission(page) {
  await page.getByRole("button", { name: "Deny" }).waitFor({ state: "visible", timeout: 4_000 })
  await page.getByText("external_directory", { exact: true }).waitFor({ state: "visible", timeout: 4_000 })
}

async function assertPendingNeverTerminalizes(page, label) {
  // Wait beyond OpenCode's 750 ms terminal-looking debounce and the 900 ms lifecycle settle window.
  // A pending native permission is a waiting state, not a completed/interrupted turn.
  await page.waitForTimeout(1_300)
  assert.equal(
    await page.getByText("Response interrupted", { exact: true }).count(),
    0,
    `${label}: permission.asked must never manufacture a terminal interruption before a decision`
  )
  assert.equal(
    await page.getByText("The coding agent stopped before producing a final answer.", { exact: true }).count(),
    0,
    `${label}: pending authorization must remain non-terminal`
  )
}

async function assertAttentionSurvivesOpen(page) {
  const attentionTab = page.getByRole("button", { name: /Attention\s+1/ }).first()
  await attentionTab.waitFor({ state: "visible", timeout: 3_000 })
  await attentionTab.click()
  const row = page.getByRole("button", { name: new RegExp(`Open ${SESSION_TITLE}`) })
  await row.waitFor({ state: "visible", timeout: 3_000 })
  await row.click()
  await page.waitForTimeout(250)
  assert.equal(await page.getByRole("button", { name: /Attention\s+1/ }).count() > 0, true, "opening an unresolved Session must not consume Attention")
  assert.equal(await row.count(), 1, "unresolved Session disappeared from Attention after being opened")
}

async function waitForMountedTurnToStop(page, label) {
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    if (await page.locator(".tdw-conversation-state.working").count() === 0) return
    await page.waitForTimeout(50)
  }
  assert.equal(await page.locator(".tdw-conversation-state.working").count(), 0, `${label}: permission resolution left mounted Activity running`)
}

async function runScenario(browser, viewport, label) {
  resetState()
  const context = await browser.newContext({ viewport, hasTouch: viewport.width < 600, locale: "en-US" })
  const page = await context.newPage()
  await seed(page)
  await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" })
  await openSession(page)

  await send(page, DENY_PROMPT)
  await waitForPermission(page)
  await assertPendingNeverTerminalizes(page, `${label} deny`)
  await assertAttentionSurvivesOpen(page)

  await page.getByRole("button", { name: "Deny" }).click()
  const denyDeadline = Date.now() + 3_000
  while (Date.now() < denyDeadline && permissionReplies.length < 1) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(permissionReplies[0], { id: PERMISSION_ID, body: { reply: "reject" } }, `${label}: Deny must send the exact native reject reply`)
  await page.getByRole("button", { name: "Deny" }).waitFor({ state: "detached", timeout: 3_000 })
  await waitForMountedTurnToStop(page, `${label} deny`)

  // A reject may be presented as a terminal interruption or as a completed tool error depending on
  // the OpenCode version. Reliability is the invariant: it must settle in this mounted Session and
  // must not require navigation away/back. Do not lock the UI to one provider-version presentation.
  assert.equal(await page.getByRole("button", { name: "Deny" }).count(), 0, `${label}: resolved permission card remained visible`)

  // Return to All before the next Send; the important point is that the same Session stayed mounted
  // through the first resolution. No reload or navigation-away recovery has occurred.
  const allTab = page.getByRole("button", { name: /All\s+\d+/ }).first()
  if (await allTab.count()) await allTab.click()

  await send(page, ALLOW_PROMPT)
  await waitForPermission(page)
  await assertPendingNeverTerminalizes(page, `${label} allow`)
  await page.getByRole("button", { name: "Allow once" }).click()

  const allowDeadline = Date.now() + 3_000
  while (Date.now() < allowDeadline && permissionReplies.length < 2) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(permissionReplies[1], { id: PERMISSION_ID, body: { reply: "once" } }, `${label}: Allow once must preserve the native permission reply`)
  await page.getByText(ALLOW_FINAL, { exact: true }).waitFor({ state: "visible", timeout: 4_000 })
  await page.locator(".tdw-conversation-state.ready").waitFor({ state: "attached", timeout: 4_000 })
  assert.equal(await page.getByText("Response interrupted", { exact: true }).count(), 0, `${label}: recovered allowed turn must not retain a stale interruption`)
  assert.equal(promptBodies.filter((body) => body.text === DENY_PROMPT).length, 1, `${label}: deny flow duplicated the native prompt`)
  assert.equal(promptBodies.filter((body) => body.text === ALLOW_PROMPT).length, 1, `${label}: allow flow duplicated the native prompt`)

  await context.close()
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
try {
  resetState()
  daemon = await startDaemon()
  preview = startPreview()
  await ready(APP_ORIGIN)
  browser = await chromium.launch({ headless: true })
  await runScenario(browser, { width: 1366, height: 768 }, "desktop")
  await runScenario(browser, { width: 412, height: 915 }, "mobile")
  console.log("native OpenCode permission regression smoke: pending, Attention persistence, deny, allow and mounted convergence passed")
} finally {
  if (browser) await browser.close().catch(() => {})
  for (const response of sseResponses || []) {
    try { response.end() } catch {}
  }
  stopPreview(preview)
  stopServer(daemon)
}
