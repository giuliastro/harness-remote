import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const ZEN_KEY = process.env.OPENCODE_ZEN_API_KEY?.trim()
if (!ZEN_KEY) throw new Error("OPENCODE_ZEN_API_KEY is required")

const DAEMON_PORT = 4497
const OPENCODE_PORT = 4496
const PREVIEW_PORT = 4189
const ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const USERNAME = "harness"
const PASSWORD = "live-zen-release-gate"
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const TITLE = `Live Existing OpenCode ${Date.now()}`
const TOKENS = [
  "EXISTING-SESSION-SEED",
  "LIVE-CONTINUE-1",
  "LIVE-CONTINUE-2",
  "LIVE-CONTINUE-3",
  "LIVE-AFTER-RELOAD",
  "LIVE-AFTER-DAEMON-RESTART"
]
const FREE_IDS = [
  "mimo-v2.5-free",
  "deepseek-v4-flash-free",
  "north-mini-code-free",
  "nemotron-3-ultra-free",
  "laguna-s-2.1-free",
  "ling-3.0-tiny-free",
  "longcat-2.0-free",
  "big-pickle"
]

const repo = fileURLToPath(new URL("../..", import.meta.url))
const webDir = path.join(repo, "web")
const daemonCLI = path.join(repo, "bridge", "src", "daemon-cli.js")
const viteCLI = path.join(webDir, "node_modules", "vite", "bin", "vite.js")
const artifacts = path.join(webDir, "browser-artifacts")
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hr-live-zen-"))
const home = path.join(temp, "home")
const project = path.join(temp, "project")
const state = path.join(temp, "state")
const configDir = path.join(home, ".config", "opencode")
const dataDir = path.join(home, ".local", "share", "opencode")
const authFile = path.join(dataDir, "auth.json")

for (const directory of [project, state, configDir, dataDir, artifacts]) fs.mkdirSync(directory, { recursive: true })
fs.writeFileSync(path.join(project, "README.md"), "# Synthetic Harness Remote live OpenCode project\n")
try { execFileSync("git", ["init", "-q", project]) } catch {}
fs.writeFileSync(authFile, `${JSON.stringify({ opencode: { type: "api", key: ZEN_KEY } }, null, 2)}\n`, { mode: 0o600 })
fs.writeFileSync(path.join(configDir, "opencode.json"), `${JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2)}\n`)

const childEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share") }
delete childEnv.OPENCODE_ZEN_API_KEY

let daemon = null
let preview = null
let browser = null
let context = null
let page = null
let machineID = ""
let sessionID = ""
let chosenModel = null
let daemonLog = ""
let probeAttempts = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const redact = (value) => String(value ?? "").split(ZEN_KEY).join("[REDACTED]")
const basic = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`

async function waitFor(label, fn, timeout = 30_000, interval = 250) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      const result = await fn()
      if (result) return result
    } catch (error) { last = error }
    await sleep(interval)
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ""}`)
}

