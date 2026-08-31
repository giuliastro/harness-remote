import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

/*
 * Browser regression for the Session-first model-change failure class in #287.
 *
 * The existing native-Session smokes each change model at most once, on one Session, on one harness,
 * so none of them could observe the reported behaviour: after changing model the Session wedged and
 * later Sessions stayed on "Loading Session into the v3 controller...", slowed down, or surfaced a
 * model error belonging to a different harness.
 *
 * This drives the exact reported sequence in a real browser against the production build:
 *
 *   A -> catalog -> model X -> model Y -> send -> B -> model Z -> send
 *     -> C on another harness -> its own catalog -> send -> back to A -> model X -> send
 *
 * with no reload and no daemon restart, and asserts what the failure would have broken: the picker
 * stays usable, each harness keeps its own catalog, every Send produces exactly one prompt carrying
 * the model that was actually selected, and event subscriptions do not accumulate per navigation.
 */

const PREVIEW_PORT = 4183
const DAEMON_PORT = 4429
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const DIRECTORY = "/work/model-switch"

const SESSION_A = "native-pi-switch-a"
const SESSION_B = "native-pi-switch-b"
const SESSION_C = "native-omp-switch-c"
const TITLE_A = "Switch Session A"
const TITLE_B = "Switch Session B"
const TITLE_C = "Switch Session C"

// Two harnesses with deliberately disjoint catalogs: any leak between them is visible by name.
const PI_MODELS = [
  { providerID: "pi", providerName: "PI", modelID: "pi-coding", modelName: "PI Coding", isDefault: true, tools: true },
  { providerID: "pi", providerName: "PI", modelID: "pi-reasoning", modelName: "PI Reasoning", tools: true },
  { providerID: "pi", providerName: "PI", modelID: "pi-reasoning", modelName: "PI Reasoning", variant: "high", variantName: "high", variantConfigId: "thinkingLevel", tools: true }
]
const OMP_MODELS = [
  { providerID: "omp", providerName: "Oh My Pi", modelID: "omp-fast", modelName: "OMP Fast", isDefault: true, tools: true },
  { providerID: "omp", providerName: "Oh My Pi", modelID: "omp-deep", modelName: "OMP Deep", tools: true }
]

const AGENTS = {
  pi: { label: "PI", models: PI_MODELS, sessions: [SESSION_A, SESSION_B] },
  omp: { label: "OMP", models: OMP_MODELS, sessions: [SESSION_C] }
}

const titles = new Map([[SESSION_A, TITLE_A], [SESSION_B, TITLE_B], [SESSION_C, TITLE_C]])
const markers = new Map([[SESSION_A, "SWITCH-A-HISTORY"], [SESSION_B, "SWITCH-B-HISTORY"], [SESSION_C, "SWITCH-C-HISTORY"]])
const transcripts = new Map()
for (const [sessionID, marker] of markers) {
  transcripts.set(sessionID, [{
    info: { id: `${sessionID}-user`, role: "user", sessionID, time: { created: 1000 } },
    parts: [{ id: `${sessionID}-text`, type: "text", text: marker }]
  }])
}

const modelReads = { pi: 0, omp: 0 }
const promptBodies = []
/* Set to refuse the next prompt for one Session, the way a harness rejects a stale native Session. */
let refuseNextPromptFor = null
const refusedPrompts = []
const claimCounts = { pi: 0, omp: 0 }
const handoffLinks = []
const handoffLedger = new Map()
const rejectedHandoffs = []
let rejectNextHandoff = false
let legacyNextLinkList = false
let rejectNextLinkPersistence = false
let linkPersistenceFailures = 0
let refuseNextHandoffTargetPrompt = false
let handoffTargetCounter = 0
let lastHandoffTargetID = null
let sseOpened = 0
const sseResponses = new Set()
let blockNextModelReadFor = null
let releaseBlockedModelRead = null

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

async function readBody(request) {
  let body = ""
  for await (const chunk of request) body += chunk
  try { return body ? JSON.parse(body) : {} } catch { return {} }
}

