import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import test from "node:test"

const here = path.dirname(fileURLToPath(import.meta.url))
/** Normalised: `core.autocrlf` gives a Windows checkout CRLF while the index stays LF, so every
 *  assertion written with `\n` failed locally and passed in CI. These describe CSS, not line endings. */
const read = (name) => readFileSync(path.join(here, name), "utf8").replace(/\r\n/g, "\n")

// Every stylesheet the running 3.0 shell loads, directly or through a component import.
const LIVE_STYLESHEETS = [
  "taskdesk-workspace-navigation.css", "taskdesk-workthreads.css", "work-thread-detail.css",
  "conversation-control-plane.css", "conversation-control-plane-overrides.css",
  "conversation-control-plane-mobile-polish.css", "model-picker.css",
  "universal-workspace-readable.css", "universal-workspace-readable-fixes.css",
  "taskdesk-conversation.css", "taskdesk-conversation-fixes.css",
  "taskdesk-mobile-navigation.css", "v3-polish.css", "universal-workspace.css",
  "taskdesk-focus-layout.css", "beautiful-ui-controls.css"
]

test("no live stylesheet declares text below the 10px legibility floor", () => {
  // Measured in Chromium before this floor: over a third of the visible text on the desktop shell
  // rendered at 8.5px or 9px, including the machine's own connection error.
  const offenders = []
  for (const name of LIVE_STYLESHEETS) {
    const css = read(name).replace(/\/\*[\s\S]*?\*\//g, "")
    for (const match of css.matchAll(/font-size:\s*([0-9.]+)px/g)) {
      if (Number(match[1]) > 0 && Number(match[1]) < 10) offenders.push(`${name}: ${match[0]}`)
    }
    for (const match of css.matchAll(/font:\s*[^;]*?\b([0-9.]+)px/g)) {
      if (Number(match[1]) > 0 && Number(match[1]) < 10) offenders.push(`${name}: ${match[0]}`)
    }
  }
  assert.deepEqual(offenders, [])
})

test("every live stylesheet in the floor list still exists", () => {
  const present = new Set(readdirSync(here).filter((f) => f.endsWith(".css")))
  for (const name of LIVE_STYLESHEETS) assert.ok(present.has(name), `${name} is missing from the floor list`)
})

test("both roles share one reading measure, and code and tables keep the full width", () => {
  // This assertion used to require the opposite for the user role — that a bubble is framed by its
  // own border and so must not be capped. In practice that was the whole defect: the bubble was the
  // only element tracking the window, so widening the browser stretched the prompt toward the full
  // row while the reply stopped at its measure, and the thread grew visibly lopsided the more screen
  // it was given. One measure for both roles is what Claude and ChatGPT do.
  const css = read("taskdesk-conversation.css")
  assert.match(css, /--hr-chat-measure: \d+ch;/)
  assert.match(css, /\.tdw-work-thread-conversation \.uw-markdown > p,/)

  const rule = css.match(/\.tdw-work-thread-conversation \.uw-markdown > p,[\s\S]*?\n\}/)?.[0] || ""
  assert.match(rule, /max-width: var\(--hr-chat-measure\)/)
  // Only block prose is listed: pre, table and the tool cards must keep the full width.
  assert.doesNotMatch(rule, /> pre|> table/)
  // Role-agnostic: the selector must not single out either role.
  assert.doesNotMatch(rule, /uw-message-agent|uw-message-user/)

  // And the bubble is bounded by the same measure plus its own padding and border.
  assert.match(css, /\.uw-message-user \.uw-message-body \{\n\s*max-width: calc\(var\(--hr-chat-measure\) \+ \d+px\);/)

  // The measure has to stay inside the comfortable range the file documents. This face averages
  // ~6.79px per character at the transcript size, per the measurement recorded alongside the rule.
  const measure = Number(css.match(/--hr-chat-measure: (\d+)ch;/)[1])
  const characters = Math.round(measure * 9.85 / 6.79)
  assert.ok(characters >= 45 && characters <= 100, `${measure}ch is ~${characters} characters per line`)
})

test("surplus window width becomes margin instead of a wider prompt", () => {
  // The row is what the user bubble grew inside. Capping it is the second half of the fix: past this
  // width a larger monitor adds margin, not line length.
  const fixes = read("taskdesk-conversation-fixes.css")
  const row = fixes.match(/\.tdw-work-thread-conversation \.uw-message \{\n\s*width: min\((\d+)px, 100%\);/)
  assert.ok(row, "the transcript row must carry an explicit maximum width")
  assert.ok(Number(row[1]) <= 1040, `the row is still ${row[1]}px wide`)
  // The composer lines up with the column above it rather than running wider than the conversation.
  const composer = fixes.match(/\.uw-composer-shell \{\n\s*width: min\((\d+)px, calc\(100% - 32px\)\);/)
  assert.ok(composer, "the composer must track the same column")
  assert.equal(composer[1], row[1])
})

test("the activity status label is component copy, not CSS content", () => {
  const component = read("components/taskdesk-message-content.tsx")
  const overrides = read("conversation-control-plane-overrides.css")
  assert.match(component, /function activityStatusLabel\(status: string\): string/)
  assert.match(component, /status === "running" \? "Working" : status/)
  assert.doesNotMatch(overrides, /content: "Working"/)
})

test("a failed or cancelled Conversation does not report Ready in its own header", () => {
  // The list card said "Needs attention" / "Stopped" while the open conversation said "Ready", and
  // for a cancelled Conversation the interruption was not visible anywhere.
  const conversation = read("components/work-thread-conversation.tsx")
  assert.match(conversation, /function conversationOutcome\(status: string\)/)
  assert.match(conversation, /if \(status === "failed"\) return \{ state: "attention", text: "Needs attention" \}/)
  assert.match(conversation, /if \(status === "cancelled"\) return \{ state: "stopped", text: "Stopped" \}/)
  assert.match(conversation, /status=\{conversation\.status\} detail=\{conversation\.error\?\.message \|\| undefined\}/)
  assert.match(read("work-thread-detail.css"), /\.tdw-conversation-state\.stopped \{/)
})

test("a select still looks like a select", () => {
  // The base `select` rule draws the dropdown chevron with background-image. Three v3 rules used the
  // `background` shorthand, which silently erased it, so Machine, Project, Coding agent, Theme,
  // Language and Continue with all rendered as plain boxes indistinguishable from text inputs —
  // while the Model control beside them kept its chevron. .tdw-agent-control even reserved 25px of
  // right padding for the arrow that was no longer drawn.
  const base = read("styles.css")
  assert.match(base, /select \{\n\s*appearance: none;[\s\S]*?background-image: linear-gradient/)
  for (const [file, selector] of [
    ["taskdesk-workthreads.css", ".tdw-modal select"],
    ["work-thread-detail.css", ".tdw-agent-control select"],
    ["conversation-control-plane-overrides.css", ".hr-mobile-settings-group select"]
  ]) {
    const css = read(file)
    const rule = css.slice(css.indexOf(selector))
    const body = rule.slice(0, rule.indexOf("}") + 1)
    assert.doesNotMatch(body, /(^|[^-])background:/m, `${selector} must not reset background-image`)
    assert.match(body, /background-color:/, `${selector} must set background-color`)
  }
})
