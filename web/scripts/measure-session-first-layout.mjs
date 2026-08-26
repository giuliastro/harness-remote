/**
 * Measures the real rendered geometry of the Session-first workspace against a fake machine daemon.
 *
 * Proportion defects are invisible in a stylesheet: three nested caps (rail width, row width,
 * reading measure) interact, and `ch` is not a character. This prints what the browser actually
 * lays out, so a change to those numbers can be judged instead of guessed.
 *
 *   VW=1875 node scripts/measure-session-first-layout.mjs /tmp/shot.png
 *
 * Set CHROMIUM_PATH when Playwright's own download is not the browser you want to drive.
 */
import http from "node:http"
import { spawn } from "node:child_process"
import { chromium } from "playwright"

const PREVIEW_PORT = 4186
const DAEMON_PORT = 4432
const APP = `http://127.0.0.1:${PREVIEW_PORT}`
const STORAGE_KEY = "harness-remote.workspace.machines.v1"
const DIR = "/home/giulio/Software/harness-remote-session-first-test"
const OUT = process.argv[2] || "/tmp/shot.png"

const REPEAT = Number(process.env.SESSIONS || 11)
const BASE_TITLES = [
  "Verifica e pusha modifiche web", "Correggere caricamento sessioni e modelli nativi",
  "Session 01a038e7", "Session 01a038da", "Session 01a038d9",
  "Revisione e test PR", "Mi dici le 6 principali capitali europee?",
  "Task 5b77bfda · Run 3", "e Genova?", "Ciao", "TaskDesk UI audit and polish"
]
const TITLES = Array.from({ length: REPEAT }, (_, i) => BASE_TITLES[i % BASE_TITLES.length])
const sessions = TITLES.map((title, i) => ({
  id: `s-${i}`, title, directory: DIR,
  time: { created: 1_700_000_000_000 - i * 3.6e6, updated: 1_700_000_000_000 - i * 3.6e6 },
  summary: { additions: 0, deletions: 0, files: 0 }
}))

const PROSE = "Sì, il rerun è completato: tutte e tre le piattaforme verdi, Linux compreso. Il `deb` ora passa con i metadati aggiunti in `e3257cc`, e i glob per estensione hanno raccolto tutto — nessun `if-no-files-found: error`. Ho quindi creato e pushato il tag annotato v2.9.0 su `e3257cc`, il commit appena validato."
const transcript = [
  { info: { id: "u1", role: "user", sessionID: "s-5", time: { created: 1_000 } },
    parts: [{ id: "u1t", type: "text", text: "non sono completati tutti?" }] },
  { info: { id: "a1", role: "assistant", sessionID: "s-5", time: { created: 2_000, completed: 2_100 } },
    parts: [{ id: "a1t", type: "text", text: `${PROSE}\n\n| Job | Esito | Artefatto |\n| --- | --- | --- |\n| Package windows | success | 98,2 MB (.exe) |\n| Package linux | success | 224 MB (AppImage + deb) |\n| Package macos | success | 495,4 MB (dmg + zip) |\n\n${PROSE}` }] }
]

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" }
const json = (res, code, body) => {
  const raw = JSON.stringify(body)
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw), ...cors })
  res.end(raw)
}

