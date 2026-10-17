import assert from "node:assert/strict"
import test from "node:test"
import { createTokenHarnessObserver, projectTokenHarnessObservations } from "../src/token-harness-observability.js"

const doctor = {
  schemaVersion: 1, command: "doctor", toolVersion: "0.1.31",
  data: {
    harnesses: [{ harnessId: "codex", state: "installed", version: "0.160.0" },
      { harnessId: "claude", state: "installed", version: "2.1.280" }],
    providers: [{ providerId: "rtk", state: "configured", configuredHarnesses: ["codex"] }]
  }
}
const budget = {
  schemaVersion: 1, command: "budget",
  data: {
    observedAt: "2026-10-17T10:00:00Z",
    harnesses: [{
      harnessId: "codex", state: "observed",
      windows: [
        { scope: "five-hour", remainingPercent: 55, resetsAt: "2026-10-17T12:00:00Z", source: "native-cli", confidence: "reported" },
        { scope: "weekly", remainingPercent: null, resetsAt: null, confidence: "cached" }
      ]
    }]
  }
}
const metrics = {
  schemaVersion: 1, command: "metrics",
  data: {
    windowStart: "2026-10-10", windowEnd: "2026-10-17",
    providers: [
      { providerId: "rtk", saved: 120, unit: "tokens", class: "exact-local", operations: 2, harnesses: ["codex"] },
      { providerId: "trim", saved: 900, unit: "chars", class: "estimated-local", operations: 1, harnesses: ["claude"] }
    ]
  }
}

test("projects allowance as measured, retaining unknown rather than inventing 0", () => {
  const value = projectTokenHarnessObservations(doctor, budget, metrics, "2026-10-17T10:01:00Z")
  assert.equal(value.state, "available")
  assert.equal(value.agents[0].windows[0].remainingPercent, 55)
  assert.equal(value.agents[0].windows[1].remainingPercent, null)
  assert.equal(value.agents[0].windows[1].confidence, "cached")
  assert.deepEqual(value.agents[0].optimizers, ["rtk"])
  assert.equal(value.agents[1].allowanceState, "unavailable")
  assert.deepEqual(value.savings.map((row) => [row.saved, row.unit, row.measurementClass]), [
    [120, "tokens", "exact-local"], [900, "chars", "estimated-local"]
  ])
})

test("unavailable executable is an explicit absent state, not empty remaining quota", async () => {
  let attempts = 0
  const observe = createTokenHarnessObserver({ execute: async () => { attempts += 1; throw new Error("ENOENT") }, now: () => 1_000 })
  const [left, right] = await Promise.all([observe(), observe()])
  assert.deepEqual(left, right)
  assert.equal(attempts, 1)
  assert.equal(left.state, "unavailable")
  assert.deepEqual(left.agents, [])
  assert.equal(left.availability.allowance, false)
})

test("partial read failures preserve doctor detections and never claim quota", async () => {
  const observe = createTokenHarnessObserver({
    execute: async (command) => {
      if (command === "doctor") return doctor
      if (command === "budget") throw new Error("reader unavailable")
      return metrics
    },
    now: () => 2_000
  })
  const snapshot = await observe()
  assert.equal(snapshot.state, "partial")
  assert.equal(snapshot.agents.length, 2)
  assert.equal(snapshot.agents[0].allowanceState, "unavailable")
  assert.deepEqual(snapshot.agents[0].windows, [])
  assert.equal(snapshot.availability.allowance, false)
  assert.equal(snapshot.availability.savings, true)
})

test("cached observation refreshes after TTL without overlapping command sets", async () => {
  let time = 1_000
  const commands = []
  const observe = createTokenHarnessObserver({
    execute: async (command) => { commands.push(command); return { doctor, budget, metrics }[command] },
    now: () => time,
    ttlMs: 100
  })
  await observe()
  time += 50
  await observe()
  assert.equal(commands.length, 3)
  time += 101
  await observe()
  assert.equal(commands.length, 6)
})
