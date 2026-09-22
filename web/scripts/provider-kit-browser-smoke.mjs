import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const PREVIEW_PORT = 4191
const DAEMON_PORT = 4437
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const DIRECTORY = "/work/provider-kit-browser"
const ALL_AGENTS = [
  ["opencode", "OpenCode", "http", true, "optional"],
  ["opencode2", "OpenCode 2", "acp", true, "required"],
  ["copilot", "GitHub Copilot CLI", "acp", false, "harness-default"],
  ["mimo", "MiMo Code", "acp", true, "optional"],
  ["codex", "Codex CLI", "acp", true, "optional"],
  ["claude", "Claude Code", "acp", true, "optional"],
  ["omp", "Oh My Pi", "acp", true, "optional"],
  ["pi", "PI", "acp", true, "optional"]
]
const PROVIDERS = Object.fromEntries(ALL_AGENTS.map(([id, label, transport, models, selection]) => [
  id,
  { label, transport, models, selection }
]))

let clock = 10_000
let createdCounter = 0
const sessions = new Map()
const statuses = new Map()
const transcripts = new Map()
const modelReads = new Map()
const promptBodies = []
const stopBodies = []
const claims = new Map()
const timers = new Set()
const sseResponses = new Set()

function textPart(id, text) {
  return { id, type: "text", text }
}

function message(sessionID, id, role, text, created, completed) {
  return {
    info: {
      id, role, sessionID,
      time: { created, ...(completed ? { completed } : {}) }
    },
    parts: text ? [textPart(`${id}:text`, text)] : []
  }
}

function addSession(provider, id, title, external = true) {
  sessions.set(id, { id, provider, title, directory: DIRECTORY, external, time: { created: clock, updated: clock } })
  statuses.set(id, "idle")
  transcripts.set(id, [
    message(id, `${id}:history-user`, "user", `${provider.toUpperCase()}-HISTORY-USER`, clock++, undefined),
    message(id, `${id}:history-assistant`, "assistant", `${provider.toUpperCase()}-HISTORY-REPLY`, clock, clock + 1)
  ])
  clock += 2
}

for (const [provider, { label }] of Object.entries(PROVIDERS)) {
  addSession(provider, `${provider}-session`, `${label} Existing`)
}

function providerForSession(sessionID) {
  return sessions.get(sessionID)?.provider
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Harness-Backend",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Max-Age": "600"
  }
}

function json(response, status, value, extra = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...corsHeaders(), ...extra })
  response.end(JSON.stringify(value))
}

async function requestJSON(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString("utf8")
  return raw ? JSON.parse(raw) : {}
}

function sessionView(entry) {
  return {
    id: entry.id,
    title: entry.title,
    directory: entry.directory,
    external: entry.external,
    time: entry.time,
    status: { type: statuses.get(entry.id) || "idle" }
  }
}

function settleSuccess(sessionID, body) {
  const timer = setTimeout(() => {
    timers.delete(timer)
    if (statuses.get(sessionID) !== "busy") return
    const base = clock
    clock += 4
    const transcript = transcripts.get(sessionID)
    transcript.push(
      message(sessionID, `${sessionID}:user:${body.clientRequestId}`, "user", body.text, base),
      message(sessionID, `${sessionID}:assistant:${body.clientRequestId}`, "assistant", `${providerForSession(sessionID).toUpperCase()}-REPLY-${body.text}`, base + 1, base + 2)
    )
    sessions.get(sessionID).time.updated = base + 2
    statuses.set(sessionID, "idle")
  }, 900)
  timers.add(timer)
}