let handoffCalls = 0
const handedOff = []
const promptBodies = []
const daemon = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return }
  const url = new URL(req.url || "/", `http://127.0.0.1:${DAEMON_PORT}`)
  const p = url.pathname
  if (p === "/v1/machine") return json(res, 200, {
    machine: { id: "m1", name: "Giulio-S7", createdAt: new Date().toISOString() },
    agents: [{ id: "claude", label: "Claude Code", backend: "claude", transport: "acp", managed: true, state: "available",
      capabilities: { sessions: true, prompt: true, abort: true, streaming: true, models: true, sessionRename: true, sessionDelete: true },
      contract: { sessions: { stop: "native-abort" } } },
      { id: "codex", label: "Codex CLI", backend: "codex", transport: "acp", managed: true, state: "available",
        capabilities: { sessions: true, prompt: true, abort: true, streaming: true, models: true, sessionRename: true, sessionDelete: true },
        contract: { sessions: { stop: "native-abort" } } }]
  })
  if (p === "/v1/projects") return json(res, 200, { projects: [{ id: "p1", machineId: "m1", name: "harness-remote-session-first-test", path: DIR, kind: "git", configured: true }] })
  if (p === "/v1/agents/claude/experimental/session") return json(res, 200, sessions)
  if (p === "/v1/agents/codex/experimental/session") return json(res, 200, handedOff)
  if (p === "/v1/agents/codex/session/status") return json(res, 200, Object.fromEntries(handedOff.map((x) => [x.id, { type: "idle" }])))
  if (p === "/v1/agents/codex/models") return json(res, 200, { providers: [], default: {} })
  const handoff = /^\/v1\/agents\/claude\/session\/([^/]+)\/handoff$/.exec(p)
  if (req.method === "POST" && handoff) {
    handoffCalls += 1
    const created = { id: "codex-handoff-1", title: "handed off", directory: DIR, time: { created: Date.now(), updated: Date.now() }, summary: { additions: 0, deletions: 0, files: 0 } }
    handedOff.push(created)
    return json(res, 200, { status: "accepted", result: { target: { machineID: "m1", agentID: "codex", sessionID: created.id, directory: DIR } } })
  }
  if (p === "/v1/agents/claude/session/status") return json(res, 200, Object.fromEntries(sessions.map((s, i) => [s.id, { type: process.env.ATTENTION && i === 1 ? "error" : "idle" }])))
  if (p === "/v1/agents/claude/models") return json(res, 200, { providers: [{ id: "claude", name: "claude", models: { "opus[1m]": { id: "opus[1m]", name: "Opus (1M context)", status: "active" } } }], default: { claude: "opus[1m]" } })
  if (/^\/v1\/agents\/(claude|codex)\/session\/[^/]+\/message$/.test(p)) { res.setHeader("X-Has-More", "0"); return json(res, 200, p.includes("codex-handoff") ? [] : transcript) }
  const promptRoute = /^\/v1\/agents\/codex\/session\/([^/]+)\/prompt$/.exec(p)
  if (req.method === "POST" && promptRoute) {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      try { promptBodies.push(JSON.parse(body)) } catch { promptBodies.push({ raw: body }) }
      json(res, 200, { status: "accepted", clientRequestId: "req-1" })
    })
    return
  }
  if (p.includes("/global/event")) { res.writeHead(200, { "Content-Type": "text/event-stream", ...cors }); res.write(": ok\n\n"); return }
  if (p.includes("/question") || p.includes("/permission")) return json(res, 200, [])
  return json(res, 404, { error: p })
})

const preview = spawn("npm", ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(PREVIEW_PORT), "--strictPort"],
  { stdio: ["ignore", "pipe", "pipe"], detached: true, cwd: "/home/user/harness-remote/web" })

async function ready(url) {
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error("preview not ready")
}

