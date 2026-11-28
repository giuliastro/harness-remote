import assert from "node:assert/strict"
import test from "node:test"
import {
  createBurstLimiter,
  discoveryPassLands,
  isStreamReconnecting,
  machinePollIntervalMs,
  MACHINE_NORMAL_POLL_MS,
  MACHINE_RECONNECT_POLL_MS,
  MACHINE_STREAM_POLL_MS,
  recoveringStreamCount
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

test("a broken adapter keeps the machine snapshot current", () => {
  assert.equal(
    machinePollIntervalMs({ reconnecting: false, machineCount: 1, connectedStreamCount: 1, unsettledAgents: true }),
    MACHINE_NORMAL_POLL_MS
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

test("isStreamReconnecting identifies recovery statuses", () => {
  assert.equal(isStreamReconnecting("reconnecting"), true)
  assert.equal(isStreamReconnecting("connection-error"), true)
  assert.equal(isStreamReconnecting("closed"), true)
  assert.equal(isStreamReconnecting({ type: "reconnecting", delayMs: 1500 }), true)
  assert.equal(isStreamReconnecting({ type: "connection-error", error: "fail" }), true)
  assert.equal(isStreamReconnecting({ type: "closed" }), true)
  assert.equal(isStreamReconnecting("connected"), false)
  assert.equal(isStreamReconnecting({ type: "connected" }), false)
  assert.equal(isStreamReconnecting("parse-error"), false)
  assert.equal(isStreamReconnecting(undefined), false)
  assert.equal(isStreamReconnecting(null), false)
})

test("stream recovery transitions between safety net, reconnect cadence, and back", () => {
  // 1. Initial healthy state: stream is connected
  let streamStatus = "connected"
  let connectedStreamCount = streamStatus === "connected" ? 1 : 0
  let reconnecting = isStreamReconnecting(streamStatus)
  assert.equal(
    machinePollIntervalMs({ reconnecting, machineCount: 1, connectedStreamCount }),
    MACHINE_STREAM_POLL_MS,
    "healthy connected stream uses safety net"
  )

  // 2. Stream drops into reconnecting / connection-error / closed: poll aggressively
  for (const status of ["reconnecting", "connection-error", "closed"]) {
    streamStatus = status
    connectedStreamCount = streamStatus === "connected" ? 1 : 0
    reconnecting = isStreamReconnecting(streamStatus)
    assert.equal(
      machinePollIntervalMs({ reconnecting, machineCount: 1, connectedStreamCount }),
      MACHINE_RECONNECT_POLL_MS,
      `stream in ${status} triggers fast reconnect poll`
    )
  }

  // 3. Stream recovers: back to safety net
  streamStatus = "connected"
  connectedStreamCount = streamStatus === "connected" ? 1 : 0
  reconnecting = isStreamReconnecting(streamStatus)
  assert.equal(
    machinePollIntervalMs({ reconnecting, machineCount: 1, connectedStreamCount }),
    MACHINE_STREAM_POLL_MS,
    "recovered stream returns to safety net"
  )
})

test("a healthy machine with a reconnecting stream uses fast reconnect poll instead of normal fallback", () => {
  // Discovery succeeded (reconnectingCount = 0), but the SSE stream is recovering
  const discoveryReconnecting = false
  const streamReconnecting = isStreamReconnecting("reconnecting")
  const reconnecting = discoveryReconnecting || streamReconnecting
  assert.equal(
    machinePollIntervalMs({ reconnecting, machineCount: 1, connectedStreamCount: 0 }),
    MACHINE_RECONNECT_POLL_MS
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

// Seen on the desktop app with one reachable machine and one saved machine that was offline: the
// offline machine's stream kept "reconnecting", which kept the 1.5s cadence on for good.
test("an offline machine's reconnecting stream does not keep the fast cadence on", () => {
  const runtimes = [
    { machine: { id: "local" }, state: "online", snapshot: {} },
    { machine: { id: "zorin" }, state: "offline" }
  ]
  assert.equal(recoveringStreamCount(["local", "zorin"], { zorin: true }, runtimes), 0)
  assert.equal(recoveringStreamCount(["local", "zorin"], { local: true, zorin: true }, runtimes), 1, "a reachable machine that is recovering still counts")
  assert.equal(recoveringStreamCount(["local"], {}, runtimes), 0)
})

// Every refresh restarted the Session index read, and the old read was always dropped. With a read
// that takes 8s and a refresh every 1.5s nothing ever landed, so the slower harnesses stayed on
// "Starting…" for good.
test("Session index reads restarted faster than they finish still land, in order", () => {
  const identity = "local|zorin"
  const simulate = (lands) => {
    let lastApplied = 0
    const applied = []
    const readMs = 8_000, everyMs = 1_500
    const passes = Array.from({ length: 20 }, (_, index) => ({ number: index + 1, start: index * everyMs, end: index * everyMs + readMs }))
    for (const pass of [...passes].sort((left, right) => left.end - right.end)) {
      const superseded = passes.some((other) => other.number > pass.number && other.start <= pass.end)
      if (!lands({ number: pass.number, identity, superseded }, { lastApplied, currentIdentity: identity })) continue
      lastApplied = pass.number
      applied.push(pass.number)
    }
    return applied
  }
  const dropEverySuperseded = (pass) => !pass.superseded
  assert.deepEqual(simulate(dropEverySuperseded), [20], "the old rule only ever lands the very last read, after the restarts stop")
  const applied = simulate(discoveryPassLands)
  assert.equal(applied.length, 20, "every read lands")
  assert.deepEqual(applied, [...applied].sort((left, right) => left - right), "never an older read over a newer one")
})

test("a superseded Session index read is dropped when the machines changed, or a newer read landed", () => {
  assert.equal(discoveryPassLands({ number: 3, identity: "a", superseded: true }, { lastApplied: 2, currentIdentity: "b" }), false)
  assert.equal(discoveryPassLands({ number: 3, identity: "a", superseded: false }, { lastApplied: 4, currentIdentity: "a" }), false)
  assert.equal(discoveryPassLands({ number: 3, identity: "a", superseded: true }, { lastApplied: 2, currentIdentity: "a" }), true)
})
