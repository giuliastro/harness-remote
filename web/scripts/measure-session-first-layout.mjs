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

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Expose-Headers": "X-Has-More, X-Next-Cursor, X-Session-Model" }
const json = (res, code, body) => {
  const raw = JSON.stringify(body)
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw), ...cors })
  res.end(raw)
}

let offline = false
let handoffCalls = 0
const handedOff = []
const promptBodies = []
const searchQueries = []
const renameBodies = []
const daemon = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return }
  const url = new URL(req.url || "/", `http://127.0.0.1:${DAEMON_PORT}`)
  const p = url.pathname
  if (p === "/v1/machine" && offline) return json(res, 503, { error: "offline" })
  if (p === "/v1/machine") return json(res, 200, {
    machine: { id: "m1", name: "Giulio-S7", createdAt: new Date().toISOString() },
    agents: [{ id: "claude", label: "Claude Code", backend: "claude", transport: "acp", managed: true, state: "available",
      capabilities: { sessions: true, prompt: true, abort: true, streaming: true, models: true, sessionRename: true, sessionDelete: true, attachments: true },
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
  // A4: the daemon's transcript search. Only `s-6` and `s-9` "contain" the phrase, and `s-3` has no
  // journal, so the response can be checked for coverage as well as for hits.
  if (/^\/v1\/agents\/(claude|codex)\/session\/search$/.test(p)) {
    searchQueries.push(url.searchParams.get("q") || "")
    if (p.includes("codex")) return json(res, 200, { query: url.searchParams.get("q"), results: [], scanned: 0, unsearched: [], truncated: false })
    const q = (url.searchParams.get("q") || "").toLowerCase()
    const hit = (id, count, snippet) => ({ sessionID: id, title: "", directory: DIR, updated: 0, count, matches: [{ role: "assistant", snippet }] })
    const results = q.includes("capitali") ? [] : q.includes("firma") ? [
      hit("s-6", 3, "ho rigenerato la firma del pacchetto deb e ora passa"),
      hit("s-9", 1, "la firma di macOS resta da verificare")
    ] : []
    return json(res, 200, { query: q, results, scanned: sessions.length - 1, unsearched: ["s-3"], truncated: false })
  }
  if (p === "/v1/agents/claude/session/status") return json(res, 200, Object.fromEntries(sessions.map((s, i) => [s.id, { type: process.env.ATTENTION && i === 1 ? "error" : "idle" }])))
  if (p === "/v1/agents/claude/models") return json(res, 200, { providers: [{ id: "claude", name: "claude", models: { "opus[1m]": { id: "opus[1m]", name: "Opus (1M context)", status: "active" } } }], default: { claude: "opus[1m]" } })
  if (/^\/v1\/agents\/(claude|codex)\/session\/[^/]+\/message$/.test(p)) {
    if (p.includes("codex-handoff")) return json(res, 200, [])
    const before = url.searchParams.get("before")
    if (process.env.OLDER) {
      const page = before ? Number(before.replace("older-", "")) : 0
      const next = page + 1
      res.setHeader("X-Has-More", next < 3 ? "1" : "0")
      if (next < 3) res.setHeader("X-Next-Cursor", `older-${next}`)
      if (before) {
        return json(res, 200, [{
          info: { id: `old-${page}`, role: "assistant", sessionID: "s-0", time: { created: 100 + page } },
          parts: [{ id: `old-${page}-t`, type: "text", text: `OLDER-PAGE-${page} ${"riga di testo precedente. ".repeat(Number(process.env.OLDER_LINES || 40))}` }]
        }])
      }
      res.setHeader("X-Next-Cursor", "older-1")
    }
    return json(res, 200, transcript)
  }
  const renameRoute = /^\/v1\/agents\/(?:claude|codex)\/session\/([^/]+)$/.exec(p)
  if (req.method === "PATCH" && renameRoute) {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      let parsed = {}
      try { parsed = JSON.parse(body) } catch {}
      renameBodies.push(parsed)
      const session = sessions.find((s) => s.id === renameRoute[1])
      if (session && typeof parsed.title === "string") session.title = parsed.title
      json(res, 200, session || { id: renameRoute[1], title: parsed.title })
    })
    return
  }
  const claimRoute = /^\/v1\/agents\/(?:claude|codex)\/session\/([^/]+)\/claim$/.exec(p)
  if (req.method === "POST" && claimRoute) return json(res, 200, { claimed: true, sessionID: claimRoute[1] })
  const promptRoute = /^\/v1\/agents\/(?:claude|codex)\/session\/([^/]+)\/prompt$/.exec(p)
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
  page.on("pageerror", (error) => console.error("PAGE ERROR:", error.message))
  page.on("console", (message) => { if (message.type() === "error") console.error("CONSOLE:", message.text()) })
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

  const layout = await page.evaluate(() => {
    const rail = document.querySelector(".hr-native-workspace-list")?.getBoundingClientRect()
    const detail = document.querySelector(".hr-native-workspace-detail")?.getBoundingClientRect()
    return rail && detail
      ? { railRight: Math.round(rail.right), detailLeft: Math.round(detail.left), detailWidth: Math.round(detail.width), detailTop: Math.round(detail.top), railTop: Math.round(rail.top) }
      : null
  })
  if (!layout) throw new Error("Session-first shell did not render its rail and detail panes")
  if (layout.detailLeft < layout.railRight - 12) {
    throw new Error(`detail pane overlaps the rail: rail ends at ${layout.railRight}, detail starts at ${layout.detailLeft}`)
  }
  if (layout.detailTop > layout.railTop + 12) {
    throw new Error(`detail pane wrapped below the rail instead of beside it (rail top ${layout.railTop}, detail top ${layout.detailTop})`)
  }
  if (layout.detailWidth < 320) throw new Error(`detail pane collapsed to ${layout.detailWidth}px`)

  // Drives the Settings language picker itself. The earlier language check wrote localStorage and
  // dispatched the event by hand, which proved the listener worked but not that the control reaches
  // it - the one thing a "the picker does nothing" report is about.
  // Cmd/Ctrl+K has to reach the Sessions themselves, not just open a box: the palette is the only
  // way to reach the 400th Session without scrolling, so the check types a title, presses Enter and
  // compares the chosen row's label against the Session the detail pane then shows.
  // A4: the rail's query has to reach inside the conversations. `s-6` and `s-9` match only in their
  // transcripts - their titles contain nothing like the phrase - so if they appear in the list, the
  // search reached the transcript. The coverage line is checked too: a search that hides its own
  // bounds teaches the user that a phrase was never said.
  // The lifecycle notice ("Model changed to ...", "Continued with ...") centred itself in the whole
  // transcript rather than in the message column, so on a wide pane it sat right of the bubbles above
  // and below it. What is under test is purely a CSS rule keyed on the class, so the notice is placed
  // into the live transcript as the timeline places it - a sibling of the messages - and the three
  // centres are compared.
  if (process.env.NOTICE_CHECK) {
    await page.evaluate(() => {
      const first = document.querySelector(".hr-native-session-observer .uw-message")
      const notice = document.createElement("div")
      notice.className = "tdw-conversation-event"
      const span = document.createElement("span")
      span.textContent = "Model changed to gpt-5.6-sol · medium · continuing with Codex CLI"
      notice.append(span)
      first.after(notice)
    })
    await page.waitForTimeout(400)
    console.log(JSON.stringify(await page.evaluate(() => {
      const centre = (node) => {
        const box = node.getBoundingClientRect()
        return { centre: Math.round(box.left + box.width / 2), left: Math.round(box.left), width: Math.round(box.width) }
      }
      const message = centre(document.querySelector(".hr-native-session-observer .uw-message"))
      const notice = centre(document.querySelector(".hr-native-session-observer .tdw-conversation-event"))
      const pill = centre(document.querySelector(".hr-native-session-observer .tdw-conversation-event > span"))
      const composer = centre(document.querySelector(".hr-native-session-observer .uw-composer-shell"))
      return {
        message, notice, pill, composer,
        pillOffsetFromMessageCentre: Math.abs(pill.centre - message.centre),
        noticeSharesMessageColumn: notice.left === message.left && Math.abs(notice.width - message.width) <= 1,
        // The pill still has to look like a pill, not a full-width bar.
        pillNarrowerThanColumn: pill.width < message.width,
        // The leading dot has to stay inside the pill: as an item of the centring container it both
        // sat outside the border and pushed the text off the column's axis.
        dotInsidePill: (() => {
          const span = document.querySelector(".hr-native-session-observer .tdw-conversation-event > span")
          const dot = getComputedStyle(span, "::before")
          const container = getComputedStyle(document.querySelector(".hr-native-session-observer .tdw-conversation-event"), "::before")
          return dot.content === '""' && container.display === "none"
        })(),
        pillBackground: getComputedStyle(document.querySelector(".hr-native-session-observer .tdw-conversation-event > span")).backgroundColor
      }
    }), null, 2))
    await page.screenshot({ path: OUT })
    return
  }

  if (process.env.SEARCH_CHECK) {
    const field = page.locator(".hr-native-session-search input")
    const titles = () => page.locator(".hr-native-session-row .hr-native-session-copy > strong").allTextContents()
    const beforeRows = (await titles()).length

    // A title-only query first, to prove the two paths are distinguishable.
    await field.fill("capitali")
    await page.waitForTimeout(1400)
    const titleOnly = await titles()

    await field.fill("firma")
    await page.waitForTimeout(1600)
    const afterRows = await titles()
    const snippets = await page.locator(".hr-native-session-snippet").allTextContents()
    const counts = await page.locator(".hr-native-session-transcript-count").allTextContents()
    const coverage = await page.locator(".hr-native-search-coverage").textContent().catch(() => null)
    // The snippet has to stay inside the row: a two-line clamp that leaks turns the rail into a
    // transcript and pushes every other Session off screen.
    const geometry = await page.evaluate(() => {
      const snippet = document.querySelector(".hr-native-session-snippet")
      if (!snippet) return null
      const row = snippet.closest(".hr-native-session-row").getBoundingClientRect()
      const rail = document.querySelector(".hr-native-workspace-list").getBoundingClientRect()
      const box = snippet.getBoundingClientRect()
      return {
        rowHeight: Math.round(row.height),
        snippetLines: Math.round(box.height / parseFloat(getComputedStyle(snippet).lineHeight)),
        withinRow: box.bottom <= row.bottom + 1 && box.right <= row.right + 1,
        withinRail: box.right <= rail.right + 1
      }
    })

    await page.screenshot({ path: OUT })

    // Clearing the field must put the full list back, not leave the search's result set behind.
    await field.fill("")
    await page.waitForTimeout(900)
    const cleared = (await titles()).length

    console.log(JSON.stringify({
      beforeRows,
      titleOnlyMatches: titleOnly,
      queriesSentToDaemon: searchQueries,
      // Two characters is a keystroke: it must never cost a journal read per Session.
      shortQueryNotSent: !searchQueries.includes("ca") && !searchQueries.includes("fi"),
      rowsForTranscriptQuery: afterRows,
      transcriptOnlyRowsShown: afterRows.includes("Mi dici le 6 principali capitali europee?") && afterRows.includes("Ciao"),
      snippets,
      counts,
      coverage,
      geometry,
      clearedBackToFullList: cleared === beforeRows
    }, null, 2))
    return
  }

  if (process.env.PALETTE_CHECK) {
    await page.keyboard.press("Control+k")
    await page.locator(".palette").waitFor({ timeout: 10_000 })
    const commandsWithNoQuery = await page.locator(".palette-item").count()
    const groups = await page.locator(".palette-list .menu-group-label").allTextContents()
    // The palette has to sit above the shell, not behind it: a fixed overlay inside a transformed
    // ancestor renders in the wrong place, and only hit-testing catches that.
    const overlay = await page.evaluate(() => {
      const box = document.querySelector(".palette").getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 30)
      return {
        left: Math.round(box.left), width: Math.round(box.width), top: Math.round(box.top),
        viewportWidth: window.innerWidth,
        centredOverViewport: Math.abs((box.left + box.width / 2) - window.innerWidth / 2) < 4,
        topmostAtPalette: Boolean(hit && hit.closest(".palette"))
      }
    })
    await page.locator(".palette-input").fill("capitali")
    await page.waitForTimeout(400)
    const filtered = await page.locator(".palette-item").count()
    const chosen = await page.locator(".palette-item.active .palette-item-label").first().textContent()
    const hint = await page.locator(".palette-item.active .palette-item-hint").first().textContent().catch(() => null)
    await page.keyboard.press("Enter")
    await page.waitForTimeout(1200)
    const openedTitle = await page.locator(".hr-native-session-heading h1").textContent()
    const stillOpen = await page.locator(".palette").count()

    // Escape has to close it, or the palette becomes a trap on a keyboard-only client.
    await page.keyboard.press("Control+k")
    await page.locator(".palette").waitFor({ timeout: 10_000 })
    await page.keyboard.press("Escape")
    await page.waitForTimeout(300)
    const closedByEscape = (await page.locator(".palette").count()) === 0

    // Arrow keys in the rail move real DOM focus between rows, so a screen reader follows along.
    const rows = page.locator(".hr-native-session-row")
    await rows.first().focus()
    const focusedTitle = () => page.evaluate(() =>
      (document.activeElement?.closest(".hr-native-session-row")?.querySelector("strong")?.textContent || "").trim())
    const first = await focusedTitle()
    await page.keyboard.press("ArrowDown")
    await page.waitForTimeout(150)
    const afterDown = await focusedTitle()
    await page.keyboard.press("ArrowDown")
    await page.waitForTimeout(150)
    const afterSecondDown = await focusedTitle()
    await page.keyboard.press("ArrowUp")
    await page.waitForTimeout(150)
    const afterUp = await focusedTitle()
    const focusStaysInRail = await page.evaluate(() =>
      Boolean(document.activeElement?.closest(".hr-native-workspace-list")))

    console.log(JSON.stringify({
      commandsWithNoQuery,
      sessionRows: await rows.count(),
      groups,
      overlay,
      filtered,
      chosen,
      hint,
      openedTitle,
      openedTheChosenSession: chosen !== null && openedTitle === chosen,
      paletteClosedOnRun: stillOpen === 0,
      closedByEscape,
      railFocus: { first, afterDown, afterSecondDown, afterUp },
      arrowDownMovedFocus: Boolean(first) && afterDown !== first,
      arrowUpReturned: afterUp === afterDown,
      focusStaysInRail
    }, null, 2))
    await page.screenshot({ path: OUT })
    return
  }

  if (process.env.ATTACH_CHECK) {
    const picker = page.locator(".uw-composer-attach")
    await picker.waitFor({ timeout: 15_000 })
    // A real 1x1 PNG, chosen through the actual file input rather than injected into state.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGPQiDqBFTEMLQkAFKhSgZfuVK8AAAAASUVORK5CYII=", "base64")
    const inputs = await page.locator(".uw-composer-shell input[type=file]").count()
    const probe = await page.evaluate(() => {
      const input = document.querySelector(".uw-composer-shell input[type=file]")
      return input ? { exists: true, hidden: input.hidden, accept: input.accept, multiple: input.multiple } : { exists: false }
    })
    console.log("INPUT", inputs, JSON.stringify(probe))
    await page.setInputFiles(".uw-composer-shell input[type=file]", { name: "schermata.png", mimeType: "image/png", buffer: png })
    await page.waitForTimeout(900)
    console.log("AFTER SET", JSON.stringify(await page.evaluate(() => ({
      files: document.querySelector(".uw-composer-shell input[type=file]")?.files?.length ?? null,
      previews: document.querySelectorAll(".uw-composer-attachments > li").length,
      error: document.querySelector(".uw-composer-attachment-error")?.textContent ?? null
    }))))
    const staged = await page.locator(".uw-composer-attachments > li").count()
    const canSendWithoutText = await page.locator(".uw-composer-footer .uw-button-primary").isEnabled()
    await page.locator(".uw-composer-shell textarea").fill("guarda questa schermata")
    await page.locator(".uw-composer-footer .uw-button-primary").click()
    await page.waitForTimeout(1500)
    const body = promptBodies.at(-1) || {}
    const files = (body.parts || []).filter((part) => part?.type === "file")
    console.log(JSON.stringify({
      pickerOffered: true,
      stagedPreviews: staged,
      sendEnabledWithImageOnly: canSendWithoutText,
      promptsSent: promptBodies.length,
      wireFiles: files.length,
      wireMime: files[0]?.mime ?? null,
      wireFilename: files[0]?.filename ?? null,
      wireHasBase64: typeof files[0]?.url === "string" && files[0].url.startsWith("data:image/png;base64,"),
      wireText: body.text ?? null,
      previewsClearedAfterSend: await page.locator(".uw-composer-attachments > li").count()
    }, null, 2))
    await page.screenshot({ path: OUT })
    return
  }

  // The older-messages button. Twice it left the viewport below the page it had just loaded - once by
  // anchoring the reading position exactly (a press looked like nothing happened), once by landing on
  // the junction (a press scrolled *towards the end* of the conversation). So this drives it from the
  // one position that exposes both: scrolled to the bottom of a transcript taller than the viewport.
  if (process.env.PAGING_CHECK) {
    const state = () => page.evaluate(() => {
      const t = document.querySelector(".hr-native-session-observer .uw-transcript")
      const box = t.getBoundingClientRect()
      const at = (y) => (document.elementFromPoint(box.left + box.width / 2, y)?.textContent || "").replace(/\s+/g, " ").slice(0, 26)
      return {
        messages: document.querySelectorAll(".hr-native-session-observer .uw-message").length,
        scrollTop: Math.round(t.scrollTop),
        scrollHeight: Math.round(t.scrollHeight),
        clientHeight: Math.round(t.clientHeight),
        // Sample the real text under the viewport's top and middle: an intersection test passes for
        // one giant message no matter where the viewport sits.
        textAtTop: at(box.top + 30),
        textAtMiddle: at(box.top + box.height / 2),
        // The DOM order is the other half of the claim: an older page has to be inserted under the
        // button and above what was already there, not appended at the end.
        order: [...document.querySelectorAll(".hr-native-session-observer .uw-transcript > *")]
          .map((node) => `${node.className.split(" ")[0]}:${(node.textContent || "").replace(/\s+/g, " ").slice(0, 60)}`)
      }
    })

    // Start where a reader of a long conversation actually is: at the end.
    await page.evaluate(() => {
      const t = document.querySelector(".hr-native-session-observer .uw-transcript")
      t.scrollTop = t.scrollHeight
    })
    await page.waitForTimeout(400)
    const before = await state()
    await page.locator(".uw-history-loader > button").click()
    await page.waitForTimeout(2000)
    const after = await state()

    console.log(JSON.stringify({
      before, after,
      newMessages: after.messages - before.messages,
      transcriptWasScrollable: before.scrollHeight > before.clientHeight + 8,
      startedAtTheEnd: before.scrollTop > 0,
      // The three things that were wrong, each stated as what must now be true.
      landedAtTopOfHistory: after.scrollTop === 0,
      olderPageIsOnScreen: after.textAtTop.includes("Older messages") || after.textAtTop.includes("OLDER-PAGE") || after.textAtMiddle.includes("OLDER-PAGE"),
      olderPageInsertedUnderTheButton: after.order[0]?.startsWith("uw-history-loader") && after.order[1]?.includes("OLDER-PAGE"),
      // And the loader is still there, so the reader can keep going back.
      loaderStillOffered: await page.locator(".uw-history-loader > button").count() === 1
    }, null, 2))
    await page.screenshot({ path: OUT })
    return
  }

  if (process.env.EMPTY_CHECK) {
    // Deselect so the workspace shows its empty state, then check the block reads as one column:
    // the icon centred over the copy rather than parked at the block's left edge.
    await page.evaluate(() => history.replaceState(null, "", location.pathname))
    await page.reload()
    await page.locator(".hr-native-startup").waitFor({ timeout: 20_000 })
    console.log(JSON.stringify(await page.evaluate(() => {
      const block = document.querySelector(".hr-native-startup").getBoundingClientRect()
      const svg = document.querySelector(".hr-native-startup > svg")?.getBoundingClientRect()
      const heading = document.querySelector(".hr-native-startup > strong").getBoundingClientRect()
      const centre = (r) => Math.round(r.left + r.width / 2)
      return {
        blockCentre: centre(block),
        iconCentre: svg ? centre(svg) : null,
        headingCentre: centre(heading),
        iconOffsetFromCentre: svg ? Math.abs(centre(svg) - centre(block)) : null,
        blockWidth: Math.round(block.width)
      }
    }), null, 2))
    await page.screenshot({ path: OUT })
    return
  }

  if (process.env.PICKER_CHECK) {
    const before = await page.locator(".hr-native-home-heading h2").textContent()
    // Settings, not Refresh: both are icon buttons and the labels are themselves translated.
    await page.locator(".tdw-top-actions .tdw-icon-button:not(.hr-refresh-button)").first().click()
    await page.waitForTimeout(400)
    const selects = await page.locator(".hr-mobile-settings-body select").count()
    const opts = await page.locator(".hr-mobile-settings-body select").last().locator("option").allTextContents()
    await page.locator(".hr-mobile-settings-body select").last().selectOption("it")
    await page.waitForTimeout(600)
    const stored = await page.evaluate(() => localStorage.getItem("opencode.remote.language"))
    await page.locator(".hr-mobile-settings-page footer button").click().catch(() => {})
    await page.waitForTimeout(500)
    const after = await page.locator(".hr-native-home-heading h2").textContent()
    console.log(JSON.stringify({ before, selects, opts, stored, after }, null, 2))
    await page.screenshot({ path: OUT })
    return
  }

  if (process.env.OFFLINE_CHECK) {
    const rows = () => page.locator(".hr-native-session-row").count()
    const before = await rows()
    // Take the machine off the network the way a home Wi-Fi drop does: the daemon stops answering.
    offline = true
    await page.waitForTimeout(13_000)
    console.log(JSON.stringify({
      rowsWhileOnline: before,
      rowsWhileOffline: await rows(),
      cachedRows: await page.locator(".hr-native-session-row.cached").count(),
      notice: await page.locator(".hr-native-machine-cached span").first().textContent().catch(() => null),
      renameOffered: await page.locator(".hr-session-actions .tdw-icon-button").count()
    }, null, 2))
    await page.screenshot({ path: OUT })
    return
  }

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

  // Continuing with another coding agent, now driven the way it is actually offered: the header's
  // own agent selector plus the next message. There is no separate button any more - it said nothing
  // about when it applied and duplicated a choice this control already presents.
  if (process.env.HANDOFF_CHECK) {
    const select = page.locator(".tdw-agent-choice select")
    await select.waitFor({ timeout: 15_000 })
    const options = await select.locator("option").allTextContents()
    const noteBefore = await page.locator("#tdw-continue-elsewhere").count()
    // The removed button must not come back under another name.
    const strayButtons = await page.locator(".hr-session-handoff, .hr-session-handoff-trigger").count()

    await select.selectOption({ label: "Codex CLI" })
    await page.waitForTimeout(400)
    // Choosing has no effect on its own, and the hint has to say so before the message is written.
    const note = await page.locator("#tdw-continue-elsewhere").textContent().catch(() => null)
    const describedBy = await select.getAttribute("aria-describedby")
    const handoffsBeforeSend = handoffCalls
    // The behavioural checks below all passed once while the toolbar had collapsed to "Co…" and
    // "Harn…": the agent label had been given the container's own class and was constraining both.
    // A control whose own label does not fit is broken however correctly it behaves.
    const toolbar = await page.evaluate(() => {
      const fits = (node) => node && node.scrollWidth <= node.clientWidth + 1
      const box = (selector) => {
        const node = document.querySelector(selector)
        return node ? { width: Math.round(node.getBoundingClientRect().width), fits: fits(node) } : null
      }
      const row = document.querySelector(".hr-native-session-observer .tdw-conversation-toolbar")
      return {
        rowWidth: Math.round(row.getBoundingClientRect().width),
        // One line each, no mid-word ellipsis.
        agentLabel: box(".tdw-agent-choice > span"),
        agentSelect: box(".tdw-agent-choice select"),
        modelLabel: box(".tdw-model-control > span"),
        rowScrollsSideways: row.scrollWidth > row.clientWidth + 1
      }
    })
    await page.screenshot({ path: OUT })

    const composer = page.locator(".uw-composer-shell textarea")
    await composer.fill("Continua il lavoro sul parser")
    await page.locator(".uw-composer-footer .uw-button-primary").first().click()
    await page.waitForTimeout(2500)

    const wire = promptBodies.map((b) => (Array.isArray(b?.parts) ? b.parts : []).map((x) => x?.text || "").join("\n") || b?.text || b?.prompt || JSON.stringify(b).slice(0, 200))
    console.log(JSON.stringify({
      options,
      strayButtons,
      hintOnlyWhenSwitching: noteBefore === 0 && Boolean(note),
      hint: note,
      hintReachableFromTheSelect: describedBy === "tdw-continue-elsewhere",
      toolbar,
      toolbarLabelsFit: Boolean(toolbar.agentLabel?.fits && toolbar.agentSelect?.fits && toolbar.modelLabel?.fits) && !toolbar.rowScrollsSideways,
      handoffsBeforeSend,
      handoffCalls,
      // One Session created, by the message - not by the selection.
      createdOnlyOnSend: handoffsBeforeSend === 0 && handoffCalls === 1,
      eyebrow: await page.locator(".hr-native-session-eyebrow").first().textContent(),
      promptCount: promptBodies.length,
      wireCarriesPacket: wire.some((w) => w.includes("You are taking over an existing TaskDesk task.")),
      wireCarriesSourceTranscript: wire.some((w) => w.includes("non sono completati tutti?")),
      wireCarriesInstruction: wire.some((w) => w.includes("Continua il lavoro sul parser"))
    }, null, 2))
    return
  }

  // Renaming happens on the title itself. The modal it replaced put an input inside a panel anchored
  // to an icon button, where it overflowed; this checks the field stays inside the header instead.
  if (process.env.RENAME_CHECK) {
    const heading = page.locator(".hr-session-title-edit")
    await heading.waitFor({ timeout: 15_000 })
    const before = (await heading.textContent() || "").trim()
    const modalTriggers = await page.locator(".hr-session-actions .tdw-icon-button").count()
    await heading.click()
    const input = page.locator(".hr-session-title-input")
    await input.waitFor({ timeout: 5_000 })

    const geometry = await page.evaluate(() => {
      const field = document.querySelector(".hr-session-title-input").getBoundingClientRect()
      const header = document.querySelector(".hr-native-workspace-session-header").getBoundingClientRect()
      const h1 = document.querySelector("h1.hr-session-title").getBoundingClientRect()
      const style = getComputedStyle(document.querySelector(".hr-session-title-input"))
      return {
        fieldWidth: Math.round(field.width),
        headerWidth: Math.round(header.width),
        // The one thing the modal got wrong.
        insideItsContainer: field.right <= header.right + 1 && field.left >= header.left - 8,
        // "In place" has to be literal: same size, same line as the heading it replaced.
        fontSize: style.fontSize,
        sameLineAsHeading: Math.abs((field.top + field.height / 2) - (h1.top + h1.height / 2)) < 6,
        focused: document.activeElement === document.querySelector(".hr-session-title-input"),
        // No dialog, no backdrop, nothing to dismiss.
        dialogs: document.querySelectorAll(".hr-session-action-panel, .hr-session-action-backdrop").length
      }
    })

    // Escape abandons; the title must come back unchanged and nothing must be sent.
    await page.keyboard.press("Escape")
    await page.waitForTimeout(300)
    const afterEscape = (await page.locator(".hr-session-title-edit").textContent() || "").trim()
    const renamesAfterEscape = renameBodies.length

    await page.locator(".hr-session-title-edit").click()
    await page.locator(".hr-session-title-input").fill("Verifica firma del pacchetto")
    await page.keyboard.press("Enter")
    await page.waitForTimeout(1200)

    console.log(JSON.stringify({
      before,
      // Only Delete is left as an icon button in the header.
      headerIconButtons: modalTriggers,
      geometry,
      escapeKeepsTheName: afterEscape === before,
      renamesAfterEscape,
      renamesSent: renameBodies.length,
      sentTitle: renameBodies.at(-1)?.title ?? null,
      titleAfterCommit: (await page.locator(".hr-session-title-edit").textContent() || "").trim(),
      backInReadMode: await page.locator(".hr-session-title-input").count() === 0
    }, null, 2))
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
      historyLoader: box(".hr-native-session-observer .uw-history-loader"),
      historyButton: box(".hr-native-session-observer .uw-history-loader > button"),
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
