import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parseAndroidAttentionActivation } from "./native-session-attention-android.ts"

const native = readFileSync(new URL("../native-android/LiveEventsPlugin.java", import.meta.url), "utf8")
const live = readFileSync(new URL("./native-session-attention-live.ts", import.meta.url), "utf8")
const transport = readFileSync(new URL("./taskdesk-live-events.ts", import.meta.url), "utf8")
const home = readFileSync(new URL("./components/native-session-home-attention.tsx", import.meta.url), "utf8")
const sync = readFileSync(new URL("../scripts/sync-native-live-events.mjs", import.meta.url), "utf8")

test("Android Attention activation accepts only the private exact-Session deep link", () => {
  assert.deepEqual(
    parseAndroidAttentionActivation("harnessremote://attention?machineID=machine-1&agentID=opencode&sessionID=session-123"),
    { machineID: "machine-1", agentID: "opencode", sessionID: "session-123" }
  )
  assert.equal(parseAndroidAttentionActivation("https://example.com/?machineID=x&agentID=y&sessionID=z"), null)
  assert.equal(parseAndroidAttentionActivation("harnessremote://attention?machineID=machine-1&agentID=opencode"), null)
  assert.equal(parseAndroidAttentionActivation("not a url"), null)
})

test("only the capability-scoped Attention stream carries native notification identity", () => {
  assert.match(live, /nativeAttention:[\s\S]*machineID: target\.machineID[\s\S]*questions: target\.agent\.capabilities\.questions === true[\s\S]*permissions: target\.agent\.capabilities\.permissions === true/)
  assert.match(transport, /parsed\.hash = new URLSearchParams/)
  assert.match(transport, /hrAttention: "1"/)
  assert.match(native, /String endpoint = stripFragment\(url\)/,
    "notification metadata must never be forwarded to the daemon request URL")
  assert.match(native, /context\.questions && \("question\.asked"\.equals\(type\) \|\| "question\.v2\.asked"\.equals\(type\)\)/)
  assert.match(native, /context\.permissions && \("permission\.asked"\.equals\(type\) \|\| "permission\.v2\.asked"\.equals\(type\)\)/)
})

test("native Attention notifications are fail-closed display only and deep-link to exact identity", () => {
  assert.match(native, /ATTENTION_CHANNEL_ID/)
  assert.match(native, /Manifest\.permission\.POST_NOTIFICATIONS/)
  assert.match(sync, /android\.permission\.POST_NOTIFICATIONS/)
  assert.match(native, /scheme\("harnessremote"\)/)
  assert.match(native, /authority\("attention"\)/)
  assert.match(native, /appendQueryParameter\("machineID", context\.machineID\)/)
  assert.match(native, /appendQueryParameter\("agentID", context\.agentID\)/)
  assert.match(native, /appendQueryParameter\("sessionID", sessionID\)/)
  assert.match(native, /If you do nothing, this request stays blocked\./)
  assert.doesNotMatch(native, /\/session\/.*\/message|loadMessages|promptAsync|permission.*reply/i)
})

test("Android notification activation reuses the existing explicit Inbox Session opener", () => {
  assert.match(home, /subscribeAndroidAttentionActivation\(activateAttention\)/)
  assert.match(home, /candidate\.machineID === activation\.machineID && candidate\.agent\.id === activation\.agentID/)
  assert.match(home, /openAttentionSession\(target, activation\.sessionID\)/)
  assert.doesNotMatch(home, /subscribeAndroidAttentionActivation[\s\S]*loadMessages/)
})
