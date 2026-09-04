import assert from "node:assert/strict"
import test from "node:test"
import {
  createBurstLimiter,
  machinePollIntervalMs,
  MACHINE_NORMAL_POLL_MS,
  MACHINE_RECONNECT_POLL_MS,
  MACHINE_STREAM_POLL_MS
} from "./machine-live-refresh.ts"

test("a flapping machine outranks any stream coverage", () => {
  assert.equal(
    machinePollIntervalMs({ reconnecting: true, machineCount: 2, connectedStreamCount: 2 }),
    MACHINE_RECONNECT_POLL_MS
  )
})

test("full stream coverage demotes the timer to a safety net", () => {
  assert.equal(
    machinePollIntervalMs({ reconnecting: false, machineCount: 2, connectedStreamCount: 2 }),
    MACHINE_STREAM_POLL_MS
  )
})

test("a machine without a stream keeps the whole poll at the normal cadence", () => {
  assert.equal(
    machinePollIntervalMs({ reconnecting: false, machineCount: 2, connectedStreamCount: 1 }),
    MACHINE_NORMAL_POLL_MS
  )
})

test("zero machines never claims stream coverage", () => {
  assert.equal(
    machinePollIntervalMs({ reconnecting: false, machineCount: 0, connectedStreamCount: 0 }),
    MACHINE_NORMAL_POLL_MS
  )
})

function fakeTimers() {
  let next = 1
  const scheduled = new Map()
  return {
    timers: {
      set(callback, delayMs) {
        const id = next++
        scheduled.set(id, { callback, delayMs })
        return id
      },
      clear(id) {
        scheduled.delete(id)
      }
    },
    pending: () => scheduled.size,
    advance() {
      for (const [id, entry] of [...scheduled]) {
        scheduled.delete(id)
        entry.callback()
      }
    }
  }
}

test("the first event refreshes immediately", () => {
  const clock = fakeTimers()
  const limiter = createBurstLimiter(400, clock.timers)
  let runs = 0
  limiter.request(() => { runs += 1 })
  assert.equal(runs, 1)
})

test("a burst inside the window collapses to one trailing refresh", () => {
  const clock = fakeTimers()
  const limiter = createBurstLimiter(400, clock.timers)
  let runs = 0
  const bump = () => { runs += 1 }
  for (let index = 0; index < 25; index += 1) limiter.request(bump)
  assert.equal(runs, 1, "leading refresh only while the window is open")
  clock.advance()
  assert.equal(runs, 2, "one trailing refresh for the whole burst")
  clock.advance()
  assert.equal(runs, 2, "an idle window does not manufacture refreshes")
})

test("cancel drops a queued trailing refresh", () => {
  const clock = fakeTimers()
  const limiter = createBurstLimiter(400, clock.timers)
  let runs = 0
  const bump = () => { runs += 1 }
  limiter.request(bump)
  limiter.request(bump)
  limiter.cancel()
  clock.advance()
  assert.equal(runs, 1)
  assert.equal(clock.pending(), 0, "no timer survives an unmounted subscription")
})
