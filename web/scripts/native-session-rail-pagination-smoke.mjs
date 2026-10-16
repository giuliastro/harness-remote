import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const origin = "http://127.0.0.1:4198"
const daemons = []
const requests = []
let failA = true
let preview
let browser
const sessions = (machine, older = false) => Array.from({ length: older ? 1 : 36 }, (_, index) => ({
  id: `${machine}-${older ? "older" : index}`, title: `${machine} ${older ? "older" : `Session ${index}`}`,
  directory: `/work/project-${Math.floor(index / 3)}`, status: { type: "idle" }, time: { created: 1000 + index, updated: 1000 + index }
}))
async function startDaemon(machine) {
  const server = http.createServer((request, response) => {
    const headers = { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Harness-Backend", "Access-Control-Expose-Headers": "x-next-cursor" }
    function json(status, value, cursor) {
      response.writeHead(status, { ...headers, "Content-Type": "application/json", ...(cursor ? { "x-next-cursor": cursor } : {}) })
      response.end(JSON.stringify(value))
    }
    if (request.method === "OPTIONS") { response.writeHead(204, headers); response.end(); return }
    const url = new URL(request.url, "http://localhost")
    if (url.pathname === "/v1/machine") return json(200, {
      machine: { id: machine, name: `Machine ${machine}` },
      agents: [{ id: "codex", label: "Codex", backend: "codex", transport: "acp", state: "available", capabilities: { sessions: true, prompt: true } }]
    })
    if (url.pathname === "/v1/projects") return json(200, { projects: Array.from({ length: 12 }, (_, index) => ({ id: `project-${index}`, name: `Project ${index}`, path: `/work/project-${index}`, configured: true })) })
    if (url.pathname.endsWith("/experimental/session")) {
      const cursor = url.searchParams.get("cursor")
      if (!cursor) return json(200, sessions(machine), machine === "C" ? undefined : `${machine}1`)
      requests.push({ machine, cursor })
      if (cursor === "A1") return json(200, [], "A2") // Empty page with a valid continuation.
      if (cursor === "A2" && failA) { failA = false; return json(500, { error: "Temporary listing failure" }) }
      return json(200, sessions(machine, true))
    }
    if (url.pathname.endsWith("/session/status")) return json(200, {})
    if (url.pathname.endsWith("/permission") || url.pathname.endsWith("/question")) return json(200, [])
    return json(404, { error: "Fixture route unavailable" })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  daemons.push(server)
  return { id: machine, name: `Machine ${machine}`, config: { backend: "codex", host: "127.0.0.1", port: server.address().port, username: "test", password: "test" } }
}
async function waitFor(check) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 40)) }
  throw Error("UI condition timed out")
}
async function assertScroll(page) {
  const heading = page.locator(".hr-native-home-heading"), filters = page.locator(".hr-native-home-tools")
  const before = [await heading.boundingBox(), await filters.boundingBox()]
  const scroll = page.locator(".hr-native-home-scroll")
  await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight })
  assert.ok(await scroll.evaluate((element) => element.scrollTop > 100), "list must scroll independently")
  assert.deepEqual([await heading.boundingBox(), await filters.boundingBox()], before, "New Session and filters must remain fixed")
  assert.equal(await page.locator(".hr-native-workspace-list").evaluate((element) => element.scrollTop), 0)
  await page.getByRole("button", { name: "New Session", exact: true }).click()
  await page.locator(".hr-native-create-panel").waitFor({ state: "visible" })
  assert.equal(await scroll.evaluate((element) => element.scrollTop), 0, "New Session must reveal its form from the bottom")
  await page.getByRole("button", { name: "Close new Session" }).click()
}
try {
  const machines = await Promise.all(["A", "B", "C"].map(startDaemon))
  preview = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "preview", "--", "--host", "127.0.0.1", "--port", "4198", "--strictPort"], { stdio: "ignore", detached: process.platform !== "win32" })
  await waitFor(async () => { try { return (await fetch(origin)).ok } catch { return false } })
  browser = await chromium.launch({ headless: true })
  for (const viewport of [{ width: 1366, height: 768 }, { width: 375, height: 812 }, { width: 812, height: 375 }]) {
    const context = await browser.newContext({ viewport }), page = await context.newPage()
    await page.addInitScript((machines) => localStorage.setItem("harness-remote.workspace.machines.v1", JSON.stringify(machines)), machines)
    await page.goto(origin, { waitUntil: "domcontentloaded" })
    const groups = page.locator(".hr-native-machine-group")
    await waitFor(async () => await groups.count() === 3 && await page.locator(".hr-native-session-row").count() === 108)
    const group = (name) => groups.filter({ has: page.locator(".hr-native-machine-heading strong", { hasText: `Machine ${name}` }) })
    const a = group("A"), b = group("B"), c = group("C")
    const older = (group) => group.getByRole("button", { name: "Load older Sessions", exact: true })
    assert.equal(await older(a).count(), 1); assert.equal(await older(b).count(), 1)
    assert.equal(await older(c).count(), 0, "no cursor means no hidden page")
    const machineFilter = page.getByRole("combobox", { name: "Filter by machine", exact: true })
    await machineFilter.selectOption("C")
    assert.equal(await page.locator(".hr-native-home-pagination").count(), 0, "a filtered-out machine must not leave its button behind")
    await machineFilter.selectOption("A")
    assert.equal(await page.locator(".hr-native-home-pagination").count(), 1)
    await machineFilter.selectOption("")
    for (const machine of [a, b, c]) await machine.locator(".hr-native-machine-heading").click()
    assert.equal(await page.locator(".hr-native-session-row").count(), 0)
    assert.equal(await page.locator(".hr-native-home-pagination").count(), 0, "all collapsed means no dangling pagination")
    for (const machine of [a, b, c]) await machine.locator(".hr-native-machine-heading").click()
    await assertScroll(page)
    if (viewport.width === 1366) {
      await older(a).click()
      await waitFor(async () => requests.length === 1 && await older(a).isEnabled())
      assert.deepEqual(requests, [{ machine: "A", cursor: "A1" }], "A must not page B")
      await older(a).click(); await a.getByRole("alert").waitFor({ state: "visible" })
      await a.getByRole("button", { name: "Retry", exact: true }).click()
      await waitFor(async () => await a.locator(".hr-native-home-pagination").count() === 0)
      assert.deepEqual(requests.map(({ cursor }) => cursor), ["A1", "A2", "A2"], "retry must retain failing cursor")
      await older(b).click(); await waitFor(async () => await b.locator(".hr-native-home-pagination").count() === 0)
      assert.equal(await page.locator(".hr-native-home-pagination").count(), 0, "exhausted cursors remove pagination")
      assert.equal(await a.getByRole("alert").count(), 0)
    }
    console.log(`Session rail pagination and fixed controls passed at ${viewport.width}x${viewport.height}`)
    await context.close()
  }
} finally {
  await browser?.close()
  if (preview?.pid) { try { process.platform === "win32" ? preview.kill() : process.kill(-preview.pid, "SIGTERM") } catch {} }
  for (const server of daemons) { server.closeAllConnections(); server.close() }
}
