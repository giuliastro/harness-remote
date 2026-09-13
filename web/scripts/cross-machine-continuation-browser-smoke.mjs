import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const PREVIEW_PORT = 4186
const SOURCE_PORT = 4436
const TARGET_PORT = 4437
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const SOURCE_MACHINE = "machine-cross-source"
const TARGET_MACHINE = "machine-cross-target"
const SOURCE_PROJECT = "project-cross-source"
const MATCH_PROJECT = "project-cross-match"
const DIFFERENT_PROJECT = "project-cross-different"
const SOURCE_DIRECTORY = "/work/source-repo"
const SESSION_ID = "cross-machine-source-session"
const SESSION_TITLE = "Cross-machine Source Session"
const TRANSCRIPT_MARKER = "CROSS-MACHINE-SOURCE-TRANSCRIPT"
const REPOSITORY = "a".repeat(64)
const HISTORY = "b".repeat(64)
const OTHER_REPOSITORY = "c".repeat(64)

const sourceSession = {
  id: SESSION_ID,
  title: SESSION_TITLE,
  directory: SOURCE_DIRECTORY,
  external: true,
  time: { created: 1000, updated: 1001 }
}

const sourceTranscript = [{
  info: { id: "cross-source-user", role: "user", sessionID: SESSION_ID, time: { created: 1000 } },
  parts: [{ id: "cross-source-text", type: "text", text: TRANSCRIPT_MARKER }]
}]

const CODEX_MODELS = [{
  providerID: "codex",
  providerName: "Codex",
  modelID: "gpt-cross-source",
  modelName: "Codex Source",
  isDefault: true,
  tools: true
}]

const CLAUDE_MODELS = [{
  providerID: "anthropic",
  providerName: "Anthropic",
  modelID: "claude-cross-target",
  modelName: "Claude Target",
  isDefault: true,
  tools: true
}]

const streams = new Set()

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Harness-Backend",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600"
  }
}

function json(response, status, value, extra = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...corsHeaders(), ...extra })
  response.end(JSON.stringify(value))
}

function sse(request, response) {
  response.writeHead(200, {
    ...corsHeaders(),
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  })
  response.write(": connected\n\n")
  streams.add(response)
  request.on("close", () => streams.delete(response))
}

function projectIdentity(repositoryFingerprint) {
  return {
    identity: {
      version: 1,
      vcs: "git",
      repositoryFingerprint,
      historyFingerprint: HISTORY,
      branch: "main",
      head: "deadbeef",
      dirty: false
    }
  }
}

