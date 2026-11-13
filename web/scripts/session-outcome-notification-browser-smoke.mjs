import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

/*
 * Production-browser check for web Session notifications.
 *
 * A Claude Code Session (no questions/permissions capability) works and then goes idle on the
 * daemon while the user is in another window. The web app must show one "Session ready"
 * notification naming the Session, and clicking it must open that Session. Before this, desktop and
 * web had no Ready/Failed notifications at all, and a click on a notification from a harness without
 * attention capabilities found no target to open.
 */

const PREVIEW_PORT = 4191
const DAEMON_PORT = 4437
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const DIRECTORY = "/work/notify"
const SESSION_ID = "notify-session-1"
const TITLE = "Notification smoke Session"

let status = "idle"

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Harness-Backend",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": "X-Has-More, X-Next-Cursor, X-Session-Model",
    "Access-Control-Max-Age": "600"
  }
}

function json(response, statusCode, value, extraHeaders = {}) {
  response.writeHead(statusCode, { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders })
  response.end(JSON.stringify(value))
}

const transcript = [
  { info: { id: "u1", role: "user", sessionID: SESSION_ID, time: { created: 1_000 } }, parts: [{ id: "u1t", type: "text", text: "NOTIFY-HISTORY-USER" }] },
  { info: { id: "a1", role: "assistant", sessionID: SESSION_ID, time: { created: 1_001, completed: 1_002 } }, parts: [{ id: "a1t", type: "text", text: "NOTIFY-HISTORY-REPLY" }] }
]

function startFakeDaemon() {
  const server = http.createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders())
      response.end()
      return
    }
    const url = new URL(request.url || "/", `http://127.0.0.1:${DAEMON_PORT}`)
    if (request.method === "GET" && url.pathname === "/v1/machine") {
      json(response, 200, {
        machine: { id: "machine-notify", name: "Notify Test", createdAt: new Date().toISOString() },
        agents: [{
          id: "claude", label: "Claude Code", backend: "claude", transport: "acp", managed: true, state: "available",
          capabilities: { sessions: true, prompt: true, abort: true, streaming: true, models: false, questions: false, permissions: false }
        }]
      })
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/projects") {
      json(response, 200, { projects: [{ id: "project-notify", machineId: "machine-notify", name: "notify", path: DIRECTORY, kind: "git", configured: true }] })
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/agents/claude/experimental/session") {
      json(response, 200, [{ id: SESSION_ID, title: TITLE, directory: DIRECTORY, time: { created: 1_000, updated: 2_000 } }])
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/agents/claude/session/status") {
      json(response, 200, { [SESSION_ID]: { type: status } })
      return
    }
    if (request.method === "GET" && url.pathname === `/v1/agents/claude/session/${SESSION_ID}/message`) {
      json(response, 200, transcript, { "X-Has-More": "0" })
      return
    }
    if (request.method === "GET" && url.pathname.includes("/global/event")) {
      response.writeHead(200, { ...corsHeaders(), "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
      response.write(": connected\n\n")
      return
    }
    if (request.method === "GET" && (url.pathname.includes("/question") || url.pathname.includes("/permission"))) {
      json(response, 200, [])
      return
    }
    if (request.method === "GET" && (url.pathname.endsWith("/capabilities") || url.pathname.endsWith("/models"))) {
      json(response, 200, url.pathname.endsWith("/models") ? { models: [], stale: false } : { attachments: false, commands: false })
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
    shell: process.platform === "win32",
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

async function waitFor(check, description, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function stopPreview(child) {
  if (!child || !child.pid) return
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"])
    else process.kill(-child.pid, "SIGTERM")
  } catch {}
}

const daemon = await startFakeDaemon()
const preview = startPreview()
let browser
try {
  await ready(APP_ORIGIN)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, locale: "en-US" })
  const page = await context.newPage()
  await page.addInitScript(({ key, port }) => {
    localStorage.setItem(key, JSON.stringify([{
      id: "machine-notify",
      name: "Notify Test",
      config: { backend: "claude", host: "127.0.0.1", port, username: "harness", password: "testpw" }
    }]))
    // The user turned notifications on and the browser granted the permission.
    localStorage.setItem("harness-remote.notifications.v1", JSON.stringify({ enabled: true, ready: true, failed: true, attention: true }))
    const shown = []
    window.__shownNotifications = shown
    class RecordingNotification {
      static permission = "granted"
      static requestPermission() { return Promise.resolve("granted") }
      constructor(title, options = {}) {
        this.title = title
        this.body = options.body
        this.onclick = null
        shown.push(this)
      }
      close() {}
    }
    window.Notification = RecordingNotification
    // The user is in another window.
    document.hasFocus = () => false
  }, { key: STORAGE_KEY, port: DAEMON_PORT })
  await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: new RegExp(TITLE) }).waitFor({ state: "visible", timeout: 20_000 })

  // An idle baseline announces nothing.
  await page.waitForTimeout(6_000)
  assert.equal(await page.evaluate(() => window.__shownNotifications.length), 0, "opening the app must not notify idle Sessions")

  // The turn runs long enough for one status poll to see it, then ends.
  status = "busy"
  await page.waitForTimeout(7_000)
  status = "idle"
  await waitFor(() => page.evaluate(() => window.__shownNotifications.length > 0), "the Session ready notification")
  await page.waitForTimeout(6_000)
  const shown = await page.evaluate(() => window.__shownNotifications.map((item) => ({ title: item.title, body: item.body })))
  assert.equal(shown.length, 1, "one turn produces one notification")
  assert.equal(shown[0].title, "Session ready")
  assert.match(shown[0].body, new RegExp(TITLE))
  assert.match(shown[0].body, /Notify Test · Claude Code/)

  // Clicking it opens that Session, although Claude Code has no questions or permissions.
  await page.evaluate(() => window.__shownNotifications[0].onclick?.())
  await page.getByText("NOTIFY-HISTORY-REPLY", { exact: true }).waitFor({ state: "visible", timeout: 20_000 })

  // Settings shows the switches, and turning Session ready off silences the next turn.
  await page.getByRole("button", { name: /Settings/ }).first().click()
  const readySwitch = page.locator("[data-notifications-ready]")
  await readySwitch.waitFor({ state: "visible", timeout: 10_000 })
  assert.equal(await page.locator("[data-notifications-enabled]").isChecked(), true)
  if (process.env.SCREENSHOTS) {
    await page.locator("[data-settings-notifications]").scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${process.env.SCREENSHOTS}/notification-settings.png` })
  }
  await readySwitch.uncheck()
  status = "busy"
  await page.waitForTimeout(7_000)
  status = "idle"
  await page.waitForTimeout(8_000)
  assert.equal(await page.evaluate(() => window.__shownNotifications.length), 1, "Session ready turned off must not notify")

  console.log("session outcome notification browser smoke passed")
} finally {
  await browser?.close()
  stopPreview(preview)
  try { daemon.closeAllConnections?.() } catch {}
  daemon.close()
}
