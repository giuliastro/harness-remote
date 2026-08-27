import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const PREVIEW_PORT = 4174
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const OUT = path.resolve("browser-artifacts")
const USER = "harness"
const PASSWORD = "testpw"
const now = new Date().toISOString()

const agentDefinitions = [
  ["opencode", "OpenCode", "http"],
  ["omp", "Oh My Pi", "acp"],
  ["pi", "PI", "acp"],
  ["codex", "Codex CLI", "acp"],
  ["claude", "Claude Code", "acp"]
]

function agents() {
  return agentDefinitions.map(([id, label, transport]) => ({
    id,
    label,
    backend: id,
    transport,
    managed: true,
    state: "available",
    capabilities: {
      sessions: true,
      prompt: true,
      abort: true,
      streaming: true,
      models: true,
      filesystemBrowser: true,
      commands: true
    }
  }))
}

const fixtures = [
  {
    id: "machine-a-controls",
    name: "Windows Workstation",
    port: 4411,
    project: { id: "project-a-controls", machineId: "machine-a-controls", name: "harness-win", path: "C:\\work\\harness-win", kind: "git", configured: true },
    conversation: {
      id: "conversation-a-controls",
      machineId: "machine-a-controls",
      projectId: "project-a-controls",
      project: { name: "harness-win", path: "C:\\work\\harness-win", kind: "git" },
      title: "Audit Windows UI",
      agentId: "pi",
      prompt: "Audit the Windows UI",
      model: null,
      status: "completed",
      workspace: { mode: "project", path: "C:\\work\\harness-win" },
      run: null,
      runs: [],
      error: null,
      finishedAt: null,
      createdAt: now,
      updatedAt: now
    }
  },
  {
    id: "machine-b-controls",
    name: "Linux Workstation",
    port: 4412,
    project: { id: "project-b-controls", machineId: "machine-b-controls", name: "harness-linux", path: "/work/harness-linux", kind: "git", configured: true },
    conversation: {
      id: "conversation-b-controls",
      machineId: "machine-b-controls",
      projectId: "project-b-controls",
      project: { name: "harness-linux", path: "/work/harness-linux", kind: "git" },
      title: "Audit Linux UI",
      agentId: "codex",
      prompt: "Audit the Linux UI",
      model: null,
      status: "completed",
      workspace: { mode: "project", path: "/work/harness-linux" },
      run: null,
      runs: [],
      error: null,
      finishedAt: null,
      createdAt: now,
      updatedAt: now
    }
  }
]

function headers() {
  return {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS"
  }
}

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers() })
  response.end(JSON.stringify(value))
}

function fakeDaemon(fixture) {
  const server = http.createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers())
      response.end()
      return
    }
    const url = new URL(request.url || "/", `http://127.0.0.1:${fixture.port}`)
    if (request.method === "GET" && url.pathname === "/v1/machine") {
      json(response, 200, { machine: { id: fixture.id, name: fixture.name, createdAt: now }, agents: agents() })
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/projects") {
      json(response, 200, { projects: [fixture.project] })
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/work-threads") {
      json(response, 200, { workThreads: [fixture.conversation] })
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/tasks") {
      json(response, 200, { tasks: [fixture.conversation] })
      return
    }
    if (request.method === "GET" && url.pathname === `/v1/work-threads/${fixture.conversation.id}`) {
      json(response, 200, fixture.conversation)
      return
    }
    const model = /^\/v1\/agents\/([^/]+)\/models$/.exec(url.pathname)
    if (request.method === "GET" && model) {
      const id = decodeURIComponent(model[1])
      const label = agentDefinitions.find(([candidate]) => candidate === id)?.[1] || id
      json(response, 200, {
        models: [{ providerID: id, providerName: label, modelID: `${id}-model`, modelName: `${label} Model`, isDefault: true, contextLimit: 128000 }],
        stale: false,
        refreshedAt: now
      })
      return
    }
    json(response, 404, { error: `No fake route for ${request.method} ${url.pathname}` })
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(fixture.port, "127.0.0.1", () => resolve(server))
  })
}

function preview() {
  const command = process.platform === "win32" ? "npm.cmd" : "npm"
  return spawn(command, ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(PREVIEW_PORT), "--strictPort"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  })
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

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false })
}

