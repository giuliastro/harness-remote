import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8")
const timeline = read("./work-thread-timeline.ts")
const chat = read("./components/work-thread-conversation.tsx")
const standalone = read("./components/standalone-universal-workspace.tsx")
const home = read("./components/native-session-home-base.tsx")
const attentionHome = read("./components/native-session-home-attention.tsx")
const actions = read("./components/native-session-actions.tsx")

test("the synthetic shared-chat timeline role is not named after the old product", () => {
  assert.match(timeline, /export const CONVERSATION_EVENT_ROLE = "conversation-event"/)
  assert.doesNotMatch(timeline, /role: "taskdesk"/)
  assert.match(chat, /message\.info\.role === CONVERSATION_EVENT_ROLE/)
})

test("the retired Conversation-first product UI is absent", () => {
  assert.equal(existsSync(new URL("./components/conversation-workspace.tsx", import.meta.url)), false)
  assert.equal(existsSync(new URL("./components/conversation-detail.tsx", import.meta.url)), false)
  assert.doesNotMatch(standalone, />Conversations</)
  assert.doesNotMatch(standalone, /New conversation/i)
})

test("no user-facing copy in the Session-first shell says Task or TaskDesk", () => {
  const copy = [standalone, home, attentionHome, actions, chat]
    .join("\n")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
  for (const pattern of [/>[^<]*\bTaskDesk\b/, /"[^"]*\bNew task\b/i, /placeholder="[^"]*\btask\b/i]) {
    assert.doesNotMatch(copy, pattern)
  }
})

test("the visible product hierarchy names native Sessions directly", () => {
  assert.match(standalone, /t\("sf\.nativeSessions"\)/)
  assert.match(standalone, /t\("nav\.sessions"\)/)
  assert.match(home, /t\("sf\.newSession"\)/)
  assert.match(home, /t\("sf\.searchSessions"\)/)
  assert.match(attentionHome, /Authorization required/)
  assert.match(attentionHome, /Needs attention/)
})