function startSourceDaemon() {
  const server = http.createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders())
      response.end()
      return
    }
    const url = new URL(request.url || "/", `http://127.0.0.1:${SOURCE_PORT}`)

    if (request.method === "GET" && url.pathname === "/v1/machine") {
      json(response, 200, {
        machine: { id: SOURCE_MACHINE, name: "Source Machine", createdAt: new Date().toISOString() },
        agents: [{
          id: "codex",
          label: "Codex",
          backend: "codex",
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
      json(response, 200, { projects: [{ id: SOURCE_PROJECT, machineId: SOURCE_MACHINE, name: "Source Project", path: SOURCE_DIRECTORY, kind: "git", configured: true }] })
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/project-identity") {
      assert.equal(url.searchParams.get("projectId"), SOURCE_PROJECT)
      json(response, 200, projectIdentity(REPOSITORY))
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/agents/codex/experimental/session") {
      json(response, 200, [sourceSession])
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/agents/codex/session/status") {
      json(response, 200, { [SESSION_ID]: { type: "idle" } })
      return
    }
    if (request.method === "GET" && url.pathname === `/v1/agents/codex/session/${SESSION_ID}/message`) {
      json(response, 200, sourceTranscript, { "X-Has-More": "0" })
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/agents/codex/models") {
      json(response, 200, { models: CODEX_MODELS, stale: false, source: "cross-machine-source" })
      return
    }
    if (request.method === "GET" && url.pathname.includes("/global/event")) {
      sse(request, response)
      return
    }
    if (request.method === "GET" && (url.pathname.includes("/question") || url.pathname.includes("/permission"))) {
      json(response, 200, [])
      return
    }
    json(response, 404, { error: `No source route for ${request.method} ${url.pathname}` })
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(SOURCE_PORT, "127.0.0.1", () => resolve(server))
  })
}

function startTargetDaemon() {
  const server = http.createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders())
      response.end()
      return
    }
    const url = new URL(request.url || "/", `http://127.0.0.1:${TARGET_PORT}`)

    if (request.method === "GET" && url.pathname === "/v1/machine") {
      json(response, 200, {
        machine: { id: TARGET_MACHINE, name: "Target Machine", createdAt: new Date().toISOString() },
        agents: [{
          id: "claude",
          label: "Claude",
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
        projects: [
          { id: MATCH_PROJECT, machineId: TARGET_MACHINE, name: "Matching Project", path: "/target/matching", kind: "git", configured: true },
          { id: DIFFERENT_PROJECT, machineId: TARGET_MACHINE, name: "Different Project", path: "/target/different", kind: "git", configured: true }
        ]
      })
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/project-identity") {
      const projectId = url.searchParams.get("projectId")
      if (projectId === MATCH_PROJECT) json(response, 200, projectIdentity(REPOSITORY))
      else if (projectId === DIFFERENT_PROJECT) json(response, 200, projectIdentity(OTHER_REPOSITORY))
      else json(response, 404, { error: "Unknown Project" })
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/agents/claude/experimental/session") {
      json(response, 200, [])
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/agents/claude/session/status") {
      json(response, 200, {})
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/agents/claude/models") {
      json(response, 200, { models: CLAUDE_MODELS, stale: false, source: "cross-machine-target" })
      return
    }
    if (request.method === "GET" && url.pathname.includes("/global/event")) {
      sse(request, response)
      return
    }
    if (request.method === "GET" && (url.pathname.includes("/question") || url.pathname.includes("/permission"))) {
      json(response, 200, [])
      return
    }
    json(response, 404, { error: `No target route for ${request.method} ${url.pathname}` })
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(TARGET_PORT, "127.0.0.1", () => resolve(server))
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

async function seed(page) {
  await page.addInitScript(({ key, sourcePort, targetPort }) => {
    localStorage.setItem(key, JSON.stringify([
      { id: "source-profile", name: "Source Machine", config: { backend: "codex", host: "127.0.0.1", port: sourcePort, username: "harness", password: "testpw" } },
      { id: "target-profile", name: "Target Machine", config: { backend: "claude", host: "127.0.0.1", port: targetPort, username: "harness", password: "testpw" } }
    ]))
  }, { key: STORAGE_KEY, sourcePort: SOURCE_PORT, targetPort: TARGET_PORT })
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

let sourceDaemon
let targetDaemon
let preview
let browser
try {
  sourceDaemon = await startSourceDaemon()
  targetDaemon = await startTargetDaemon()
  preview = startPreview()
  await ready(APP_ORIGIN)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const pageErrors = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await seed(page)
  await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" })

  await page.locator('.hr-native-workspace[aria-label="Sessions"]').waitFor({ state: "visible", timeout: 12_000 })
  await page.getByRole("button", { name: new RegExp(SESSION_TITLE) }).click()
  await page.getByRole("heading", { name: SESSION_TITLE }).waitFor({ state: "visible", timeout: 12_000 })
  await page.getByText(TRANSCRIPT_MARKER, { exact: true }).waitFor({ state: "visible", timeout: 12_000 })

  const sourceComposer = page.getByRole("textbox", { name: "Message Codex" })
  await sourceComposer.waitFor({ state: "visible", timeout: 12_000 })
  assert.equal(await sourceComposer.isDisabled(), false, "ordinary source composer was destabilized by cross-machine UI")

  const toggle = page.getByRole("button", { name: "Continue on another machine" })
  await toggle.waitFor({ state: "visible", timeout: 12_000 })
  await toggle.click()

  const panel = page.locator('.hr-cross-machine-panel')
  const machineSelect = panel.locator('select').first()
  await machineSelect.waitFor({ state: "visible", timeout: 12_000 })
  assert.equal(await machineSelect.inputValue(), TARGET_MACHINE, "cross-machine panel did not select the available target machine")
  assert.equal((await machineSelect.locator('option:checked').textContent())?.trim(), "Target Machine", "selected target machine label is incorrect")
  const projectSelect = panel.locator('label').filter({ hasText: "Project" }).locator('select')
  await projectSelect.selectOption(MATCH_PROJECT)

  await panel.getByText("Same repository, branch and HEAD verified; both worktrees are clean.", { exact: true }).waitFor({ state: "visible", timeout: 12_000 })
  await panel.getByText("Attachments and source permissions are not transferred.", { exact: true }).waitFor({ state: "visible", timeout: 12_000 })

  const modelButton = panel.locator('.tdw-model-trigger')
  await modelButton.waitFor({ state: "visible", timeout: 12_000 })
  await modelButton.click()
  assert.match(await panel.locator('.tdw-model-picker').innerText(), /Claude Target/, "target route did not load the target harness model catalog")
  await page.keyboard.press("Escape")

  const firstMessage = panel.getByRole("textbox", { name: "First message on the target Session" })
  await firstMessage.fill("Continue the fix on the target machine")
  const continueButton = panel.getByRole("button", { name: "Continue on target machine" })
  assert.equal(await continueButton.isDisabled(), false, "verified matching workspace did not become sendable")

  await projectSelect.selectOption(DIFFERENT_PROJECT)
  await panel.getByText("This Project does not match the source repository/history. Cross-machine continuation is blocked.", { exact: true }).waitFor({ state: "visible", timeout: 12_000 })
  assert.equal(await continueButton.isDisabled(), true, "mismatched Project left the cross-machine mutation enabled")
  assert.equal(await sourceComposer.isDisabled(), false, "blocked cross-machine plan disabled the ordinary source composer")
  assert.deepEqual(pageErrors, [], `browser errors in cross-machine planning surface: ${pageErrors.join(" | ")}`)

  console.log("cross-machine continuation Project/model safety browser smoke passed")
  await context.close()
} finally {
  if (browser) await browser.close().catch(() => {})
  for (const response of streams) {
    try { response.end() } catch {}
  }
  stopPreview(preview)
  stopServer(sourceDaemon)
  stopServer(targetDaemon)
}