async function insideViewport(page, locator, label) {
  await locator.waitFor({ state: "visible" })
  const box = await locator.boundingBox()
  const viewport = page.viewportSize()
  assert.ok(box && viewport, `${label}: no geometry`)
  assert.ok(box.x >= -1 && box.y >= -1, `${label}: starts outside viewport`)
  assert.ok(box.x + box.width <= viewport.width + 1, `${label}: clipped horizontally`)
  assert.ok(box.y + box.height <= viewport.height + 1, `${label}: clipped vertically`)
}

async function waitForDrawerSettled(page) {
  await page.waitForFunction(() => {
    const workspace = document.querySelector(".tdw-project-column")
    const drawer = document.querySelector(".tdw-thread-column")
    if (!workspace || !drawer) return false
    const workspaceBox = workspace.getBoundingClientRect()
    const drawerBox = drawer.getBoundingClientRect()
    const style = getComputedStyle(drawer)
    return drawerBox.left >= workspaceBox.right - 1 && Number(style.opacity) >= 0.999 && style.visibility === "visible"
  })
}

async function noOverflow(page, label) {
  const result = await page.evaluate(() => ({
    width: innerWidth,
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth
  }))
  assert.ok(result.doc <= result.width + 1, `${label}: document width ${result.doc} > ${result.width}`)
  assert.ok(result.body <= result.width + 1, `${label}: body width ${result.body} > ${result.width}`)
}

async function seed(page) {
  await page.addInitScript(({ key, fixtures, user, password }) => {
    localStorage.setItem(key, JSON.stringify(fixtures.map((fixture) => ({
      id: fixture.id,
      name: fixture.name,
      config: { backend: "opencode", host: "127.0.0.1", port: fixture.port, username: user, password }
    }))))
  }, { key: STORAGE_KEY, fixtures, user: USER, password: PASSWORD })
}

async function assertSessionFirstHome(page, mobile) {
  const sessions = page.locator('.hr-native-workspace[aria-label="Sessions"]')
  await sessions.waitFor({ state: "visible" })
  if (mobile) {
    const sessionsButton = page.locator(".hr-mobile-nav").getByRole("button", { name: /Sessions/ })
    await sessionsButton.waitFor({ state: "visible" })
    assert.equal(await sessionsButton.getAttribute("aria-current"), "page", "Sessions must be the mobile product entry")
  } else {
    await sessions.getByText("Sessions", { exact: true }).first().waitFor({ state: "visible" })
  }
  await noOverflow(page, mobile ? "Session-first mobile home" : "Session-first desktop home")
}

async function assertConfiguredMachines(page, label) {
  const groups = page.locator(".hr-native-machine-group")
  await groups.filter({ hasText: fixtures[0].name }).waitFor({ state: "visible" })
  await groups.filter({ hasText: fixtures[1].name }).waitFor({ state: "visible" })
  assert.equal(await groups.count(), 2, `${label}: every configured machine must remain visible`)
}

async function newSessionAudit(page, label) {
  await page.getByRole("button", { name: "New Session" }).click()
  const group = page.getByRole("group", { name: "Create native Session" })
  await group.waitFor({ state: "visible" })

  const machine = group.locator(".hr-native-create-machine select")
  const project = group.getByLabel("Project")
  const agent = group.getByLabel("Coding agent")
  const title = group.getByLabel("Title optional")
  const cancel = group.getByRole("button", { name: "Cancel" })
  const create = group.getByRole("button", { name: /Create Session/ })
  for (const [locator, name] of [[machine, "Machine"], [project, "Project"], [agent, "Coding agent"], [title, "Title"], [cancel, "Cancel"], [create, "Create Session"]]) {
    await locator.waitFor({ state: "visible" })
    await locator.scrollIntoViewIfNeeded()
    await insideViewport(page, locator, `${label} ${name}`)
  }

  assert.equal(await machine.locator("option").count(), 2, `${label}: New Session must expose both configured machines`)
  assert.equal(await project.locator("option").count(), 1, `${label}: Project choices must be scoped to the selected machine`)
  assert.equal(await agent.locator("option").count(), agentDefinitions.length, `${label}: New Session must expose every create-capable harness on the selected machine`)
  await machine.selectOption(fixtures[1].id)
  const switchedProject = project.locator("option").filter({ hasText: fixtures[1].project.name })
  await switchedProject.waitFor({ state: "attached" })
  assert.equal(await project.locator("option").count(), 1, `${label}: switching machine must replace the Project scope instead of mixing machines`)
  assert.equal(await project.inputValue(), `${fixtures[1].id}:${fixtures[1].project.id}`, `${label}: switching machine must select that machine's Project`)
  await title.fill("Session-first UI audit")
  assert.equal(await create.isDisabled(), false, `${label}: a valid Project and agent must enable Create Session`)
  await noOverflow(page, `${label} New Session`)
  await shot(page, `${label}-new-session`)
  await cancel.click()
  await group.waitFor({ state: "hidden" })
}

