import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const native = readFileSync(new URL("../native-android/LiveEventsPlugin.java", import.meta.url), "utf8")
const transport = readFileSync(new URL("./opencode-events.ts", import.meta.url), "utf8")
const taskdesk = readFileSync(new URL("./taskdesk-live-events.ts", import.meta.url), "utf8")

assert.match(native, /Map<String, StreamHandle> streams = new ConcurrentHashMap<>\(\)/,
  "Android must keep one independently owned stream per logical subscription")
assert.match(native, /Executors\.newCachedThreadPool\(\)/,
  "long-lived native streams cannot share a single-thread executor")
assert.match(native, /call\.getString\("subscriptionID"\)/)
assert.match(native, /stopStream\(subscriptionID, false\)/,
  "starting one subscription may replace only itself, never sibling sockets")
assert.match(native, /streams\.remove\(subscriptionID\)/,
  "stop must be scoped to the requested subscription")
assert.match(native, /payload\.put\("subscriptionID", subscriptionID\)/,
  "native events and statuses must carry ownership back to the WebView")
assert.match(native, /setRequestProperty\("X-Harness-Backend", backend\)/,
  "Android SSE must preserve daemon backend routing")
assert.doesNotMatch(native, /Executors\.newSingleThreadExecutor\(\)/)
assert.doesNotMatch(native, /private volatile HttpURLConnection connection;/,
  "socket state must live inside each StreamHandle, not on the plugin singleton")

assert.match(transport, /const subscriptionID = nativeSubscriptionID\(\)/)
assert.match(transport, /owner !== subscriptionID/,
  "each JS listener must ignore native events owned by another subscription")
assert.match(transport, /status\.subscriptionID !== subscriptionID/,
  "status updates must be isolated exactly like event payloads")
assert.match(transport, /NativeLiveEvents\.start\(\{[\s\S]*subscriptionID,[\s\S]*backend: options\.backend/)
assert.match(transport, /NativeLiveEvents\.stop\(\{ subscriptionID \}\)/,
  "closing Session detail or Attention must stop only its own native socket")
assert.doesNotMatch(transport, /NativeLiveEvents\.stop\(\)/)

assert.match(taskdesk, /backend: config\.backend/,
  "selected harness routing must cross the Android native transport boundary")

console.log("Android native live-event multiplexing regression tests passed")
