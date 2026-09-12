import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const PREVIEW_PORT = 4187
const DAEMON_PORT = 4438
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const MACHINE_ID = "machine-outcome-smoke"
const PROJECT_ID = "project-outcome-smoke"
const SESSION_ID = "session-outcome-smoke"
const DIRECTORY = "/work/outcome-smoke"
const PROMPT = "OUTCOME-REFRESH-PROMPT"
const REPLY = "OUTCOME-REFRESH-REPLY"

let status = { type: "idle" }
let outcomeVersion = 1
let outcomeReads = 0
let permissions = []
const sseResponses = new Set()
const messages = [
  {
    info: { id: "history-user", role: "user", sessionID: SESSION_ID, time: { created: 1_000 } },
    parts: [{ id: "history-user-text", type: "text", text: "OUTCOME-HISTORY-USER" }]
  },
  {
    info: { id: "history-assistant", role: "assistant", sessionID: SESSION_ID, time: { created: 1_001, completed: 1_001 } },
    parts: [{ id: "history-assistant-text", type: "text", text: "OUTCOME-HISTORY-REPLY" }]
  }
]

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Harness-Backend",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600"
  }
}

function json(response, statusCode, value, headers = {}) {
  response.writeHead(statusCode, { "Content-Type": "application/json", ...corsHeaders(), ...headers })
  response.end(JSON.stringify(value))
}

async function requestJSON(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString("utf8")
  return raw ? JSON.parse(raw) : null
}

function emit(type) {
  const frame = `data: ${JSON.stringify({ directory: DIRECTORY, payload: { type, properties: { info: { sessionID: SESSION_ID } } } })}\n\n`
  for (const response of [...sseResponses]) {
    try { response.write(frame) } catch { sseResponses.delete(response) }
  }
}