async function request(route, { method = "GET", body, timeout = 30_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(`http://127.0.0.1:${DAEMON_PORT}${route}`, {
      method,
      headers: { Authorization: basic, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    })
    const text = await response.text()
    let payload = text
    try { payload = text ? JSON.parse(text) : true } catch {}
    if (!response.ok) throw new Error(`${method} ${route} -> ${response.status}: ${redact(text).slice(0, 1200)}`)
    return payload
  } finally { clearTimeout(timer) }
}

function killTree(child) {
  if (!child?.pid || child.killed) return
  try { process.kill(-child.pid, "SIGTERM") } catch { try { child.kill("SIGTERM") } catch {} }
}

async function startDaemon() {
  daemonLog = ""
  daemon = spawn(process.execPath, [
    daemonCLI,
    "--backend", "codex",
    "--host", "127.0.0.1",
    "--port", String(DAEMON_PORT),
    "--username", USERNAME,
    "--password", PASSWORD,
    "--root", project,
    "--state-dir", state,
    "--cors", ORIGIN,
    "--opencode-port", String(OPENCODE_PORT),
    "--opencode-timeout", "60000"
  ], { cwd: repo, env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" })
  for (const [stream, prefix] of [[daemon.stdout, "[stdout] "], [daemon.stderr, "[stderr] "]]) {
    stream.on("data", (chunk) => { daemonLog = `${daemonLog}${prefix}${redact(chunk)}`.slice(-120_000) })
  }
  const snapshot = await waitFor("Harness daemon", async () => {
    if (daemon.exitCode != null) throw new Error(`daemon exited ${daemon.exitCode}: ${daemonLog}`)
    try { return await request("/v1/machine", { timeout: 2_000 }) } catch { return null }
  }, 45_000)
  machineID = snapshot?.machine?.id || snapshot?.id || machineID
  assert.ok(machineID, "machine id missing")
}

async function stopDaemon() {
  const child = daemon
  daemon = null
  if (!child) return
  killTree(child)
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(5_000)])
}

async function createSession(title) {
  const result = await request(`/v1/agents/opencode/session?directory=${encodeURIComponent(project)}`, { method: "POST", body: { title }, timeout: 60_000 })
  const id = result?.id || result?.sessionID || result?.sessionId
  assert.ok(id, `session id missing: ${JSON.stringify(result)}`)
  return id
}

async function transcript(id) {
  const result = await request(`/v1/agents/opencode/session/${encodeURIComponent(id)}/message?directory=${encodeURIComponent(project)}&limit=120`, { timeout: 15_000 })
  return Array.isArray(result) ? result : Array.isArray(result?.messages) ? result.messages : []
}

function nativeFinal(messages, token) {
  return messages.find((message) => message?.info?.role === "assistant" && (message.parts || []).some((part) => part?.type === "text" && String(part.text || "").includes(token))) || null
}

async function directPrompt(id, model, token, suffix) {
  await request(`/v1/agents/opencode/session/${encodeURIComponent(id)}/prompt`, {
    method: "POST",
    body: {
      clientRequestId: `live-${suffix}-${Date.now()}`,
      text: `Reply with exactly ${token} and nothing else.`,
      directory: project,
      model: { providerID: model.providerID, modelID: model.modelID }
    },
    timeout: 30_000
  })
  return waitFor(`${token} native final`, async () => {
    const current = await transcript(id)
    return nativeFinal(current, token) ? current : null
  }, 90_000, 1_000)
}

async function stopSession(id) {
  try {
    await request(`/v1/agents/opencode/session/${encodeURIComponent(id)}/stop`, { method: "POST", body: { directory: project, clientRequestId: `stop-${Date.now()}` }, timeout: 10_000 })
  } catch {}
}

function freeModels(catalog) {
  const models = Array.isArray(catalog?.models) ? catalog.models : Array.isArray(catalog) ? catalog : []
  const rank = (model) => {
    const exact = FREE_IDS.indexOf(model.modelID)
    if (exact >= 0) return exact
    return `${model.modelID} ${model.modelName || ""} ${model.name || ""}`.toLowerCase().includes("free") ? FREE_IDS.length : 9999
  }
  return models.filter((model) => model?.providerID && model?.modelID && rank(model) < 9999).sort((a, b) => rank(a) - rank(b))
}

async function pickResponsiveModel() {
  const catalog = await request("/v1/agents/opencode/models", { timeout: 90_000 })
  const candidates = freeModels(catalog)
  assert.ok(candidates.length, `no Zen free model in catalog: ${JSON.stringify(catalog).slice(0, 3000)}`)
  for (const model of candidates.slice(0, 8)) {
    const id = await createSession(`Zen probe ${model.modelID} ${Date.now()}`)
    const token = `ZEN-PROBE-${Math.random().toString(36).slice(2, 9).toUpperCase()}`
    const started = Date.now()
    try {
      await directPrompt(id, model, token, model.modelID)
      probeAttempts.push({ model: `${model.providerID}/${model.modelID}`, ok: true, ms: Date.now() - started })
      return { providerID: model.providerID, modelID: model.modelID, modelName: model.modelName || model.name || model.modelID }
    } catch (error) {
      probeAttempts.push({ model: `${model.providerID}/${model.modelID}`, ok: false, ms: Date.now() - started, error: redact(error.message).slice(0, 400) })
      await stopSession(id)
    }
  }
  throw new Error(`all free models failed probe: ${JSON.stringify(probeAttempts)}`)
}

function startPreview() {
  return spawn(process.execPath, [viteCLI, "preview", "--host", "127.0.0.1", "--port", String(PREVIEW_PORT), "--strictPort"], {
    cwd: webDir, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32"
  })
}

async function seedBrowser(targetPage) {
  await targetPage.addInitScript(({ key, machineID, port, username, password }) => {
    localStorage.setItem(key, JSON.stringify([{ id: machineID, name: "Live OpenCode CI machine", config: { backend: "codex", host: "127.0.0.1", port, username, password } }]))
  }, { key: STORAGE_KEY, machineID, port: DAEMON_PORT, username: USERNAME, password: PASSWORD })
}

async function openSession(targetPage) {
  await targetPage.locator('.hr-native-home[aria-label="Sessions"]').waitFor({ state: "visible", timeout: 30_000 })
  await targetPage.getByRole("button", { name: new RegExp(TITLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click()
  await targetPage.locator(".hr-native-session-observer").waitFor({ state: "visible", timeout: 20_000 })
  await targetPage.locator(".tdw-work-thread-conversation").waitFor({ state: "visible", timeout: 20_000 })
  await targetPage.locator(".uw-composer-shell").waitFor({ state: "visible", timeout: 20_000 })
  await targetPage.getByText("Loading conversation…", { exact: true }).waitFor({ state: "detached", timeout: 30_000 }).catch(() => {})
}

async function waitReady(targetPage, timeout = 120_000) {
  await targetPage.locator(".tdw-conversation-state.ready").waitFor({ state: "attached", timeout })
  const composer = targetPage.getByRole("textbox", { name: "Message OpenCode" })
  await composer.waitFor({ state: "visible", timeout: 20_000 })
  await waitFor("enabled composer", async () => !(await composer.isDisabled()), 20_000, 150)
}

const finalLocator = (targetPage, token) => targetPage.locator(".uw-message-agent:not(.uw-message-pending) .uw-message-content-group .uw-markdown").filter({ hasText: token })
const reasoningLocator = (targetPage, token) => targetPage.locator(".uw-message-agent .hr-activity .hr-act-thought").filter({ hasText: token })

async function waitVisibleFinal(targetPage, token, timeout = 30_000) {
  const locator = finalLocator(targetPage, token)
  await locator.waitFor({ state: "visible", timeout })
  assert.equal(await locator.count(), 1, `${token}: final missing or duplicated`)
}

async function verifySelectedModel(targetPage) {
  const trigger = targetPage.locator(".tdw-model-trigger")
  await trigger.waitFor({ state: "visible", timeout: 20_000 })
  const expected = chosenModel.modelName || chosenModel.modelID
  const text = await waitFor("native model enrichment", async () => {
    const current = await trigger.innerText()
    if (current.includes("Loading models…")) return null
    return current.includes(expected) || current.includes(chosenModel.modelID) ? current : null
  }, 45_000, 250)
  assert.ok(text, `expected native model ${expected}`)
}

async function sendUI(token) {
  await waitReady(page)
  const composer = page.getByRole("textbox", { name: "Message OpenCode" })
  await composer.fill(`Reply with exactly ${token} and nothing else.`)
  const send = page.getByRole("button", { name: "Send" })
  await waitFor("enabled Send", async () => !(await send.isDisabled()), 15_000, 100)
  await send.click()
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (await finalLocator(page, token).count()) {
      await waitReady(page, 30_000)
      assert.equal(await finalLocator(page, token).count(), 1, `${token}: UI final duplicated`)
      return
    }
    if (await page.locator(".tdw-conversation-state.ready").count() && await reasoningLocator(page, token).count()) {
      throw new Error(`${token}: Ready with requested output only in reasoning/activity, no final answer`)
    }
    await page.waitForTimeout(400)
  }
  const native = await transcript(sessionID)
  if (!nativeFinal(native, token)) throw new Error(`${token}: OpenCode itself produced no durable final within 120s`)
  throw new Error(`${token}: OpenCode persisted the final but Harness Remote never rendered it`)
}

async function diagnostics(reason) {
  const data = {
    reason,
    opencodeVersion: process.env.OPENCODE_TEST_VERSION || "unknown",
    chosenModel,
    probeAttempts,
    machineID,
    sessionID,
    daemonLog: redact(daemonLog),
    bodyText: page ? redact(await page.locator("body").innerText().catch(() => "")) : "",
    transcript: sessionID ? await transcript(sessionID).catch((error) => [{ diagnosticError: redact(error.message) }]) : []
  }
  fs.writeFileSync(path.join(artifacts, "live-opencode-release-diagnostics.json"), `${JSON.stringify(data, null, 2)}\n`)
  if (page) await page.screenshot({ path: path.join(artifacts, "live-opencode-release-failure.png"), fullPage: true }).catch(() => {})
}

try {
  console.log("release gate: start real Harness Remote + OpenCode")
  await startDaemon()
  chosenModel = await pickResponsiveModel()
  console.log(`release gate: responsive Zen model ${chosenModel.providerID}/${chosenModel.modelID}`)

  // Create and exercise the native Session before the browser ever sees it. This reproduces the
  // important product boundary: an existing OpenCode Session is authoritative and HR must continue it.
  sessionID = await createSession(TITLE)
  await directPrompt(sessionID, chosenModel, TOKENS[0], "seed")
  console.log(`release gate: pre-existing native Session ${sessionID} seeded outside the UI`)

  preview = startPreview()
  await waitFor("Vite preview", async () => { try { return (await fetch(ORIGIN)).ok } catch { return false } }, 30_000)
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: "en-US" })
  page = await context.newPage()
  await seedBrowser(page)
  await page.goto(ORIGIN, { waitUntil: "domcontentloaded" })
  await openSession(page)
  await waitVisibleFinal(page, TOKENS[0], 30_000)
  await verifySelectedModel(page)

  console.log("release gate: existing Session continuation turns 1-3")
  await sendUI(TOKENS[1])
  await sendUI(TOKENS[2])
  await sendUI(TOKENS[3])

  console.log("release gate: browser reload/remount")
  await page.reload({ waitUntil: "domcontentloaded" })
  await openSession(page)
  for (const token of TOKENS.slice(0, 4)) await waitVisibleFinal(page, token, 30_000)
  await verifySelectedModel(page)
  await sendUI(TOKENS[4])

  console.log("release gate: full daemon/managed-OpenCode restart")
  await stopDaemon()
  await startDaemon()
  await page.reload({ waitUntil: "domcontentloaded" })
  await openSession(page)
  for (const token of TOKENS.slice(0, 5)) await waitVisibleFinal(page, token, 30_000)
  await verifySelectedModel(page)
  await sendUI(TOKENS[5])

  const native = await transcript(sessionID)
  for (const token of TOKENS) {
    assert.ok(nativeFinal(native, token), `${token}: native durable final missing at end`)
    assert.equal(await finalLocator(page, token).count(), 1, `${token}: UI final missing/duplicated at end`)
  }
  assert.equal(await page.locator(".uw-message-pending").count(), 0, "pending assistant row remains")
  assert.equal(await page.locator(".tdw-conversation-state.working").count(), 0, "Session remains Working")
  assert.equal(await page.locator(".hr-activity.is-running").count(), 0, "Activity remains running")

  await page.screenshot({ path: path.join(artifacts, "live-opencode-release-passed.png"), fullPage: true })
  fs.writeFileSync(path.join(artifacts, "live-opencode-release-result.json"), `${JSON.stringify({ status: "passed", opencodeVersion: process.env.OPENCODE_TEST_VERSION || "unknown", chosenModel, probeAttempts, sessionID, turns: TOKENS.length }, null, 2)}\n`)
  console.log("release gate: PASS — existing native Session, five continuations, remount and daemon restart")
} catch (error) {
  const reason = redact(error?.stack || error)
  console.error(`release gate: FAIL — ${reason}`)
  await diagnostics(reason).catch(() => {})
  process.exitCode = 1
} finally {
  if (context) await context.close().catch(() => {})
  if (browser) await browser.close().catch(() => {})
  killTree(preview)
  await stopDaemon().catch(() => {})
  try { fs.rmSync(authFile, { force: true }) } catch {}
  try { fs.rmSync(temp, { recursive: true, force: true }) } catch {}
}