let browser
const run = async () => {
  await new Promise((r) => daemon.listen(DAEMON_PORT, "127.0.0.1", r))
  await ready(APP)
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) })
  const ctx = await browser.newContext({ viewport: { width: Number(process.env.VW || 1875), height: Number(process.env.VH || 1000) }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  await page.addInitScript(({ key, port }) => {
    localStorage.setItem(key, JSON.stringify([{ id: "m1", name: "Giulio-S7", config: { backend: "opencode", host: "127.0.0.1", port, username: "h", password: "p" } }]))
    localStorage.setItem("harness-remote.theme", "light")
    localStorage.setItem("opencode.remote.theme", "light")
  }, { key: STORAGE_KEY, port: DAEMON_PORT })
  await page.goto(APP)
  await page.locator(".hr-native-session-row").first().waitFor({ timeout: 20_000 })
  await page.locator(".hr-native-session-row").first().click()
  await page.locator(".hr-native-session-observer .uw-markdown p").first().waitFor({ timeout: 20_000 })
  await page.waitForTimeout(1200)

  if (process.env.BADGE_CHECK) {
    await page.waitForTimeout(600)
    console.log(JSON.stringify(await page.evaluate(() => ({
      badge: document.querySelector(".hr-mobile-nav-badge")?.textContent ?? null,
      badgeLabel: document.querySelector(".hr-mobile-nav-badge")?.getAttribute("aria-label") ?? null,
      attentionFilter: document.querySelectorAll(".hr-native-session-filters button")[2]?.textContent ?? null
    })), null, 2))
    await page.screenshot({ path: OUT })
    return
  }

  if (process.env.RAIL_CHECK) {
    const rail = () => page.locator(".hr-native-workspace-list").evaluate((n) => Math.round(n.getBoundingClientRect().width))
    const before = await rail()
    const handle = page.locator(".hr-rail-resizer")
    const box = await handle.boundingBox()
    await page.mouse.move(box.x + 5, box.y + 200)
    await page.mouse.down()
    await page.mouse.move(box.x + 145, box.y + 200, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(250)
    const afterDrag = await rail()
    const stored = await page.evaluate(() => localStorage.getItem("harness-remote.sessionRailWidth.v1"))
    await handle.focus()
    await page.keyboard.press("ArrowLeft")
    await page.keyboard.press("ArrowLeft")
    await page.waitForTimeout(200)
    const afterKeys = await rail()
    await page.reload()
    await page.locator(".hr-native-session-row").first().waitFor({ timeout: 20_000 })
    const afterReload = await rail()
    console.log(JSON.stringify({ before, afterDrag, stored, afterKeys, afterReload,
      focusable: await handle.evaluate((n) => n.tabIndex === 0 && n.getAttribute("role") === "separator") }, null, 2))
    await page.screenshot({ path: OUT })
    return
  }

  if (process.env.HANDOFF_CHECK) {
    const trigger = page.locator(".hr-session-handoff-trigger")
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()
    const select = page.locator(".hr-session-handoff select")
    await select.waitFor({ timeout: 10_000 })
    const options = await select.locator("option").allTextContents()
    await page.locator(".hr-session-handoff .tdw-button.primary").click()
    await page.waitForTimeout(1500)
    const header = await page.locator(".hr-native-session-heading h1").textContent()
    const eyebrow = await page.locator(".hr-native-session-eyebrow").first().textContent()
    const composer = page.locator(".uw-composer-shell textarea")
    await composer.fill("Continua il lavoro sul parser")
    await page.locator(".uw-composer-footer button", { hasText: /Send|Invia/ }).first().click().catch(() => {})
    await page.waitForTimeout(1500)
    const wire = promptBodies.map((b) => (Array.isArray(b?.parts) ? b.parts : []).map((x) => x?.text || "").join("\n") || b?.text || b?.prompt || JSON.stringify(b).slice(0, 200))
    const visible = await page.locator(".uw-message-user .uw-markdown").allTextContents()
    console.log(JSON.stringify({ options, handoffCalls, header, eyebrow,
      composerEnabled: await composer.isEnabled(),
      promptCount: promptBodies.length,
      wireCarriesPacket: wire.some((w) => w.includes("You are taking over an existing TaskDesk task.")),
      wireCarriesSourceTranscript: wire.some((w) => w.includes("non sono completati tutti?")),
      wireCarriesInstruction: wire.some((w) => w.includes("Continua il lavoro sul parser")),
      visibleUserMessages: visible }, null, 2))
    await page.screenshot({ path: OUT })
    return
  }

  if (process.env.LANG_CHECK) {
    const snap = async () => page.evaluate(() => ({
      heading: document.querySelector(".hr-native-home-heading h2")?.textContent,
      count: document.querySelector(".hr-native-home-heading span")?.textContent,
      newSession: document.querySelector(".hr-native-new-session span")?.textContent,
      search: document.querySelector(".hr-native-session-search input")?.getAttribute("placeholder"),
      filters: [...document.querySelectorAll(".hr-native-session-filters button")].map((b) => b.textContent),
      status: document.querySelector(".hr-native-session-status")?.textContent,
      composer: document.querySelector(".uw-composer-shell textarea")?.getAttribute("placeholder"),
      hint: document.querySelector("#uw-composer-hint")?.textContent,
      lang: document.documentElement.lang
    }))
    const report = {}
    for (const code of ["en", "it", "zh-TW", "zh-CN"]) {
      await page.evaluate((value) => {
        localStorage.setItem("opencode.remote.language", value)
        document.documentElement.lang = value
        window.dispatchEvent(new Event("harness-remote:preferences-changed"))
      }, code)
      await page.waitForTimeout(200)
      report[code] = await snap()
    }
    console.log(JSON.stringify(report, null, 2))
    await page.screenshot({ path: OUT })
    return
  }

  const m = await page.evaluate(() => {
    const box = (s) => { const e = document.querySelector(s); if (!e) return null
      const r = e.getBoundingClientRect(); const c = getComputedStyle(e)
      return { w: Math.round(r.width), x: Math.round(r.left), fs: parseFloat(c.fontSize), lh: c.lineHeight, ff: c.fontFamily.split(",")[0] } }
    const el = document.querySelector(".hr-native-session-observer .uw-markdown p")
    let ch = null
    if (el) { const probe = document.createElement("span")
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre"
      probe.style.font = getComputedStyle(el).font
      probe.textContent = "0".repeat(100)
      el.appendChild(probe); ch = probe.getBoundingClientRect().width / 100; probe.remove() }
    const p = box(".hr-native-session-observer .uw-markdown p")
    return {
      viewport: window.innerWidth,
      rail: box(".hr-native-workspace-list"),
      detailPane: box(".hr-native-workspace-detail"),
      railTitle: box(".hr-native-session-copy strong"),
      railSub: box(".hr-native-session-copy small"),
      railProject: box(".hr-native-project-heading strong"),
      messageRow: box(".hr-native-session-observer .uw-message"),
      prose: p,
      table: box(".hr-native-session-observer .uw-markdown table"),
      composer: box(".hr-native-session-observer .uw-composer-shell") || box(".uw-composer-shell"),
      charWidth: ch ? Math.round(ch * 100) / 100 : null,
      charsPerLine: ch && p ? Math.round(p.w / ch) : null,
      bodyOverflowX: document.documentElement.scrollWidth - window.innerWidth,
      chevrons: [...document.querySelectorAll(".hr-native-project-heading, .hr-native-machine-heading")].slice(0, 4).map((head) => {
        const glyph = head.querySelector(".hr-native-machine-chevron") || head.querySelector("span:last-child i")
        const hb = head.getBoundingClientRect()
        const gb = glyph ? glyph.getBoundingClientRect() : null
        const rail = document.querySelector(".hr-native-workspace-list").getBoundingClientRect()
        return {
          kind: head.className.includes("machine") ? "machine" : "project",
          headRight: Math.round(hb.right),
          glyphRight: gb ? Math.round(gb.right) : null,
          glyphWidth: gb ? Math.round(gb.width) : null,
          railRight: Math.round(rail.right),
          overflowsHead: gb ? Math.round(gb.right - hb.right) : null,
          overflowsRail: gb ? Math.round(gb.right - rail.right) : null,
          headScrollOverflow: Math.round(head.scrollWidth - head.clientWidth),
          railScrollbar: (() => { const r = document.querySelector(".hr-native-workspace-list"); return Math.round(r.offsetWidth - r.clientWidth) })()
        }
      }),
      transcriptPad: (() => { const t = document.querySelector('.hr-native-session-observer .uw-transcript'); return t ? getComputedStyle(t).paddingLeft : null })()
    }
  })
  console.log(JSON.stringify(m, null, 2))
  await page.screenshot({ path: OUT, fullPage: false })
}
try { await run() } finally {
  if (browser) await browser.close()
  try { process.kill(-preview.pid, "SIGTERM") } catch {}
  try { daemon.close() } catch {}
}