function outcome() {
  const files = outcomeVersion === 1
    ? [{ path: "src/before.ts", indexStatus: " ", worktreeStatus: "M" }]
    : [
        { path: "src/before.ts", indexStatus: " ", worktreeStatus: "M" },
        { path: "src/after.ts", indexStatus: "?", worktreeStatus: "?" }
      ]
  return {
    projectId: PROJECT_ID,
    outcome: {
      version: 1,
      vcs: "git",
      branch: "feature/outcome-review",
      head: "abcdef0123456789abcdef0123456789abcdef01",
      dirty: true,
      files,
      totalChangedFiles: files.length,
      filesTruncated: false
    }
  }
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
        machine: { id: MACHINE_ID, name: "Outcome Smoke", createdAt: new Date().toISOString() },
        agents: [{
          id: "pi",
          label: "PI",
          backend: "pi",
          transport: "acp",
          managed: true,
          state: "available",
          capabilities: { sessions: true, prompt: true, abort: true, streaming: true, models: true, permissions: true, questions: true },
          contract: { sessions: { stop: "owned-session-native-cancel" } }
        }]
      })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/projects") {
      json(response, 200, {
        projects: [{ id: PROJECT_ID, machineId: MACHINE_ID, name: "outcome-project", path: DIRECTORY, kind: "git", configured: true }]
      })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/project-outcome") {
      assert.equal(url.searchParams.get("projectId"), PROJECT_ID)
      outcomeReads += 1
      json(response, 200, outcome())
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/pi/experimental/session") {
      json(response, 200, [{
        id: SESSION_ID,
        title: "Outcome refresh Session",
        directory: DIRECTORY,
        external: true,
        time: { created: 1_000, updated: 1_001 }
      }])
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/pi/session/status") {
      json(response, 200, { [SESSION_ID]: status })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/pi/models") {
      json(response, 200, {
        models: [{
          providerID: "pi",
          providerName: "PI",
          modelID: "pi-coding",
          modelName: "PI Coding",
          isDefault: true,
          tools: true,
          contextLimit: 200000,
          outputLimit: 64000
        }],
        stale: false,
        refreshedAt: new Date().toISOString(),
        source: "outcome-smoke"
      })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/agents/pi/v1/capabilities") {
      json(response, 200, { sessions: true, prompt: true, abort: true, streaming: true, models: true, attachments: false, commands: false, permissions: true, questions: true })
      return
    }

    if (request.method === "GET" && url.pathname === `/v1/agents/pi/session/${SESSION_ID}/message`) {
      json(response, 200, messages, { "X-Has-More": "0" })
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

    if (request.method === "POST" && url.pathname === `/v1/agents/pi/session/${SESSION_ID}/claim`) {
      json(response, 200, { ok: true, sessionID: SESSION_ID })
      return
    }

    if (request.method === "POST" && url.pathname === `/v1/agents/pi/session/${SESSION_ID}/prompt`) {
      const body = await requestJSON(request)
      assert.equal(body?.text, PROMPT)
      assert.equal(typeof body?.clientRequestId, "string")
      status = { type: "busy" }
      const requestId = body.clientRequestId
      messages.push({
        info: { id: `user-${requestId}`, role: "user", sessionID: SESSION_ID, time: { created: 2_000 } },
        parts: [{ id: `user-text-${requestId}`, type: "text", text: PROMPT }]
      })
      json(response, 200, { status: "accepted", clientRequestId: requestId })
      emit("session.updated")
      setTimeout(() => {
        messages.push({
          info: { id: `assistant-${requestId}`, role: "assistant", sessionID: SESSION_ID, time: { created: 2_001, completed: 2_001 } },
          parts: [{ id: `assistant-text-${requestId}`, type: "text", text: REPLY }]
        })
        outcomeVersion = 2
        permissions = [{
          id: "target-authorization-1",
          sessionID: SESSION_ID,
          permission: "bash",
          patterns: ["deploy staging"],
          metadata: { scope: "target-machine" },
          always: []
        }]
        status = { type: "idle" }
        emit("message.updated")
        emit("session.updated")
      }, 250)
      return
    }

    if (request.method === "GET" && url.pathname.includes("/question")) {
      json(response, 200, [])
      return
    }

    if (request.method === "GET" && url.pathname.includes("/permission")) {
      json(response, 200, permissions)
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
    await new Promise((resolve) => setTimeout(resolve, 100))
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

const server = await startFakeDaemon()
const preview = startPreview()
let browser
try {
  await ready(APP_ORIGIN)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } })
  const page = await context.newPage()
  const pageErrors = []
  page.on("pageerror", (error) => pageErrors.push(error))
  await page.addInitScript(({ key, port }) => {
    localStorage.setItem(key, JSON.stringify([{
      id: "machine-outcome-smoke",
      name: "Outcome Smoke",
      config: { backend: "opencode", host: "127.0.0.1", port, username: "harness", password: "testpw" }
    }]))
  }, { key: STORAGE_KEY, port: DAEMON_PORT })

  await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: /Outcome refresh Session/ }).click()
  await page.locator(".hr-native-session-observer").waitFor({ state: "visible", timeout: 12_000 })

  const outcomePanel = page.getByRole("region", { name: "Session outcome" })
  await outcomePanel.waitFor({ state: "visible", timeout: 12_000 })
  await outcomePanel.getByText(/Completed · feature\/outcome-review · Dirty · 1 changed file/).waitFor({ state: "visible", timeout: 12_000 })
  assert.equal(outcomeReads, 1, "Session open should perform one Project outcome read")

  await outcomePanel.getByRole("button").click()
  await outcomePanel.getByText("src/before.ts", { exact: true }).waitFor({ state: "visible" })
  await outcomePanel.getByText(/no pending authorization or question/i).waitFor({ state: "visible" })

  const composer = page.getByRole("textbox", { name: "Message PI" })
  await composer.fill(PROMPT)
  const send = page.getByRole("button", { name: "Send" })
  await send.click()
  await page.getByText(REPLY, { exact: true }).waitFor({ state: "visible", timeout: 12_000 })
  await outcomePanel.getByText(/Needs authorization · feature\/outcome-review · Dirty · 2 changed files/).waitFor({ state: "visible", timeout: 12_000 })
  await outcomePanel.getByText("src/after.ts", { exact: true }).waitFor({ state: "visible" })
  await outcomePanel.getByText(/1 target-side authorization request is pending/i).waitFor({ state: "visible" })

  assert.ok(outcomeReads >= 2, "Project outcome must refresh after a completed native turn")
  assert.ok(outcomeReads <= 3, `Project outcome must not poll per token/event; reads=${outcomeReads}`)
  assert.deepEqual(pageErrors, [], `browser errors: ${pageErrors.map(String).join(" | ")}`)
  await context.close()
  console.log("native Session structured outcome browser smoke passed")
} finally {
  await browser?.close().catch(() => undefined)
  stopPreview(preview)
  stopServer(server)
}
