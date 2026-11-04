import assert from "node:assert/strict"
import test from "node:test"

const { ActiveTurnSleepBlocker, activeAcpTurnCount } = await import("../dist-electron/electron/active-turn-sleep-blocker.js")

test("counts active ACP turns across harnesses", () => {
  assert.equal(activeAcpTurnCount({ services: {
    codex: { activeSessions: 1 },
    claude: { activeSessions: 2 },
    pi: { activeSessions: 0 }
  } }), 3)
  assert.equal(activeAcpTurnCount({ services: { codex: { activeSessions: "1" } } }), 0)
})

test("blocks sleep only while an ACP turn is active and releases on shutdown", async () => {
  let active = 0
  let starts = 0
  const stopped = []
  const guard = new ActiveTurnSleepBlocker(
    async () => active,
    () => { starts += 1; return starts },
    (id) => { stopped.push(id) }
  )
  await guard.refresh()
  assert.equal(starts, 0)
  active = 1
  await guard.refresh()
  await guard.refresh()
  assert.equal(starts, 1)
  active = 0
  await guard.refresh()
  assert.deepEqual(stopped, [1])
  active = 1
  await guard.refresh()
  guard.stop()
  assert.deepEqual(stopped, [1, 2])
})

test("keeps an active blocker through a temporary diagnostics failure", async () => {
  let fail = false
  const stopped = []
  const guard = new ActiveTurnSleepBlocker(
    async () => { if (fail) throw new Error("temporary outage"); return 1 },
    () => 42,
    (id) => { stopped.push(id) }
  )
  await guard.refresh()
  fail = true
  await guard.refresh()
  assert.deepEqual(stopped, [])
  guard.stop()
  assert.deepEqual(stopped, [42])
})
