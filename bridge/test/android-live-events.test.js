import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("../../web/native-android/LiveEventsPlugin.java", import.meta.url), "utf8")

test("Android native SSE uses a finite read watchdog so sleep or Wi-Fi loss can reconnect", () => {
  assert.match(source, /STALL_TIMEOUT_MS\s*=\s*30000/)
  assert.match(source, /setReadTimeout\(STALL_TIMEOUT_MS\)/)
  assert.doesNotMatch(source, /setReadTimeout\(0\)/)
  assert.match(source, /publishStatus\("reconnecting"/)
})
