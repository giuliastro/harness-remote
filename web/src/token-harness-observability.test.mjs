import assert from "node:assert/strict"
import { readMachineOptimization } from "./tokenHarnessClient.ts"

const config = {
  backend: "codex", host: "development.invalid", port: 4900,
  username: "harness", password: "secret"
}
const sample = {
  schemaVersion: 1,
  state: "available",
  observedAt: "2026-10-17T15:00:00.000Z",
  toolVersion: "0.1.31",
  agents: [{
    id: "codex", version: "0.160.0", state: "installed", optimizers: ["rtk"],
    allowanceState: "observed", allowanceObservedAt: "2026-10-17T15:00:00.000Z",
    windows: [{
      scope: "five-hour", bucketName: null, remainingPercent: null, usedPercent: null,
      resetsAt: null, observedAt: null, confidence: "cached", source: "native-cli"
    }]
  }],
  savings: [],
  metricsWindow: null,
  availability: { detection: true, allowance: true, savings: true }
}

const originalFetch = globalThis.fetch
try {
  const requests = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers })
    return { ok: true, status: 200, json: async () => sample }
  }
  assert.deepEqual(await readMachineOptimization(config), sample)
  assert.equal(requests[0].url, "http://development.invalid:4900/v1/optimization")
  assert.equal(requests[0].headers.Authorization, `Basic ${Buffer.from("harness:secret").toString("base64")}`)

  globalThis.fetch = async () => ({ ok: false, status: 404 })
  await assert.rejects(() => readMachineOptimization(config), /newer Harness Remote gateway/)

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ...sample, schemaVersion: 2 }) })
  await assert.rejects(() => readMachineOptimization(config), /Unsupported optimization response/)
} finally {
  globalThis.fetch = originalFetch
}
