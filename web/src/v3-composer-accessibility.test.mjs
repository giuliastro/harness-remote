import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const conversation = readFileSync(new URL("./components/taskdesk-conversation.tsx", import.meta.url), "utf8")

test("the composer is named for assistive technology", () => {
  assert.match(conversation, /aria-label=\{`Message \$\{agentLabel\}`\}/)
  assert.match(conversation, /aria-describedby="uw-composer-hint"/)
  assert.match(conversation, /<small id="uw-composer-hint">\{hint\}<\/small>/)
})

test("the transcript is announced as a log region", () => {
  assert.match(conversation, /role="log"/)
  // The literal now lives in the dictionary; the transcript must still carry the label.
assert.match(conversation, /aria-label=\{t\("sf\.conversationTranscript"\)\}/)
})

test("a touch device is not told to press a key it does not have", () => {
  // A phone keyboard has no Ctrl or Cmd, so the old hint named the one way to send that was
  // unavailable there. Enter inserts a newline on touch; the Send button is the action.
  assert.doesNotMatch(conversation, /touchFirst \? "Ctrl\/Cmd\+Enter to send"/)
  assert.match(conversation, /touchFirst \? t\("sf\.ctrlEnterToSend"\) : t\("sf\.enterToSend"\)/)
  // The key handling itself is unchanged: Ctrl/Cmd+Enter still sends where a hardware keyboard exists.
  assert.match(conversation, /if \(!event\.ctrlKey && !event\.metaKey\) return/)
})