function sessionList(agentID) {
  return AGENTS[agentID].sessions.map((id, index) => ({
    id,
    title: titles.get(id),
    directory: DIRECTORY,
    external: true,
    time: { created: 1000 + index, updated: 1001 + index }
  }))
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
        machine: { id: "machine-model-switch", name: "Model Switch Test", createdAt: new Date().toISOString() },
        agents: Object.entries(AGENTS).map(([id, agent]) => ({
          id,
          label: agent.label,
          backend: id,
          transport: "acp",
          managed: true,
          state: "available",
          capabilities: { sessions: true, prompt: true, abort: true, streaming: true, models: true, attachments: id === "pi" },
          contract: { sessions: { stop: "owned-session-native-cancel" } }
        }))
      })
      return
    }

    if (request.method === "GET" && url.pathname === "/v1/projects") {
      json(response, 200, {
        projects: [{ id: "project-model-switch", machineId: "machine-model-switch", name: "model-switch", path: DIRECTORY, kind: "git", configured: true }]
      })
      return
    }


    if (url.pathname === "/v1/session-links") {
      if (request.method === "GET") {
        if (legacyNextLinkList) {
          legacyNextLinkList = false
          response.writeHead(204, corsHeaders())
          response.end()
          return
        }
        const identity = {
          machineID: url.searchParams.get("machineID"),
          agentID: url.searchParams.get("agentID"),
          sessionID: url.searchParams.get("sessionID")
        }
        const links = handoffLinks.filter((link) =>
          (link.source.machineID === identity.machineID && link.source.agentID === identity.agentID && link.source.sessionID === identity.sessionID)
          || (link.target.machineID === identity.machineID && link.target.agentID === identity.agentID && link.target.sessionID === identity.sessionID)
        )
        json(response, 200, { links })
        return
      }
      if (request.method === "POST") {
        const body = await readBody(request)
        const candidate = body.link
        if (rejectNextLinkPersistence) {
          rejectNextLinkPersistence = false
          linkPersistenceFailures += 1
          json(response, 503, { error: "Temporary SessionLinkStore write failure" })
          return
        }
        const index = handoffLinks.findIndex((link) =>
          link.source.machineID === candidate?.source?.machineID
          && link.source.agentID === candidate?.source?.agentID
          && link.source.sessionID === candidate?.source?.sessionID
          && link.target.machineID === candidate?.target?.machineID
          && link.target.agentID === candidate?.target?.agentID
          && link.target.sessionID === candidate?.target?.sessionID
        )
        if (index < 0) {
          json(response, 404, { error: "Unknown Session link" })
          return
        }
        handoffLinks[index] = { ...handoffLinks[index], ...candidate, createdAt: handoffLinks[index].createdAt }
        json(response, 200, { link: handoffLinks[index] })
        return
      }
    }

    const agentMatch = /^\/v1\/agents\/([^/]+)\/(.*)$/.exec(url.pathname)
    if (agentMatch) {
      const agentID = decodeURIComponent(agentMatch[1])
      const rest = agentMatch[2]
      const agent = AGENTS[agentID]
      if (!agent) {
        json(response, 404, { error: `Unknown agent ${agentID}` })
        return
      }

      if (request.method === "GET" && rest === "experimental/session") {
        json(response, 200, sessionList(agentID))
        return
      }
      if (request.method === "GET" && rest === "session/status") {
        json(response, 200, Object.fromEntries(agent.sessions.map((id) => [id, { type: "idle" }])))
        return
      }
      if (request.method === "GET" && (rest === "v1/capabilities" || rest === "capabilities")) {
        json(response, 200, { attachments: agentID === "pi", commands: false })
        return
      }
      if (request.method === "GET" && rest === "models") {
        modelReads[agentID] += 1
        if (blockNextModelReadFor === agentID) {
          blockNextModelReadFor = null
          await new Promise((resolve) => { releaseBlockedModelRead = resolve })
          releaseBlockedModelRead = null
        }
        json(response, 200, {
          models: agent.models,
          stale: false,
          refreshedAt: new Date().toISOString(),
          source: `model-switch-smoke:${agentID}`
        })
        return
      }
      const claim = /^session\/([^/]+)\/claim$/.exec(rest)
      if (request.method === "POST" && claim) {
        claimCounts[agentID] += 1
        json(response, 200, { claimed: true, sessionID: decodeURIComponent(claim[1]) })
        return
      }
      const handoff = /^session\/([^/]+)\/handoff$/.exec(rest)
      if (request.method === "POST" && handoff) {
        const sourceSessionID = decodeURIComponent(handoff[1])
        const body = await readBody(request)
        if (rejectNextHandoff) {
          rejectNextHandoff = false
          rejectedHandoffs.push({ sourceAgentID: agentID, sourceSessionID, ...body })
          json(response, 409, { error: "Target model is unavailable", code: "model_unavailable" })
          return
        }

        const ledgerKey = `${agentID}:${sourceSessionID}:${body.clientRequestId}`
        const duplicate = handoffLedger.get(ledgerKey)
        if (duplicate) {
          json(response, 200, { status: "accepted", duplicate: true, result: duplicate })
          return
        }

        const targetAgentID = body.targetAgentID
        const targetAgent = AGENTS[targetAgentID]
        if (!targetAgent) {
          json(response, 404, { error: `Unknown target agent ${targetAgentID}` })
          return
        }
        const targetSessionID = `native-handoff-${targetAgentID}-${++handoffTargetCounter}`
        lastHandoffTargetID = targetSessionID
        targetAgent.sessions.push(targetSessionID)
        titles.set(targetSessionID, body.title || `Handoff from ${agentID}`)
        transcripts.set(targetSessionID, [])
        const source = {
          machineID: "machine-model-switch",
          agentID,
          sessionID: sourceSessionID,
          directory: body.directory
        }
        const target = {
          machineID: "machine-model-switch",
          agentID: targetAgentID,
          sessionID: targetSessionID,
          directory: body.directory
        }
        const link = { type: "handoff", source, target, createdAt: new Date().toISOString() }
        handoffLinks.push(link)
        if (refuseNextHandoffTargetPrompt) {
          refuseNextHandoffTargetPrompt = false
          refuseNextPromptFor = targetSessionID
        }
        const result = { target, link }
        handoffLedger.set(ledgerKey, result)
        json(response, 200, { status: "accepted", clientRequestId: body.clientRequestId, result })
        return
      }
      const prompt = /^session\/([^/]+)\/prompt$/.exec(rest)
      if (request.method === "POST" && prompt) {
        const sessionID = decodeURIComponent(prompt[1])
        const body = await readBody(request)
        if (refuseNextPromptFor === sessionID) {
          refuseNextPromptFor = null
          refusedPrompts.push({ agentID, sessionID, ...body })
          // A definite refusal: the daemon answered and never dispatched the mutation.
          json(response, 409, { error: "Harness session not found", code: "session_unavailable" })
          return
        }
        promptBodies.push({ agentID, sessionID, ...body })
        // Answer in the native transcript, the way the harness would.
        const list = transcripts.get(sessionID) || []
        list.push({
          info: { id: `${sessionID}-u-${list.length}`, role: "user", sessionID, time: { created: 2000 + list.length } },
          parts: [{ id: `${sessionID}-ut-${list.length}`, type: "text", text: body.text }]
        })
        list.push({
          info: { id: `${sessionID}-a-${list.length}`, role: "assistant", sessionID, time: { created: 2001 + list.length, completed: 2002 + list.length } },
          parts: [{ id: `${sessionID}-at-${list.length}`, type: "text", text: `answered ${body.text}` }]
        })
        transcripts.set(sessionID, list)
        json(response, 200, { status: "accepted", clientRequestId: body.clientRequestId, sessionID })
        return
      }
      const messages = /^session\/([^/]+)\/message$/.exec(rest)
      if (request.method === "GET" && messages) {
        json(response, 200, transcripts.get(decodeURIComponent(messages[1])) || [], { "X-Has-More": "0" })
        return
      }
      if (request.method === "GET" && rest.includes("global/event")) {
        response.writeHead(200, { ...corsHeaders(), "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
        response.write(": connected\n\n")
        sseOpened += 1
        sseResponses.add(response)
        request.on("close", () => sseResponses.delete(response))
        return
      }
      if (request.method === "GET" && (rest.includes("question") || rest.includes("permission"))) {
        json(response, 200, [])
        return
      }
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
    try { if ((await fetch(url)).ok) return } catch (error) { lastError = error }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw lastError || new Error(`Preview did not become ready: ${url}`)
}

function stopPreview(child) {
  if (!child || child.killed || !child.pid) return
  try {
    if (process.platform === "win32") child.kill("SIGTERM")
    else process.kill(-child.pid, "SIGTERM")
  } catch { try { child.kill("SIGTERM") } catch {} }
}

function stopServer(server) {
  try { server.closeAllConnections?.() } catch {}
  try { server.close() } catch {}
}

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function openSession(page, title, marker) {
  await page.locator('.hr-native-workspace[aria-label="Sessions"]').waitFor({ state: "visible", timeout: 15_000 })
  await page.getByRole("button", { name: new RegExp(title) }).click()
  await page.getByRole("heading", { name: title }).waitFor({ state: "visible", timeout: 15_000 })
  await page.locator(".tdw-work-thread-conversation").waitFor({ state: "visible", timeout: 15_000 })
  await page.getByText(marker, { exact: true }).first().waitFor({ state: "visible", timeout: 15_000 })
  assert.equal(
    await page.getByText("Loading Session into the v3 controller...", { exact: true }).count(),
    0,
    `${title} stayed in the native controller loading state`
  )
}

async function backToSessions(page) {
  const back = page.getByRole("button", { name: /Sessions|Back/ }).first()
  if (await back.count()) {
    await back.click()
  } else {
    await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" })
  }
  await page.locator('.hr-native-workspace[aria-label="Sessions"]').waitFor({ state: "visible", timeout: 15_000 })
}

/** Open the picker and assert it shows this harness's catalog and nothing from the other one. */
async function assertCatalog(page, expectedIDs, forbiddenIDs, label) {
  const trigger = page.locator(".tdw-model-trigger")
  await trigger.waitFor({ state: "visible", timeout: 15_000 })
  await waitFor(async () => !(await trigger.isDisabled()), `${label} model picker to become usable`)
  await trigger.click()
  const listbox = page.getByRole("listbox", { name: "Models" })
  await listbox.waitFor({ state: "visible", timeout: 15_000 })
  const shown = await listbox.locator(".tdw-model-name code").allTextContents()
  for (const id of expectedIDs) assert.ok(shown.includes(id), `${label} picker is missing its own model ${id} (showed ${shown.join(",")})`)
  for (const id of forbiddenIDs) assert.ok(!shown.includes(id), `${label} picker leaked ${id} from another harness (showed ${shown.join(",")})`)
  return listbox
}

async function chooseModel(page, modelID, variant) {
  const listbox = page.getByRole("listbox", { name: "Models" })
  if (!(await listbox.isVisible())) await page.locator(".tdw-model-trigger").click()
  await listbox.waitFor({ state: "visible", timeout: 15_000 })
  const row = listbox.locator(".tdw-model-row").filter({ has: page.locator(`.tdw-model-name code:text-is("${modelID}")`) }).first()
  if (variant) {
    await row.locator(".tdw-model-main").click()
    await page.locator(".tdw-model-trigger").click()
    await listbox.waitFor({ state: "visible", timeout: 15_000 })
    const again = listbox.locator(".tdw-model-row").filter({ has: page.locator(`.tdw-model-name code:text-is("${modelID}")`) }).first()
    await again.locator(".tdw-model-variants button", { hasText: variant }).first().click()
  } else {
    await row.locator(".tdw-model-main").click()
  }
  await listbox.waitFor({ state: "hidden", timeout: 15_000 })
}

async function send(page, agentLabel, text) {
  const composer = page.getByRole("textbox", { name: `Message ${agentLabel}` })
  await composer.waitFor({ state: "visible", timeout: 15_000 })
  assert.equal(await composer.isDisabled(), false, `${agentLabel} composer stayed disabled`)
  await composer.fill(text)
  const before = promptBodies.length
  await page.getByRole("button", { name: /^Send$/ }).click()
  await waitFor(() => promptBodies.length > before, `prompt HTTP request for "${text}"`)
  return promptBodies[promptBodies.length - 1]
}

/** Send a prompt the daemon will refuse, and wait for the refusal to reach the UI. */
async function sendExpectingRefusal(page, agentLabel, text) {
  const composer = page.getByRole("textbox", { name: `Message ${agentLabel}` })
  await composer.waitFor({ state: "visible", timeout: 15_000 })
  await composer.fill(text)
  const before = refusedPrompts.length
  await page.getByRole("button", { name: /^Send$/ }).click()
  await waitFor(() => refusedPrompts.length > before, `refused prompt HTTP request for "${text}"`)
  // Let the client settle its pending-delivery bookkeeping before the next attempt.
  await page.waitForTimeout(400)
}

let daemon
let preview
let browser
try {
  daemon = await startFakeDaemon()
  preview = startPreview()
  await ready(APP_ORIGIN)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.addInitScript(({ key, port }) => {
    localStorage.setItem(key, JSON.stringify([{
      id: "machine-model-switch",
      name: "Model Switch Test",
      config: { backend: "opencode", host: "127.0.0.1", port, username: "harness", password: "testpw" }
    }]))
  }, { key: STORAGE_KEY, port: DAEMON_PORT })
  page.on("pageerror", (error) => { throw error })
  await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" })

  // --- A: catalog, two model changes in a row, then send -----------------------------------------
  // A rolling-upgrade daemon may not know /v1/session-links yet and can answer 204. Opening a
  // completely normal Session must stay usable instead of storing undefined and crashing on .find().
  legacyNextLinkList = true
  blockNextModelReadFor = "pi"
  await openSession(page, TITLE_A, markers.get(SESSION_A))
  const blockedComposer = page.getByRole("textbox", { name: "Message PI" })
  await blockedComposer.waitFor({ state: "visible", timeout: 15_000 })
  await waitFor(() => typeof releaseBlockedModelRead === "function", "blocked PI model catalog request")
  assert.equal(await blockedComposer.isDisabled(), true, "composer must stay disabled while native models are still loading")
  assert.equal(await page.getByRole("button", { name: /^Send$/ }).isDisabled(), true, "Send must stay disabled while native models are still loading")
  assert.equal(await page.locator(".tdw-agent-control select").first().isDisabled(), true, "harness selector must stay disabled while native models are still loading")
  assert.match(await page.locator(".tdw-conversation-state").innerText(), /Loading models|Waiting for model catalog/, "Session must expose model bootstrap instead of Ready")
  releaseBlockedModelRead?.()
  await assertCatalog(page, ["pi-coding", "pi-reasoning"], ["omp-fast", "omp-deep"], "A")
  assert.equal(await blockedComposer.isDisabled(), false, "composer must enable automatically after the verified catalog arrives")
  await chooseModel(page, "pi-coding")
  await assertCatalog(page, ["pi-coding", "pi-reasoning"], ["omp-fast", "omp-deep"], "A after first change")
  await chooseModel(page, "pi-reasoning", "high")
  const a1 = await send(page, "PI", "A-SEND-1")
  assert.equal(a1.agentID, "pi")
  assert.equal(a1.sessionID, SESSION_A)
  assert.deepEqual(a1.model, { providerID: "pi", modelID: "pi-reasoning" }, "A sent the model selected last, not the first pick")
  assert.equal(a1.variant, "high", "A carried the selected variant")

  // --- B: a different model on a second Session, no reload ----------------------------------------
  await backToSessions(page)
  await openSession(page, TITLE_B, markers.get(SESSION_B))
  await assertCatalog(page, ["pi-coding", "pi-reasoning"], ["omp-fast", "omp-deep"], "B")
  await chooseModel(page, "pi-coding")
  const b1 = await send(page, "PI", "B-SEND-1")
  assert.equal(b1.sessionID, SESSION_B, "B's prompt must not be routed to A")
  assert.deepEqual(b1.model, { providerID: "pi", modelID: "pi-coding" })
  assert.equal(b1.variant, undefined, "choosing a base model must clear the previous variant")

  // --- B: one refused prompt must not brick the Session once the model changes ---------------------
  // This is the reported headline symptom: a refused delivery left a durable pending record, and
  // because a model change makes the next request differ from it, every later prompt was rejected
  // by the client itself - across reloads, since the record lives in localStorage.
  refuseNextPromptFor = SESSION_B
  await sendExpectingRefusal(page, "PI", "B-REFUSED")
  assert.equal(refusedPrompts.length, 1, "the refusal leg must have produced exactly one refused delivery")
  await assertCatalog(page, ["pi-coding", "pi-reasoning"], ["omp-fast", "omp-deep"], "B after a refusal")
  await chooseModel(page, "pi-reasoning", "high")
  const b2 = await send(page, "PI", "B-SEND-AFTER-REFUSAL")
  assert.equal(b2.sessionID, SESSION_B, "B must still be usable after a refused prompt plus a model change")
  assert.deepEqual(b2.model, { providerID: "pi", modelID: "pi-reasoning" })
  assert.equal(b2.variant, "high")

  // A reload must not resurrect the refused delivery as a block either.
  await page.reload({ waitUntil: "domcontentloaded" })
  await openSession(page, TITLE_B, markers.get(SESSION_B))
  await assertCatalog(page, ["pi-coding", "pi-reasoning"], ["omp-fast", "omp-deep"], "B after reload")
  await chooseModel(page, "pi-coding")
  const b3 = await send(page, "PI", "B-SEND-AFTER-RELOAD")
  assert.equal(b3.sessionID, SESSION_B, "a reload must not restore a stale delivery block")
  assert.deepEqual(b3.model, { providerID: "pi", modelID: "pi-coding" })

  // --- C: another harness entirely ----------------------------------------------------------------
  await backToSessions(page)
  await openSession(page, TITLE_C, markers.get(SESSION_C))
  await assertCatalog(page, ["omp-fast", "omp-deep"], ["pi-coding", "pi-reasoning"], "C")
  await chooseModel(page, "omp-deep")
  const c1 = await send(page, "OMP", "C-SEND-1")
  assert.equal(c1.agentID, "omp", "C's prompt must reach the harness that owns it")
  assert.equal(c1.sessionID, SESSION_C)
  assert.deepEqual(c1.model, { providerID: "omp", modelID: "omp-deep" })

  // --- back to A: change model again and keep working ---------------------------------------------
  await backToSessions(page)
  await openSession(page, TITLE_A, markers.get(SESSION_A))
  await assertCatalog(page, ["pi-coding", "pi-reasoning"], ["omp-fast", "omp-deep"], "A revisited")
  await chooseModel(page, "pi-coding")
  const a2 = await send(page, "PI", "A-SEND-2")
  assert.equal(a2.sessionID, SESSION_A, "returning to A must still address A")
  assert.deepEqual(a2.model, { providerID: "pi", modelID: "pi-coding" })
  assert.equal(a2.variant, undefined)

  // --- every Session is still usable afterwards ---------------------------------------------------
  for (const [title, sessionID, label] of [[TITLE_B, SESSION_B, "PI"], [TITLE_C, SESSION_C, "OMP"]]) {
    await backToSessions(page)
    await openSession(page, title, markers.get(sessionID))
    const composer = page.getByRole("textbox", { name: `Message ${label}` })
    await composer.waitFor({ state: "visible", timeout: 15_000 })
    assert.equal(await composer.isDisabled(), false, `${title} became unusable after the model-switch sequence`)
    assert.equal(await page.locator(".tdw-model-trigger").isDisabled(), false, `${title} model picker became unusable`)
  }

  // --- explicit same-machine handoff: failure recovery, model isolation and persistent lineage ----
  await backToSessions(page)
  await openSession(page, TITLE_A, markers.get(SESSION_A))

  const routedControls = page.locator(".tdw-agent-control.routed")
  await routedControls.waitFor({ state: "visible", timeout: 15_000 })
  assert.equal(await routedControls.getByText("Machine", { exact: true }).count(), 0, "Session handoff must not expose a machine selector")
  assert.equal(await routedControls.getByText("Harness", { exact: true }).count(), 1, "Session handoff must expose one harness selector")
  assert.equal(await routedControls.getByText("Model", { exact: true }).count(), 1, "Session handoff must keep model selection")
  assert.equal(await page.locator(".tdw-conversation-state").isVisible(), true, "routing controls must not hide the Session state")

  // Harness + Model are one decision and must read as one compact control group. The routed container
  // used to inherit flex:1 while also declaring a 760px grid, so on a wide Session pane the unused
  // first track pushed Model noticeably to the right even though the Harness select itself stopped at
  // 220px. Lock the visible control-to-control gap, not just a CSS token, so cascade regressions fail.
  const routingHarnessBox = await routedControls.locator("label").filter({ hasText: /^Harness/ }).locator("select").boundingBox()
  const routingModelBox = await routedControls.locator(".tdw-model-trigger").boundingBox()
  const routingGroupBox = await routedControls.boundingBox()
  assert.ok(routingHarnessBox && routingModelBox && routingGroupBox, "routing controls must have measurable desktop geometry")
  const harnessToModelGap = routingModelBox.x - (routingHarnessBox.x + routingHarnessBox.width)
  assert.ok(harnessToModelGap >= 0 && harnessToModelGap <= 16, `Harness and Model drifted apart by ${harnessToModelGap}px`)
  assert.ok(routingGroupBox.width <= 600, `routing control group expanded to ${routingGroupBox.width}px`)

  // Attachments stay on their current Session. Switching harness must keep the attachment visible,
  // hide the add-image action and block Send until the user explicitly removes it.
  const attachmentInput = page.locator('.uw-composer-shell input[type="file"]')
  await attachmentInput.waitFor({ state: "attached", timeout: 15_000 })
  await attachmentInput.setInputFiles({
    name: "handoff.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
  })
  await page.getByRole("button", { name: "Remove handoff.png" }).waitFor({ state: "visible", timeout: 15_000 })

  const harnessSelect = routedControls.locator("label").filter({ hasText: /^Harness/ }).locator("select")
  rejectNextHandoff = true
  await harnessSelect.selectOption("omp")
  assert.equal(await page.getByRole("button", { name: "Attach image" }).count(), 0, "target harness must not accept new attachments during handoff")
  const attachmentBlockedComposer = page.getByRole("textbox", { name: "Message PI" })
  await attachmentBlockedComposer.fill("BLOCKED-BY-ATTACHMENT")
  assert.equal(await page.getByRole("button", { name: /^Send$/ }).isDisabled(), true, "existing attachments must block routed Send")
  await page.getByText("Remove the attached images before continuing on another harness.", { exact: true }).waitFor({ state: "visible" })
  assert.equal(handoffLinks.length, 0, "attachment-blocked route must not create a target Session")
  await page.getByRole("button", { name: "Remove handoff.png" }).click()
  // Harness change synchronously invalidates the old PI model. Once the OMP catalog arrives it must
  // contain only OMP choices, never the stale PI selection that could previously race with Send.
  assert.ok(!(await page.locator(".tdw-model-trigger").innerText()).includes("pi-"), "old harness model remained visible after changing harness")
  await assertCatalog(page, ["omp-fast", "omp-deep"], ["pi-coding", "pi-reasoning"], "A routed to OMP")
  await chooseModel(page, "omp-deep")

  const refusedComposer = page.getByRole("textbox", { name: "Message PI" })
  await refusedComposer.fill("HANDOFF-REFUSED")
  const rejectedBefore = rejectedHandoffs.length
  await page.getByRole("button", { name: /^Send$/ }).click()
  await waitFor(() => rejectedHandoffs.length === rejectedBefore + 1, "definite handoff refusal")
  await page.getByRole("alert").waitFor({ state: "visible", timeout: 15_000 })

  // A definite 409 must not leave an immortal route transaction. Change both model and prompt and
  // prove the next handoff creates a new native target instead of being blocked client-side.
  await assertCatalog(page, ["omp-fast", "omp-deep"], ["pi-coding", "pi-reasoning"], "A after handoff refusal")
  await chooseModel(page, "omp-fast")
  const routedPromptBefore = promptBodies.length
  const handoffCountBefore = handoffLinks.length
  const createsBeforeContextFailure = handoffTargetCounter
  rejectNextLinkPersistence = true
  const contextRetryComposer = page.getByRole("textbox", { name: "Message PI" })
  await contextRetryComposer.fill("HANDOFF-SUCCESS")
  await page.getByRole("button", { name: /^Send$/ }).click()
  await waitFor(() => linkPersistenceFailures === 1, "transferred-context persistence refusal")
  await waitFor(() => handoffLinks.length === handoffCountBefore + 1, "target/link creation before context persistence refusal")
  assert.ok(lastHandoffTargetID, "handoff target was not created before context persistence failed")
  const firstHandoffTargetID = lastHandoffTargetID
  assert.equal(handoffTargetCounter, createsBeforeContextFailure + 1, "context persistence failure must happen after exactly one target create")
  assert.equal(promptBodies.length, routedPromptBefore, "first prompt must wait until lineage/context persistence succeeds")
  await page.getByRole("alert").waitFor({ state: "visible", timeout: 15_000 })

  const createsBeforeContextRetry = handoffTargetCounter
  const routed = await send(page, "PI", "HANDOFF-SUCCESS")
  assert.equal(handoffTargetCounter, createsBeforeContextRetry, "context persistence retry must reuse the already-created target Session")
  await waitFor(() => Boolean(handoffLinks.at(-1)?.transferredContext), "persisted transferred context")
  assert.equal(routed.sessionID, firstHandoffTargetID, "first routed prompt must address the already-created target Session")
  assert.equal(routed.agentID, "omp")
  await page.getByRole("textbox", { name: "Message OMP" }).waitFor({ state: "visible", timeout: 15_000 })
  assert.deepEqual(routed.model, { providerID: "omp", modelID: "omp-fast" })
  assert.equal(promptBodies.length, routedPromptBefore + 1, "one routed Send must dispatch exactly one target prompt")
  assert.match(routed.text, /TRANSFERRED TASK CONTEXT/)
  assert.match(routed.text, /SWITCH-A-HISTORY/)
  assert.equal(handoffLinks.at(-1).source.machineID, handoffLinks.at(-1).target.machineID, "handoff link must stay on one machine")

  await page.locator(".hr-session-transfer-context > summary").waitFor({ state: "visible", timeout: 15_000 })
  assert.equal(await page.getByText("Continued from", { exact: true }).count(), 1, "target Session must identify its source")

  // Reopening after a full app reload must recover both lineage and the exact bounded transferred
  // context from daemon metadata, not from the in-memory target returned by the handoff call.
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.locator('.hr-native-workspace[aria-label="Sessions"]').waitFor({ state: "visible", timeout: 15_000 })
  const reopenedTarget = page.locator(".hr-native-session-row")
    .filter({ hasText: TITLE_A })
    .filter({ hasText: "OMP" })
    .first()
  await reopenedTarget.waitFor({ state: "visible", timeout: 15_000 })
  await reopenedTarget.click()
  await page.getByRole("heading", { name: TITLE_A }).waitFor({ state: "visible", timeout: 15_000 })
  await page.getByText("Continued from", { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  await page.locator(".hr-session-transfer-context > summary").waitFor({ state: "visible", timeout: 15_000 })
  const transfer = page.locator(".hr-session-transfer-context")
  await transfer.locator("summary").click()
  assert.match(await transfer.locator("pre").innerText(), /SWITCH-A-HISTORY/, "reopened target lost its transferred context")

  // --- target created, first target prompt refused: retry must reuse that exact target --------------
  await backToSessions(page)
  await openSession(page, TITLE_B, markers.get(SESSION_B))
  const retryControls = page.locator(".tdw-agent-control.routed")
  const retryHarness = retryControls.locator("label").filter({ hasText: /^Harness/ }).locator("select")
  await retryHarness.selectOption("omp")
  await assertCatalog(page, ["omp-fast", "omp-deep"], ["pi-coding", "pi-reasoning"], "B routed to OMP")
  await chooseModel(page, "omp-deep")

  const linksBeforeTargetPromptRefusal = handoffLinks.length
  const createsBeforeTargetPromptRefusal = handoffTargetCounter
  const refusedBeforeTargetPromptRefusal = refusedPrompts.length
  refuseNextHandoffTargetPrompt = true
  const sourceComposer = page.getByRole("textbox", { name: "Message PI" })
  await sourceComposer.fill("TARGET-FIRST-PROMPT-REFUSED")
  await page.getByRole("button", { name: /^Send$/ }).click()
  await waitFor(() => refusedPrompts.length === refusedBeforeTargetPromptRefusal + 1, "first target prompt refusal")
  await waitFor(() => handoffLinks.length === linksBeforeTargetPromptRefusal + 1, "target creation before refused first prompt")
  const refusedTargetID = lastHandoffTargetID
  assert.ok(refusedTargetID, "handoff target was not created before first-prompt refusal")
  assert.equal(handoffTargetCounter, createsBeforeTargetPromptRefusal + 1, "first attempt must create exactly one target Session")
  assert.equal(refusedPrompts.at(-1).sessionID, refusedTargetID, "the refusal must come from the created target Session")
  await page.getByRole("alert").waitFor({ state: "visible", timeout: 15_000 })

  // A definite prompt 4xx releases only prompt delivery state. The durable route still owns the
  // created target, so changing prompt/model must retry that Session without another handoff create.
  await assertCatalog(page, ["omp-fast", "omp-deep"], ["pi-coding", "pi-reasoning"], "B target retry after first prompt refusal")
  await chooseModel(page, "omp-fast")
  const linksBeforeTargetRetry = handoffLinks.length
  const createsBeforeTargetRetry = handoffTargetCounter
  const recovered = await send(page, "PI", "TARGET-FIRST-PROMPT-RECOVERED")
  assert.equal(recovered.agentID, "omp")
  assert.equal(recovered.sessionID, refusedTargetID, "retry after first-prompt 4xx must reuse the already-created target Session")
  assert.deepEqual(recovered.model, { providerID: "omp", modelID: "omp-fast" })
  assert.equal(handoffLinks.length, linksBeforeTargetRetry, "retry must not create a second lineage link")
  assert.equal(handoffTargetCounter, createsBeforeTargetRetry, "retry must not create a second native target Session")
  await page.getByRole("textbox", { name: "Message OMP" }).waitFor({ state: "visible", timeout: 15_000 })

  // --- delivery and subscription hygiene ----------------------------------------------------------
  assert.equal(promptBodies.length, 8, `expected exactly eight accepted prompts including two routed handoffs, got ${promptBodies.length}`)
  const requestIDs = promptBodies.map((body) => body.clientRequestId)
  assert.equal(new Set(requestIDs).size, requestIDs.length, "each Send must use its own durable client request id")
  assert.ok(requestIDs.every((value) => typeof value === "string" && value), "every prompt must carry a client request id")
  assert.equal(promptBodies.filter((body) => body.sessionID === SESSION_A).length, 2, "A received exactly its own two prompts")
  assert.equal(promptBodies.filter((body) => body.sessionID === SESSION_B).length, 3)
  assert.equal(refusedPrompts.length, 2, "one normal prompt and one created-target first prompt were refused on purpose")
  assert.equal(rejectedHandoffs.length, 1, "exactly one handoff creation was definitively refused")
  assert.equal(promptBodies.filter((body) => body.sessionID === SESSION_C).length, 1)
  assert.equal(promptBodies.filter((body) => body.sessionID === firstHandoffTargetID).length, 1, "first handoff target received exactly one prompt")
  assert.equal(promptBodies.filter((body) => body.sessionID === lastHandoffTargetID).length, 1, "recovered handoff target received exactly one accepted prompt")
  for (const body of promptBodies) assert.equal(body.directory, DIRECTORY, "every prompt must carry the Project directory")

  // Repeated Session opens must not leave one live event stream behind each.
  assert.ok(sseResponses.size <= 2, `event subscriptions accumulated: ${sseResponses.size} still open after ${sseOpened} opened`)
  assert.ok(modelReads.pi > 0 && modelReads.omp > 0, "both harness catalogs were consulted")
  assert.ok(modelReads.pi <= 16, `PI catalog was re-read too often: ${modelReads.pi}`)
  assert.ok(modelReads.omp <= 8, `OMP catalog was re-read too often: ${modelReads.omp}`)

  console.log(`native Session model-switch + handoff smoke passed: ${promptBodies.length} prompts, links=${handoffLinks.length}, catalog reads pi=${modelReads.pi} omp=${modelReads.omp}, sse open=${sseResponses.size}/${sseOpened}`)
} finally {
  if (browser) await browser.close().catch(() => undefined)
  stopPreview(preview)
  if (daemon) stopServer(daemon)
}
