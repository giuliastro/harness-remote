import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  availableMachineAgentCount,
  checkingMachineHealth,
  offlineMachineHealth,
  onlineMachineHealth
} from "./machine-manager-health.ts"

test("retry keeps the last known snapshot visible while a machine is checking again", () => {
  const snapshot = { agents: [{ state: "available" }] }
  assert.deepEqual(checkingMachineHealth(onlineMachineHealth(snapshot)), {
    state: "checking",
    snapshot
  })
})

test("offline health preserves the real transport error instead of reducing it to unavailable", () => {
  assert.deepEqual(offlineMachineHealth(new Error("Network timeout while reaching 192.168.1.44")), {
    state: "offline",
    error: "Network timeout while reaching 192.168.1.44"
  })
  assert.deepEqual(offlineMachineHealth(), { state: "offline" })
})

test("manager footer counts available agents only from confirmed online machines", () => {
  const checks = {
    online: onlineMachineHealth({ agents: [{ state: "available" }, { state: "unavailable" }] }),
    checking: checkingMachineHealth(onlineMachineHealth({ agents: [{ state: "available" }] })),
    offline: offlineMachineHealth("connection refused")
  }
  assert.equal(availableMachineAgentCount(checks), 1)
})

test("machine discovery never presents a cached online snapshot unless a caller explicitly opts in", () => {
  const source = readFileSync(new URL("./machineClient.ts", import.meta.url), "utf8")
  assert.match(source, /allowCachedOnTransportFailure = options\.allowCachedOnTransportFailure === true/)
  assert.doesNotMatch(source, /allowCachedOnTransportFailure = options\.allowCachedOnTransportFailure !== false/)
})
