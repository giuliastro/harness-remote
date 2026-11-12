import assert from "node:assert/strict"
import http from "node:http"
import { mkdirSync } from "node:fs"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

/*
 * Production-browser check for the per-harness loading indicator in the Session list.
 *
 * One harness answers at once; the other does not answer within the discovery budget and only
 * succeeds on a later attempt. Before this indicator, the machine showed its green dot and an empty
 * list for as long as the slow harness took, with nothing saying that Sessions were still coming.
 * Run with SCREENSHOTS=<dir> to capture each stage at phone and desktop width.
 */

const PREVIEW_PORT = 4187
const DAEMON_PORT = 4433
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const SCREENSHOTS = process.env.SCREENSHOTS || ""

let slowRequests = 0

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": APP_ORIGIN,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Harness-Backend",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "600"
  }
}

function json(response, statusCode, value, extraHeaders = {}) {
  response.writeHead(statusCode, { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders })
  response.end(JSON.stringify(value))
}

function agent(id, label) {
  return {
    id,
    label,
    backend: id,
    transport: "acp",
    managed: true,
    state: "available",
    capabilities: { sessions: true, prompt: true, abort: true, streaming: true, models: true }
  }
}

function session(id, title) {
  return { id, title, directory: "/work/loading-indicator", time: { created: 1_000, updated: 2_000 } }
}

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
        machine: { id: "machine-loading", name: "Loading Test", createdAt: new Date().toISOString() },
        agents: [agent("claude", "Claude Code"), agent("deepseek", "DeepSeek Harness")]
      })
      return
    }
    if (request.method === "GET" && url.pathname === "/v1/projects") {
      json(response, 200, { projects: [] })
      return
    }
    const list = /^\/v1\/agents\/([^/]+)\/experimental\/session$/.exec(url.pathname)
    if (request.method === "GET" && list) {
      if (list[1] === "claude") {
        json(response, 200, [session("claude-1", "Fast harness Session")])
        return
      }
      // A cold adapter: the first read outlives the 8 s discovery budget, later reads answer.
      slowRequests += 1
      if (slowRequests === 1) {
        setTimeout(() => { if (!response.writableEnded) json(response, 200, []) }, 12_000)
        return
      }
      json(response, 200, [session("deepseek-1", "Slow harness Session")])
      return
    }
    if (request.method === "GET" && /\/session\/status$/.test(url.pathname)) {
      json(response, 200, {})
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

function stopPreview(child) {
  if (!child || !child.pid) return
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"])
    else process.kill(-child.pid, "SIGTERM")
  } catch {}
}

async function waitFor(check, description, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { if (await check()) return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function shoot(page, name) {
  if (!SCREENSHOTS) return
  mkdirSync(SCREENSHOTS, { recursive: true })
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png` })
}

async function run(browser, viewport, tag) {
  slowRequests = 0
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: "en-US" })
  const page = await context.newPage()
  await page.addInitScript(({ key, port }) => {
    localStorage.setItem(key, JSON.stringify([{
      id: "machine-loading",
      name: "Loading Test",
      config: { backend: "claude", host: "127.0.0.1", port, username: "harness", password: "testpw" }
    }]))
  }, { key: STORAGE_KEY, port: DAEMON_PORT })
  await page.goto(APP_ORIGIN, { waitUntil: "domcontentloaded" })

  const loadingRow = page.locator(".hr-native-machine-loading", { hasText: "DeepSeek Harness" }).first()
  await loadingRow.waitFor({ state: "visible", timeout: 15_000 })
  assert.match(await loadingRow.innerText(), /Loading Sessions: .*DeepSeek Harness/)
  await shoot(page, `${tag}-1-loading`)

  const retryRow = page.locator(".hr-native-machine-loading.retrying", { hasText: "DeepSeek Harness" })
  await retryRow.waitFor({ state: "visible", timeout: 20_000 })
  // The fast harness is on screen while the slow one is still being retried.
  const machineCount = page.locator(".hr-native-machine-metrics small").first()
  await waitFor(async () => (await machineCount.innerText()).trim() === "1", "the fast harness Session counted")
  assert.equal(await page.locator(".hr-native-machine-loading:not(.retrying)").count(), 0)
  await shoot(page, `${tag}-2-retrying`)

  await waitFor(async () => (await machineCount.innerText()).trim() === "2", "the slow harness Session counted", 40_000)
  await page.locator(".hr-native-machine-loading").first().waitFor({ state: "detached", timeout: 5_000 })
  await shoot(page, `${tag}-3-loaded`)
  await context.close()
}

const daemon = await startFakeDaemon()
const preview = startPreview()
let browser
try {
  await ready(APP_ORIGIN)
  browser = await chromium.launch()
  await run(browser, { width: 390, height: 820 }, "phone")
  await run(browser, { width: 1366, height: 768 }, "desktop")
  console.log("session loading indicator browser smoke passed")
} finally {
  await browser?.close()
  stopPreview(preview)
  try { daemon.closeAllConnections?.() } catch {}
  daemon.close()
}
