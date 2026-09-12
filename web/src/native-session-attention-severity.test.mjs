import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { attentionInboxCounts } from "./components/native-session-home.tsx"

const item = (kind, reason) => ({ attention: { kind, reason } })

assert.deepEqual(attentionInboxCounts([
  item("authorization", "permission"),
  item("authorization", "permission"),
  item("recoverable", "question"),
  item("rejected", "status")
]), {
  authorization: 2,
  recoverable: 1,
  rejected: 1,
  total: 4
}, "the Inbox summary must preserve distinct authorization, recoverable and rejected counts")

assert.deepEqual(attentionInboxCounts([]), {
  authorization: 0,
  recoverable: 0,
  rejected: 0,
  total: 0
}, "an empty Inbox must not synthesize attention")

const source = readFileSync(new URL("./components/native-session-home-attention.tsx", import.meta.url), "utf8")
assert.match(source, /Authorization required/, "authorization must keep its explicit label")
assert.match(source, /Needs input/, "question-driven recoverable attention must be visibly identified as input")
assert.match(source, /Request rejected/, "rejected\/fail-closed attention must not look retryable")
assert.match(source, /This request was rejected and will not proceed automatically/, "rejected attention must explain that it will not resume by itself")
assert.match(source, /counts\.authorization[\s\S]*counts\.recoverable[\s\S]*counts\.rejected/, "the heading must expose severity-specific counts")
assert.match(source, /inbox\.map\(\(entry\) => sessionKey\(entry\.target, entry\.item\.sessionID\)\)/, "every explicit Inbox entry must contribute its canonical Session identity to the mobile badge")
assert.match(source, /mergedAttentionSessionCount\(baseAttentionKeys, inboxSessionKeys\)/, "the mobile badge must include Inbox attention without double-counting Sessions already marked by the rail")
assert.doesNotMatch(source, /loadMessagePage|continueConversation|stopConversation|startTaskDeskSessionLiveRefresh/, "severity presentation must stay outside transcript and writer paths")

const css = readFileSync(new URL("./native-session-attention-inbox.css", import.meta.url), "utf8")
assert.match(css, /\.hr-native-attention-counts/, "severity counts must have a compact badge container")
assert.match(css, /small\.authorization/, "authorization count must remain visually distinct")
assert.match(css, /small\.rejected/, "rejected count must remain visually distinct")
assert.match(css, /\.hr-native-attention-row\.rejected/, "rejected rows must remain visually distinct")

console.log("native Session Attention Inbox severity tests passed")