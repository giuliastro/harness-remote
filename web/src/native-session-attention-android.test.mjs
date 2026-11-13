import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { parseAndroidAttentionActivation } from "./native-session-attention-android.ts"

const moduleSource = readFileSync(new URL("./native-session-attention-android.ts", import.meta.url), "utf8")
const homeSource = readFileSync(new URL("./components/native-session-home-attention.tsx", import.meta.url), "utf8")

assert.deepEqual(
  parseAndroidAttentionActivation("harnessremote://attention?machineID=machine-1&agentID=opencode&sessionID=session-123"),
  { machineID: "machine-1", agentID: "opencode", sessionID: "session-123" }
)
assert.deepEqual(
  parseAndroidAttentionActivation("harnessremote://attention?machineID=machine%201&agentID=a%2Fb&sessionID=session%2D1"),
  { machineID: "machine 1", agentID: "a/b", sessionID: "session-1" }
)

for (const invalid of [
  "https://example.com/?machineID=m&agentID=a&sessionID=s",
  "harnessremote://pair?machineID=m&agentID=a&sessionID=s",
  "harnessremote://attention?machineID=m&agentID=a",
  "harnessremote://attention?machineID=&agentID=a&sessionID=s",
  "harnessremote://attention?machineID=m%0A&agentID=a&sessionID=s",
  "not a url"
]) {
  assert.equal(parseAndroidAttentionActivation(invalid), null, `must reject ${invalid}`)
}

assert.equal(
  parseAndroidAttentionActivation(`harnessremote://attention?machineID=${"m".repeat(513)}&agentID=a&sessionID=s`),
  null,
  "an overlong native identity must not become an activation"
)

assert.match(moduleSource, /App\.addListener\("appUrlOpen"/)
assert.match(moduleSource, /App\.getLaunchUrl\(\)/)
assert.match(moduleSource, /MAX_SEEN_ACTIVATIONS = 50/, "activation replay memory must stay bounded")
assert.match(moduleSource, /attentionAuthority\(parsed\) !== "attention"/)

assert.match(homeSource, /subscribeAndroidAttentionActivation\(activateAttention\)/)
assert.match(homeSource, /selectedNativeSessionFromKey\(props\.selectedKey\)[\s\S]*syncVisibleNativeSession\(visible\)/)
// A Ready/Failed tap can come from any harness, so the target is resolved among every available one.
assert.match(homeSource, /const target = findSessionTarget\(activation\.machineID, activation\.agentID\)/)
assert.match(homeSource, /pendingActivationRef\.current = activation/)
assert.match(homeSource, /pendingActivationRef\.current = null[\s\S]*openAttentionSession\(target, pending\.sessionID\)/)
assert.doesNotMatch(homeSource, /subscribeAndroidAttentionActivation[\s\S]*loadMessages/)
