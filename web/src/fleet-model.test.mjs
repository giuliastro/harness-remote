import assert from "node:assert/strict"
import test from "node:test"
import { discoverFleet, groupProfilesByMachineEndpoint, machineEndpointKey } from "./fleetModel.ts"

const baseConfig = { backend: "codex", host: "workstation.local", port: 4097, username: "harness", password: "secret" }

function profile(id, name, config = {}) {
  return { id, name, config: { ...baseConfig, ...config } }
}

test("groups multiple agent profiles for one daemon into one machine endpoint", () => {
  const profiles = [
    profile("codex", "Workstation Codex", { agentId: "codex" }),
    profile("claude", "Workstation Claude", { backend: "claude", agentId: "claude" }),
    profile("server", "Server", { host: "server.local", agentId: "codex" })
  ]
  const groups = groupProfilesByMachineEndpoint(profiles)
  assert.equal(groups.size, 2)
  assert.equal(groups.get(machineEndpointKey(baseConfig))?.length, 2)
})

test("discovers two machines simultaneously and preserves daemon identity", async () => {
  const profiles = [
    profile("workstation", "Workstation"),
    profile("server", "Server", { host: "server.local" })
  ]
  const fleet = await discoverFleet(profiles, async (config) => ({
    machine: {
      machine: { id: `machine:${config.host}`, name: config.host },
      agents: [{ id: "codex", label: "Codex", backend: "codex", transport: "acp", managed: true, state: "available", capabilities: {} }]
    },
    projects: [{ id: `project:${config.host}`, machineId: `machine:${config.host}`, name: "repo", path: "/repo", kind: "git" }]
  }))
  assert.deepEqual(fleet.map((entry) => entry.key).sort(), ["machine:server.local", "machine:workstation.local"])
  assert.ok(fleet.every((entry) => entry.state === "online"))
  assert.ok(fleet.every((entry) => entry.projects[0].machineId === entry.key))
})

test("one unreachable machine does not hide reachable machines", async () => {
  const profiles = [
    profile("workstation", "Workstation"),
    profile("laptop", "Laptop", { host: "laptop.local" })
  ]
  const fleet = await discoverFleet(profiles, async (config) => {
    if (config.host === "laptop.local") throw new Error("offline")
    return {
      machine: { machine: { id: "machine:workstation", name: "Workstation" }, agents: [] },
      projects: []
    }
  })
  assert.equal(fleet.length, 2)
  assert.equal(fleet[0].state, "online")
  assert.equal(fleet[0].key, "machine:workstation")
  assert.equal(fleet[1].state, "unreachable")
  assert.match(fleet[1].error, /offline/)
})