async function runMobile(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await seed(page)
  await page.goto(APP_ORIGIN, { waitUntil: "networkidle" })
  await assertSessionFirstHome(page, true)
  await assertConfiguredMachines(page, "portrait")
  await shot(page, "portrait-sessions-home")
  await noOverflow(page, "portrait Session Home")
  await newSessionAudit(page, "portrait")

  await page.locator(".hr-mobile-nav").getByRole("button", { name: /Machines/ }).click()
  await page.locator(".uw-machine-manager").waitFor({ state: "visible" })
  await shot(page, "portrait-machines")
  await noOverflow(page, "portrait Machines")
  await page.locator(".hr-mobile-nav").getByRole("button", { name: /Sessions/ }).click()
  await page.locator(".uw-machine-manager").waitFor({ state: "hidden" })

  await page.locator(".hr-mobile-nav").getByRole("button", { name: /Settings/ }).click()
  const settings = page.locator(".hr-session-settings-page")
  await settings.waitFor({ state: "visible" })
  assert.equal(await settings.locator("select").nth(0).locator("option").count(), 3, "mobile Settings must expose system, light and dark themes")
  assert.ok(await settings.locator("select").nth(1).locator("option").count() >= 4, "mobile Settings must expose every supported language")
  await shot(page, "portrait-settings")
  await noOverflow(page, "portrait Settings")
  await page.locator(".hr-mobile-nav").getByRole("button", { name: /Sessions/ }).click()
  await settings.waitFor({ state: "hidden" })

  await page.setViewportSize({ width: 844, height: 390 })
  await page.waitForTimeout(200)
  await assertSessionFirstHome(page, true)
  await assertConfiguredMachines(page, "landscape")
  await shot(page, "landscape-sessions-home")
  await noOverflow(page, "landscape Session Home")
  await newSessionAudit(page, "landscape")
  await context.close()
}

async function runDesktop(browser) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await seed(page)
  await page.goto(APP_ORIGIN, { waitUntil: "networkidle" })
  await assertSessionFirstHome(page, false)
  await assertConfiguredMachines(page, "desktop")
  await shot(page, "desktop-sessions-home")
  await noOverflow(page, "desktop Session Home")
  await newSessionAudit(page, "desktop")

  await page.getByRole("button", { name: "Settings" }).click()
  const settings = page.locator(".hr-session-settings-page")
  await settings.waitFor({ state: "visible" })
  await insideViewport(page, settings, "desktop Settings")
  assert.equal(await settings.locator("select").nth(0).locator("option").count(), 3, "desktop Settings must expose system, light and dark themes")
  assert.ok(await settings.locator("select").nth(1).locator("option").count() >= 4, "desktop Settings must expose every supported language")
  await shot(page, "desktop-settings")
  await settings.locator("header button").click()
  await settings.waitFor({ state: "hidden" })

  await page.getByRole("button", { name: /Machines/ }).click()
  await page.locator(".uw-machine-manager").waitFor({ state: "visible" })
  await shot(page, "desktop-machines")
  await noOverflow(page, "desktop Machines")
  await page.locator(".uw-manager-close").click()
  await context.close()
}

await mkdir(OUT, { recursive: true })
const servers = []
let vite
let browser
try {
  for (const fixture of fixtures) servers.push(await fakeDaemon(fixture))
  vite = preview()
  await ready(APP_ORIGIN)
  browser = await chromium.launch({ headless: true })
  console.log("v3 browser controls smoke: Session-first mobile entry audit start")
  await runMobile(browser)
  console.log("v3 browser controls smoke: mobile controls audit passed")
  await runDesktop(browser)
  console.log("v3 browser controls smoke: desktop controls audit passed")
  console.log("v3 browser controls smoke: Session-first multi-machine, Settings, New Session and screenshots passed")
} finally {
  if (browser) await browser.close().catch(() => {})
  stopPreview(vite)
  for (const server of servers) stopServer(server)
}