function machineAgents() {
  return ALL_AGENTS.map(([id, label, transport, models, selection]) => ({
    id, label, backend: id, transport, managed: true, state: "available",
    capabilities: {
      sessions: true, prompt: true, abort: true, streaming: true, models,
      filesystemBrowser: true, commands: id === "copilot" || id === "opencode2",
      permissions: id === "copilot" || id === "opencode2" || id === "mimo",
      questions: false, sessionRename: false, sessionDelete: false
    },
    contract: {
      models: {
        source: models ? "acp-config-options" : "harness-default",
        cacheScope: "machine",
        variants: "runtime-advertised-only",
        variantConfigIDs: [],
        selection
      },
      sessions: { stop: "owned-session-native-cancel" }
    }
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
        machine: { id: "machine-provider-kit", name: "Provider Kit Browser", createdAt: new Date().toISOString() },
        agents: machineAgents()
      })
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/projects") {
      json(response, 200, {
        projects: [{ id: "provider-kit-project", machineId: "machine-provider-kit", name: "provider-kit-browser", path: DIRECTORY, kind: "git", configured: true }]
      })
      return
    }

    const scoped = /^\/v1\/agents\/([^/]+)(\/.*)$/.exec(url.pathname)
    if (!scoped) {
      json(response, 404, { error: `No fake route for ${request.method} ${url.pathname}` })
      return
    }
    const provider = decodeURIComponent(scoped[1])
    const path = scoped[2]

    if (request.method === "GET" && (path === "/experimental/session" || path === "/session")) {
      json(response, 200, [...sessions.values()].filter((entry) => entry.provider === provider).map(sessionView))
      return
    }
    if (request.method === "GET" && path === "/session/status") {
      json(response, 200, Object.fromEntries(
        [...sessions.values()].filter((entry) => entry.provider === provider).map((entry) => [entry.id, { type: statuses.get(entry.id) || "idle" }])
      ))
      return
    }
    if (request.method === "GET" && path === "/models") {
      modelReads.set(provider, (modelReads.get(provider) || 0) + 1)
      const providerInfo = PROVIDERS[provider]
      if (!providerInfo?.models) {
        json(response, 500, { error: `${provider} must not require a model catalog` })
        return
      }
      json(response, 200, {
        models: [{
          providerID: provider,
          providerName: providerInfo.label,
          modelID: "test-model",
          modelName: `${providerInfo.label} Test Model`,
          isDefault: true
        }, {
          providerID: provider,
          providerName: providerInfo.label,
          modelID: "test-model-alt",
          modelName: `${providerInfo.label} Alternate Model`,
          isDefault: false
        }],
        stale: false, refreshedAt: new Date().toISOString(), source: "all-harness-browser"
      })
      return
    }
    if (request.method === "GET" && (path === "/capabilities" || path === "/v1/capabilities")) {
      json(response, 200, { attachments: false, commands: provider === "copilot" || provider === "opencode2" })
      return
    }
    if (request.method === "GET" && (path.includes("/question") || path.includes("/permission"))) {
      json(response, 200, [])
      return
    }
    if (request.method === "GET" && path.includes("/global/event")) {
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

    if (request.method === "POST" && path === "/session") {
      const body = await requestJSON(request)
      createdCounter += 1
      const id = `${provider}-created-${createdCounter}`
      addSession(provider, id, body.title || `${provider} created`, false)
      const entry = sessions.get(id)
      json(response, 200, sessionView(entry))
      return
    }

    const msg = /^\/session\/([^/]+)\/message$/.exec(path)
    if (request.method === "GET" && msg) {
      const id = decodeURIComponent(msg[1])
      assert.equal(providerForSession(id), provider, "transcript routed to wrong provider")
      json(response, 200, transcripts.get(id) || [], { "X-Has-More": "0" })
      return
    }
    const claim = /^\/session\/([^/]+)\/claim$/.exec(path)
    if (request.method === "POST" && claim) {
      const id = decodeURIComponent(claim[1])
      assert.equal(providerForSession(id), provider, "claim routed to wrong provider")
      claims.set(id, (claims.get(id) || 0) + 1)
      json(response, 200, { ok: true, sessionID: id })
      return
    }
    const prompt = /^\/session\/([^/]+)\/prompt$/.exec(path)
    if (request.method === "POST" && prompt) {
      const id = decodeURIComponent(prompt[1])
      assert.equal(providerForSession(id), provider, "prompt routed to wrong provider")
      const body = await requestJSON(request)
      promptBodies.push({ provider, sessionID: id, body })
      statuses.set(id, "busy")
      if (!body.text.endsWith("-LONG")) settleSuccess(id, body)
      json(response, 200, { status: "accepted", clientRequestId: body.clientRequestId, sessionID: id })
      return
    }
    const stop = /^\/session\/([^/]+)\/stop$/.exec(path)
    if (request.method === "POST" && stop) {
      const id = decodeURIComponent(stop[1])
      const body = await requestJSON(request)
      stopBodies.push({ provider, sessionID: id, body })
      statuses.set(id, "idle")
      json(response, 200, { status: "accepted", clientRequestId: body.clientRequestId })
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

async function waitFor(check, description, timeout = 15_000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try { if (await check()) return } catch (error) { lastError = error }
    await new Promise((resolve) => setTimeout(resolve, 75))
  }
  if (lastError) throw lastError
  throw new Error(`Timed out waiting for ${description}`)
}

async function seed(page) {
  await page.addInitScript(({ key, port }) => {
    localStorage.setItem(key, JSON.stringify([{
      id: "machine-provider-kit",
      name: "Provider Kit Browser",
      config: { backend: "opencode", host: "127.0.0.1", port, username: "harness", password: "testpw" }
    }]))
  }, { key: STORAGE_KEY, port: DAEMON_PORT })
}

async function loadHome(page) {
  await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" })
  await page.locator('.hr-native-workspace[aria-label="Sessions"]').waitFor({ state: "visible", timeout: 15_000 })
  await page.getByRole("button", { name: "New Session" }).waitFor({ state: "visible", timeout: 15_000 })
}

async function assertFilterIdentity(page) {
  const filter = page.getByRole("combobox", { name: "Filter by coding agent" })
  await filter.waitFor({ state: "visible" })
  const options = await filter.locator("option").evaluateAll((nodes) => nodes.map((node) => ({ value: node.value, text: node.textContent || "" })))
  const byID = Object.fromEntries(options.filter((item) => item.value).map((item) => [item.value, item.text.replace(/\s+·\s+\d+$/, "")]))
  for (const [id, label] of ALL_AGENTS.map(([id, label]) => [id, label])) {
    assert.equal(byID[id], label, `filter identity mismatch for ${id}`)
  }
  assert.equal(byID.opencode, "OpenCode")
  assert.equal(byID.opencode2, "OpenCode 2")
}

async function openProvider(page, provider, title) {
  const filter = page.getByRole("combobox", { name: "Filter by coding agent" })
  await filter.selectOption(provider)
  await page.getByRole("button", { name: new RegExp(title) }).click()
  await page.getByRole("heading", { name: title }).waitFor({ state: "visible", timeout: 15_000 })
  const composer = page.getByRole("textbox", { name: new RegExp(`Message ${PROVIDERS[provider].label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) })
  await composer.waitFor({ state: "visible", timeout: 15_000 })
  await waitFor(async () => !(await composer.isDisabled()), `${provider} composer enabled`)
  return composer
}

async function sendAndExpect(page, provider, composer, text) {
  await composer.fill(text)
  const send = page.getByRole("button", { name: "Send" })
  await waitFor(async () => !(await send.isDisabled()), `${provider} send enabled`)
  await send.click()
  await page.locator(".tdw-conversation-state.working").waitFor({ state: "attached", timeout: 5_000 })
  const reply = `${provider.toUpperCase()}-REPLY-${text}`
  // The native prompt endpoint acknowledges before the delayed transcript becomes durable. During
  // that gap the product must stay in one coherent Working state; an early Ready with a separate
  // spinner is exactly the MiMo regression this smoke is intended to prevent.
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(await page.locator(".tdw-conversation-state.ready").count(), 0, `${provider} became Ready before its reply was durable`)
  assert.equal(await page.locator(".tdw-conversation-state.working").count(), 1, `${provider} lost the authoritative Working state before reply`)
  assert.equal(await page.locator(".uw-message-pending .bui-typing").count(), 1, `${provider} spinner must share the same Working lifecycle`)
  assert.equal(await page.getByText(reply, { exact: true }).count(), 0, `${provider} fake reply settled before the lifecycle assertion`)
  await page.getByText(reply, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
  await page.locator(".tdw-conversation-state.ready").waitFor({ state: "attached", timeout: 15_000 })
  assert.equal(await page.locator(".uw-message-pending .bui-typing").count(), 0, `${provider} spinner must disappear when the reply becomes Ready`)
  assert.equal(await page.getByText(text, { exact: true }).count(), 1, `${provider} prompt duplicated`)
  assert.equal(await page.getByText(reply, { exact: true }).count(), 1, `${provider} reply duplicated`)
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

let daemon, preview, browser
try {
  daemon = await startFakeDaemon()
  preview = startPreview()
  await ready(APP_ORIGIN)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const pageErrors = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await seed(page)

  await loadHome(page)
  await assertFilterIdentity(page)

  for (const [provider, info] of Object.entries(PROVIDERS)) {
    const title = `${info.label} Existing`
    await loadHome(page)
    const composer = await openProvider(page, provider, title)
    await page.getByText(`${provider.toUpperCase()}-HISTORY-USER`, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
    await page.getByText(`${provider.toUpperCase()}-HISTORY-REPLY`, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
    const modelTrigger = page.locator(".tdw-model-control .tdw-model-trigger")
    await modelTrigger.waitFor({ state: "visible", timeout: 15_000 })
    if (info.selection === "harness-default") {
      assert.equal(await modelTrigger.isDisabled(), true, `${provider} model picker must defer to harness default`)
      assert.match(await modelTrigger.textContent(), /Harness default/, `${provider} must visibly use the harness default`)
    } else {
      await waitFor(async () => !(await modelTrigger.isDisabled()), `${provider} model picker enabled`)
      if (info.selection === "optional") {
        assert.match(await modelTrigger.textContent(), /Harness default/, `${provider} existing Session must preserve its native model until the user changes it`)
      } else {
        assert.match(await modelTrigger.textContent(), /Test Model/, `${provider} required catalog did not populate`)
      }
      await modelTrigger.click()
      const alternate = page.locator(".tdw-model-main").filter({ hasText: `${info.label} Alternate Model` })
      await alternate.waitFor({ state: "visible", timeout: 5_000 })
      await alternate.click()
      assert.match(await modelTrigger.textContent(), /Alternate Model/, `${provider} picker did not retain the chosen alternate model`)
    }
    const existingPrompt = `${provider.toUpperCase()}-EXISTING`
    await sendAndExpect(page, provider, composer, existingPrompt)
    if (info.selection !== "harness-default") {
      const routed = [...promptBodies].reverse().find((entry) => entry.provider === provider && entry.body.text === existingPrompt)
      assert.equal(routed?.body?.model?.modelID, "test-model-alt", `${provider} Send did not carry the selected model`)
    }
  }

  for (const [provider, info] of Object.entries(PROVIDERS)) {
    const reads = modelReads.get(provider) || 0
    if (info.models) assert.ok(reads > 0, `${provider} must request its model catalog`)
    else assert.equal(reads, 0, `${provider} must not request a model catalog`)
  }

  // Creation and rediscovery are exercised for every supported harness. A created Session must
  // reopen through the same provider rather than falling back to the daemon's primary/OpenCode path.
  for (const [provider, info] of Object.entries(PROVIDERS)) {
    const title = `${info.label} Created Browser`
    await loadHome(page)
    await page.getByRole("button", { name: "New Session" }).click()
    const create = page.locator(".hr-native-create-panel")
    await create.waitFor({ state: "visible" })
    await create.locator("select").nth(2).selectOption(provider)
    await create.locator(".hr-native-create-title input").fill(title)
    await create.getByRole("button", { name: /Create/ }).click()
    await page.getByRole("heading", { name: title }).waitFor({ state: "visible", timeout: 15_000 })

    let createdComposer = page.getByRole("textbox", { name: new RegExp("Message " + PROVIDERS[provider].label) })
    await waitFor(async () => !(await createdComposer.isDisabled()), `${provider} created composer enabled`)
    const created = [...sessions.values()].find((entry) => entry.title === title)
    assert.ok(created, `${provider} create did not reach the routed provider`)
    assert.equal(created.provider, provider, `${provider} create was routed to ${created.provider}`)
    const createdModelTrigger = page.locator(".tdw-model-control .tdw-model-trigger")
    let expectedCreatedModel = null
    if (info.models) {
      await waitFor(async () => !(await createdModelTrigger.isDisabled()), `created ${provider} model picker enabled`)
      if (info.selection === "required") {
        assert.match(await createdModelTrigger.textContent(), /Test Model/, `created ${provider} did not select its required verified model`)
        expectedCreatedModel = "test-model"
      } else {
        assert.match(await createdModelTrigger.textContent(), /Harness default/, `created ${provider} must preserve its harness default until the user chooses a model`)
        await createdModelTrigger.click()
        const explicit = page.locator(".tdw-model-main").filter({ hasText: `${info.label} Test Model` })
        await explicit.waitFor({ state: "visible", timeout: 5_000 })
        await explicit.click()
        assert.match(await createdModelTrigger.textContent(), /Test Model/, `created ${provider} picker did not retain the user's explicit model`)
        expectedCreatedModel = "test-model"
      }
    } else {
      assert.equal(await createdModelTrigger.isDisabled(), true, `created ${provider} model picker must stay harness-default`)
    }
    const createdPrompt = `${provider.toUpperCase()}-CREATED`
    await sendAndExpect(page, provider, createdComposer, createdPrompt)
    if (expectedCreatedModel) {
      const routed = [...promptBodies].reverse().find((entry) => entry.provider === provider && entry.body.text === createdPrompt)
      assert.equal(routed?.body?.model?.modelID, expectedCreatedModel, `created ${provider} Send did not carry the selected verified catalog model`)
    }

    // Every harness must prove the same lifecycle: Working -> Stop -> Ready -> reuse the exact Session.
    await createdComposer.fill(`${provider.toUpperCase()}-LONG`)
    await page.getByRole("button", { name: "Send" }).click()
    await page.locator(".tdw-conversation-state.working").waitFor({ state: "attached", timeout: 5_000 })
    const stopButton = page.getByRole("button", { name: /Stop/ })
    await stopButton.waitFor({ state: "visible", timeout: 5_000 })
    await stopButton.click()
    await page.locator(".tdw-conversation-state.stopped, .tdw-conversation-state.ready").waitFor({ state: "attached", timeout: 10_000 })
    assert.equal(stopBodies[stopBodies.length - 1]?.provider, provider, `${provider} Stop routed to the wrong provider`)
    await waitFor(async () => !(await createdComposer.isDisabled()), `${provider} composer enabled after Stop`)
    await sendAndExpect(page, provider, createdComposer, `${provider.toUpperCase()}-AFTER-STOP`)

    await loadHome(page)
    createdComposer = await openProvider(page, provider, title)
    await page.getByText(`${provider.toUpperCase()}-REPLY-${createdPrompt}`, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
    await page.getByText(`${provider.toUpperCase()}-REPLY-${provider.toUpperCase()}-AFTER-STOP`, { exact: true }).waitFor({ state: "visible", timeout: 15_000 })
    assert.equal(claims.get(created.id) || 0, 0, `${provider} reopen must remain observe-only until the user writes`)
    await sendAndExpect(page, provider, createdComposer, `${provider.toUpperCase()}-REOPEN`)
    if (info.transport === "acp") {
      assert.ok((claims.get(created.id) || 0) >= 1, `${provider} rediscovered ACP Session was not explicitly claimed before writing`)
    } else {
      assert.equal(claims.get(created.id) || 0, 0, `${provider} native HTTP Session must not invent an ACP claim step`)
    }
  }

  // All harnesses have now completed create, prompt, Stop, reuse and reopen.
  for (const [provider, info] of Object.entries(PROVIDERS)) {
    if (info.transport === "acp") {
      assert.ok((claims.get(`${provider}-session`) || 0) >= 1, `existing ${provider} ACP Session was never claimed`)
    } else {
      assert.equal(claims.get(`${provider}-session`) || 0, 0, `existing ${provider} HTTP Session must not invent an ACP claim step`)
    }
    assert.ok(promptBodies.filter((entry) => entry.provider === provider).length >= 5, `${provider} existing/create/Stop/reuse/reopen prompt coverage incomplete`)
    assert.ok(stopBodies.some((entry) => entry.provider === provider), `${provider} Stop was never routed`)
  }
  assert.deepEqual(pageErrors, [], `browser errors: ${pageErrors.join(" | ")}`)

  console.log("All-harness filter, model policy, existing Session prompt lifecycle, create, Stop and reopen browser smoke passed")
  await context.close()
} finally {
  for (const timer of timers) clearTimeout(timer)
  if (browser) await browser.close().catch(() => {})
  for (const response of sseResponses) { try { response.end() } catch {} }
  stopPreview(preview)
  stopServer(daemon)
}
