import assert from "node:assert/strict"
import http from "node:http"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

// Browser regression for DeepSeek tool turns: the daemon first serves a DeepSeek tool turn as one merged message, then split into a
// tool message and a text message. The open Session must show the reply text once.
const PREVIEW_PORT = 4197
const DAEMON_PORT = 4443
const APP_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
const SESSION_ID = "split-session"
const TITLE = "Split reply Session"
let split = false

const prompt = { info: { id: "p1", role: "user", sessionID: SESSION_ID, time: { created: 1_000 } }, parts: [{ id: "p1:text:0", type: "text", text: "Attendi 10 secondi poi rispondi OK" }] }
const tool = { id: "0e8a9276:tool:1", type: "tool", tool: "web_fetch", callID: "c1", state: { status: "completed", input: {}, output: "done", title: "web fetch" } }
const reasoning = { id: "0e8a9276:reasoning:0", type: "reasoning", text: "Wait then answer." }
const merged = () => [prompt, { info: { id: "0e8a9276", role: "assistant", sessionID: SESSION_ID, time: { created: 1_001, completed: 1_012 } }, parts: [reasoning, tool, { id: "7082d780:text:1", type: "text", text: "SPLIT-REPLY-OK" }] }]
const separate = () => [prompt,
  { info: { id: "0e8a9276", role: "assistant", sessionID: SESSION_ID, time: { created: 1_001, completed: 1_011 } }, parts: [reasoning, tool] },
  { info: { id: "7082d780", role: "assistant", sessionID: SESSION_ID, time: { created: 1_011, completed: 1_012 } }, parts: [{ id: "7082d780:text:1", type: "text", text: "SPLIT-REPLY-OK" }] }]

const cors = (request) => ({ "Access-Control-Allow-Origin": APP_ORIGIN, "Access-Control-Allow-Headers": request.headers["access-control-request-headers"] || "Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Expose-Headers": "X-Has-More, X-Next-Cursor, X-Session-Model" })
const server = http.createServer((request, response) => {
  const json = (value, extra = {}) => { response.writeHead(200, { "Content-Type": "application/json", ...cors(request), ...extra }); response.end(JSON.stringify(value)) }
  if (request.method === "OPTIONS") { response.writeHead(204, cors(request)); response.end(); return }
  const url = new URL(request.url || "/", "http://x")
  if (url.pathname === "/v1/machine") return json({ machine: { id: "m-split", name: "Split Test", createdAt: new Date().toISOString() }, agents: [{ id: "deepseek", label: "DeepSeek Harness", backend: "deepseek", transport: "acp", managed: true, state: "available", capabilities: { sessions: true, prompt: true, abort: true, streaming: true, models: false } }] })
  if (url.pathname === "/v1/projects") return json({ projects: [] })
  if (url.pathname === "/v1/agents/deepseek/experimental/session") return json([{ id: SESSION_ID, title: TITLE, directory: "/w", time: { created: 1_000, updated: 3_000 } }])
  if (url.pathname === "/v1/agents/deepseek/session/status") return json({ [SESSION_ID]: { type: "idle" } })
  if (url.pathname === `/v1/agents/deepseek/session/${SESSION_ID}/message`) return json(split ? separate() : merged(), { "X-Has-More": "0" })
  if (url.pathname.includes("/global/event")) { response.writeHead(200, { ...cors(request), "Content-Type": "text/event-stream" }); response.write(": connected\n\n"); return }
  if (url.pathname.includes("/question") || url.pathname.includes("/permission")) return json([])
  if (url.pathname.endsWith("/capabilities") || url.pathname.endsWith("/models")) return json(url.pathname.endsWith("/models") ? { models: [], stale: false } : { attachments: false, commands: false })
  response.writeHead(404, cors(request)); response.end()
})
await new Promise((resolve) => server.listen(DAEMON_PORT, "127.0.0.1", resolve))
const preview = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(PREVIEW_PORT), "--strictPort"], { stdio: "ignore", shell: process.platform === "win32" })
let browser
try {
  for (let i = 0; i < 200; i += 1) { try { if ((await fetch(APP_ORIGIN)).ok) break } catch {} await new Promise((r) => setTimeout(r, 150)) }
  browser = await chromium.launch()
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: "en-US" })).newPage()
  await page.addInitScript((port) => localStorage.setItem("harness-remote.workspace.machines.v1", JSON.stringify([{ id: "m-split", name: "Split Test", config: { backend: "deepseek", host: "127.0.0.1", port, username: "h", password: "p" } }])), DAEMON_PORT)
  await page.goto(APP_ORIGIN)
  await page.getByRole("button", { name: new RegExp(TITLE) }).click()
  await page.getByText("SPLIT-REPLY-OK").first().waitFor({ timeout: 20_000 })
  assert.equal(await page.getByText("SPLIT-REPLY-OK", { exact: true }).count(), 1, "the merged form shows the reply once")
  split = true
  // The open Session re-reads on its periodic reconcile; give it time to pick up the split form.
  await page.waitForTimeout(35_000)
  assert.equal(await page.getByText("SPLIT-REPLY-OK", { exact: true }).count(), 1, "the split form must not draw the reply a second time")
  console.log("split reply browser smoke passed")
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT })
} finally {
  await browser?.close()
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(preview.pid), "/t", "/f"])
  else preview.kill()
  server.close()
}
