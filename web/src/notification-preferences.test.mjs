import assert from "node:assert/strict"
import test from "node:test"
import {
  defaultNotificationPreferences,
  normalizeNotificationPreferences,
  notificationKindEnabled
} from "./notification-preferences.ts"

test("installed apps notify by default; the web waits for the user to turn it on", () => {
  assert.deepEqual(defaultNotificationPreferences("desktop"), { enabled: true, ready: true, failed: true, attention: true })
  assert.deepEqual(defaultNotificationPreferences("android"), { enabled: true, ready: true, failed: true, attention: true })
  assert.deepEqual(defaultNotificationPreferences("web"), { enabled: false, ready: true, failed: true, attention: true })
})

test("stored values are kept and invalid ones fall back to the platform default", () => {
  assert.deepEqual(
    normalizeNotificationPreferences({ enabled: true, ready: false, failed: "yes", attention: false }, "web"),
    { enabled: true, ready: false, failed: true, attention: false }
  )
  assert.deepEqual(normalizeNotificationPreferences("garbage", "desktop"), defaultNotificationPreferences("desktop"))
})

test("the master switch silences every kind", () => {
  const off = { enabled: false, ready: true, failed: true, attention: true }
  assert.equal(notificationKindEnabled("ready", off), false)
  assert.equal(notificationKindEnabled("attention", off), false)
  const onlyFailed = { enabled: true, ready: false, failed: true, attention: false }
  assert.equal(notificationKindEnabled("ready", onlyFailed), false)
  assert.equal(notificationKindEnabled("failed", onlyFailed), true)
})
