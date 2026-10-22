import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { attentionInboxCounts } from "./components/native-session-home-attention.tsx"

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
assert.match(source, /\{inbox\.length \|\| openError \?/, "the actionable list should appear only for pending items, with an open error shown when relevant")
assert.doesNotMatch(source, /hr-native-attention-heading|hr-native-attention-counts|Some status may be stale|pending<\/small>/, "the redundant global summary and stale-only warning must not occupy the workspace")
assert.match(source, /inbox\.map\(\(entry\) => sessionKey\(entry\.target, entry\.item\.sessionID\)\)/, "every explicit Inbox entry must contribute its canonical Session identity to the mobile badge")
assert.match(source, /mergedAttentionSessionCount\(baseAttentionKeys, inboxSessionKeys\)/, "the mobile badge must include Inbox attention without double-counting Sessions already marked by the rail")
assert.doesNotMatch(source, /loadMessagePage|continueConversation|stopConversation|startTaskDeskSessionLiveRefresh/, "severity presentation must stay outside transcript and writer paths")

const css = readFileSync(new URL("./native-session-attention-inbox.css", import.meta.url), "utf8")
assert.doesNotMatch(css, /hr-native-attention-heading|hr-native-attention-counts/, "the removed summary must not retain layout styles")
assert.match(css, /\.hr-native-attention-row\.authorization/, "authorization rows must remain visually distinct")
assert.match(css, /\.hr-native-attention-row\.rejected/, "rejected rows must remain visually distinct")

console.log("native Session Attention Inbox severity tests passed")
