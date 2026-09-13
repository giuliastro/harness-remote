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
const TARGET_DIRECTORY = "/target/matching"
const SESSION_ID = "cross-machine-source-session"
const TARGET_SESSION_ID = "cross-machine-target-session"
const SESSION_TITLE = "Cross-machine Source Session"
const TRANSCRIPT_MARKER = "CROSS-MACHINE-SOURCE-TRANSCRIPT"
const SOURCE_PERMISSION_SENTINEL = "SOURCE-ONLY-PERMISSION-MUST-NOT-CROSS"
const FIRST_MESSAGE = "Continue the fix on the target machine"
const REPOSITORY = "a".repeat(64)
const HISTORY = "b".repeat(64)
const OTHER_REPOSITORY = "c".repeat(64)

const sourceSession = {
  id: SESSION_ID,
  title: SESSION_TITLE,
  directory: SOURCE_DIRECTORY,
  external: true,
  permission: [{ permission: "bash", pattern: SOURCE_PERMISSION_SENTINEL, action: "deny" }],
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
const sourceLinks = []
const targetLinks = []
const targetCreateRequests = []
const targetPromptRequests = []
const mutationOrder = []
let targetCreated = false

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

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString("utf8")
  return raw ? JSON.parse(raw) : {}
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

function targetSession() {
  return {
    id: TARGET_SESSION_ID,
    title: SESSION_TITLE,
    directory: TARGET_DIRECTORY,
    external: false,
    model: { providerID: "anthropic", id: "claude-cross-target" },
    time: { created: 2000, updated: 2001 }
  }
}

function startSourceDaemon() {
  const server = http.createServer(async (request, response) => {
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
    if (request.method === "GET" && url.pathname === "/v1/session-links") {
      json(response, 200, { links: sourceLinks })
      return
    }
    if (request.method === "POST" && url.pathname === "/v1/session-links") {
      const body = await readJson(request)
      assert.ok(body.link, "source lineage registration omitted its link")
      sourceLinks.push(body.link)
      mutationOrder.push("source-link")
      json(response, 200, { link: body.link })
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
  const server = http.createServer(async (request, response) => {
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
          { id: MATCH_PROJECT, machineId: TARGET_MACHINE, name: "Matching Project", path: TARGET_DIRECTORY, kind: "git", configured: true },
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
    if (request.method === "GET" && url.pathname === "/v1/session-links") {
      json(response, 200, { links: targetLinks })
      return
    }
    if (request.method === "POST" && url.pathname === "/v1/session-links") {
      const body = await readJson(request)
      assert.ok(body.link, "target lineage registration omitted its link")
      targetLinks.push(body.link)
      mutationOrder.push("target-link")
      json(response, 200, { link: body.link })
      return
    }
    if (request.method === "POST" && url.pathname === "/v1/session-handoff-target") {
      const body = await readJson(request)
      targetCreateRequests.push(body)
      mutationOrder.push("create-target")
      assert.equal(body.projectId, MATCH_PROJECT)
      assert.equal(body.targetAgentID, "claude")
      assert.deepEqual(body.source, {
        machineID: SOURCE_MACHINE,
        agentID: "codex",
        sessionID: SESSION_ID,
        directory: SOURCE_DIRECTORY
      })
      assert.equal(body.title, SESSION_TITLE)
      assert.deepEqual(body.model, { providerID: "anthropic", modelID: "claude-cross-target" })
      assert.equal(JSON.stringify(body).includes(SOURCE_PERMISSION_SENTINEL), false, "source permission crossed target-creation boundary")
      targetCreated = true
      json(response, 200, {
        status: "accepted",
        clientRequestId: body.clientRequestId,
        result: {
          target: {
            machineID: TARGET_MACHINE,
            agentID: "claude",
            sessionID: TARGET_SESSION_ID,
            directory: TARGET_DIRECTORY
          }
        }
      })
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/agents/claude/experimental/session") {
      json(response, 200, targetCreated ? [targetSession()] : [])
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/agents/claude/session/status") {
      json(response, 200, targetCreated ? { [TARGET_SESSION_ID]: { type: "idle" } } : {})
      return
    }
    if (request.method === "GET" && url.pathname === `/v1/agents/claude/session/${TARGET_SESSION_ID}/message`) {
      json(response, 200, [], { "X-Has-More": "0" })
      return
    }
    if (request.method === "POST" && url.pathname === `/v1/agents/claude/session/${TARGET_SESSION_ID}/prompt`) {
      const body = await readJson(request)
      targetPromptRequests.push(body)
      mutationOrder.push("first-prompt")
      json(response, 200, { status: "accepted", clientRequestId: body.clientRequestId })
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

async function waitForDisabledState(locator, disabled, label, timeout = 12_000) {
  const deadline = Date.now() + timeout
  let lastState
  while (Date.now() < deadline) {
    try {
      lastState = await locator.isDisabled()
      if (lastState === disabled) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${label}: expected disabled=${disabled}, observed disabled=${String(lastState)}`)
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

  const readySummary = panel.getByText("Same repository, branch and HEAD verified; both worktrees are clean.", { exact: true })
  await readySummary.waitFor({ state: "visible", timeout: 12_000 })
  await panel.getByText("Attachments and source permissions are not transferred.", { exact: true }).waitFor({ state: "visible", timeout: 12_000 })

  const modelButton = panel.locator('.tdw-model-trigger')
  await modelButton.waitFor({ state: "visible", timeout: 12_000 })
  await modelButton.click()
  assert.match(await panel.locator('.tdw-model-picker').innerText(), /Claude Target/, "target route did not load the target harness model catalog")
  await page.keyboard.press("Escape")
  assert.match(await modelButton.innerText(), /Claude Target/, "target default model was not selected after catalog discovery")

  const firstMessage = panel.getByRole("textbox", { name: "First message on the target Session" })
  await firstMessage.fill(FIRST_MESSAGE)
  assert.equal(await firstMessage.inputValue(), FIRST_MESSAGE, "target first-message input did not retain the requested text")
  assert.equal(await toggle.isDisabled(), false, "source Session became non-interactive while the verified cross-machine plan was open")
  assert.equal(await sourceComposer.isDisabled(), false, "source composer became non-interactive while the verified cross-machine plan was open")
  assert.equal(await machineSelect.inputValue(), TARGET_MACHINE, "target machine selection changed while preparing the first message")
  assert.equal(await projectSelect.inputValue(), MATCH_PROJECT, "target Project selection changed while preparing the first message")
  assert.equal(await projectSelect.isDisabled(), false, "target Project unexpectedly returned to a loading state")
  assert.equal(await modelButton.isDisabled(), false, "target model unexpectedly returned to a loading/unavailable state")
  assert.match(await modelButton.innerText(), /Claude Target/, "target model selection changed while preparing the first message")
  await readySummary.waitFor({ state: "visible", timeout: 12_000 })

  const continueButton = panel.getByRole("button", { name: "Continue on target machine" })
  await waitForDisabledState(continueButton, false, "verified matching workspace did not become sendable")

  await projectSelect.selectOption(DIFFERENT_PROJECT)
  await panel.getByText("This Project does not match the source repository/history. Cross-machine continuation is blocked.", { exact: true }).waitFor({ state: "visible", timeout: 12_000 })
  await waitForDisabledState(continueButton, true, "mismatched repository did not disable cross-machine continuation")
  assert.equal(await sourceComposer.isDisabled(), false, "blocked cross-machine plan disabled the ordinary source composer")
  assert.equal(targetCreateRequests.length, 0, "blocked Project continuity mutated the target machine")

  await projectSelect.selectOption(MATCH_PROJECT)
  await readySummary.waitFor({ state: "visible", timeout: 12_000 })
  await waitForDisabledState(continueButton, false, "matching Project did not recover after a blocked selection")
  await continueButton.click()

  const targetComposer = page.getByRole("textbox", { name: "Message Claude" })
  await targetComposer.waitFor({ state: "visible", timeout: 12_000 })
  await waitForDisabledState(targetComposer, false, "new target Session did not become writable after its live model catalog settled")
  await page.getByText("Handoff source", { exact: true }).waitFor({ state: "visible", timeout: 12_000 })

  assert.equal(targetCreateRequests.length, 1, "target Session creation was not exactly once")
  assert.equal(sourceLinks.length, 1, "source machine did not receive exactly one lineage edge")
  assert.equal(targetLinks.length, 1, "target machine did not receive exactly one lineage edge")
  assert.equal(targetPromptRequests.length, 1, "target first prompt was not exactly once")
  assert.deepEqual(mutationOrder, ["create-target", "source-link", "target-link", "first-prompt"], "cross-machine mutations occurred out of safety order")

  const createRequest = targetCreateRequests[0]
  assert.ok(createRequest.clientRequestId, "target creation omitted its durable request id")
  const sourceLink = sourceLinks[0]
  const targetLink = targetLinks[0]
  assert.deepEqual(targetLink, sourceLink, "source and target daemons did not receive the same lineage edge")
  assert.deepEqual(sourceLink.source, {
    machineID: SOURCE_MACHINE,
    agentID: "codex",
    sessionID: SESSION_ID,
    directory: SOURCE_DIRECTORY
  })
  assert.deepEqual(sourceLink.target, {
    machineID: TARGET_MACHINE,
    agentID: "claude",
    sessionID: TARGET_SESSION_ID,
    directory: TARGET_DIRECTORY
  })
  assert.match(sourceLink.transferredContext || "", new RegExp(TRANSCRIPT_MARKER), "bounded handoff context omitted the source transcript")
  assert.deepEqual(sourceLink.portableState?.controls, {
    sourceAuthority: "invalidated",
    targetAuthorization: "re_evaluate",
    attachments: "not_transferred"
  }, "portable handoff controls did not preserve the authority boundary")
  assert.equal(sourceLink.portableState?.project?.decision, "automatic", "exact workspace continuation was not recorded as automatic")
  assert.equal(sourceLink.portableState?.project?.reason, "exact_workspace", "exact workspace evidence was not retained")
  assert.equal(JSON.stringify(sourceLink).includes(SOURCE_PERMISSION_SENTINEL), false, "source permission leaked into portable lineage")

  const promptRequest = targetPromptRequests[0]
  assert.ok(promptRequest.clientRequestId, "target first prompt omitted its durable request id")
  assert.notEqual(promptRequest.clientRequestId, createRequest.clientRequestId, "target creation and first prompt reused one mutation identity")
  assert.equal(promptRequest.directory, TARGET_DIRECTORY)
  assert.deepEqual(promptRequest.model, { providerID: "anthropic", modelID: "claude-cross-target" })
  assert.deepEqual(promptRequest.attachments, [], "cross-machine first prompt transferred attachments")
  assert.match(promptRequest.text, /TRANSFERRED TASK CONTEXT/)
  assert.match(promptRequest.text, new RegExp(TRANSCRIPT_MARKER))
  assert.match(promptRequest.text, /USER INSTRUCTION/)
  assert.match(promptRequest.text, new RegExp(FIRST_MESSAGE))
  assert.equal(JSON.stringify(promptRequest).includes(SOURCE_PERMISSION_SENTINEL), false, "source permission leaked into target first prompt")
  assert.deepEqual(pageErrors, [], `browser errors in cross-machine execution surface: ${pageErrors.join(" | ")}`)

  console.log("cross-machine continuation planning, authority boundary, lineage and first-prompt browser smoke passed")
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
