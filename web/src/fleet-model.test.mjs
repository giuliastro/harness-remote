import assert from "node:assert/strict"
import test from "node:test"
import { discoverFleet, fleetTaskID, groupProfilesByMachineEndpoint, machineEndpointKey } from "./fleetModel.ts"

const baseConfig = { backend: "codex", host: "workstation.local", port: 4097, username: "harness", password: "secret" }

function profile(id, name, config = {}) {
  return { id, name, config: { ...baseConfig, ...config } }
}

function task(machineId, id = "task-1") {
  return {
    id,
    machineId,
    projectId: `project:${machineId}`,
    project: { name: "repo", path: "/repo", kind: "git" },
    agentId: "codex",
    prompt: "Do work",
    status: "running",
    workspace: { mode: "worktree", path: "/worktree" },
    run: { id: "run-1", sessionId: "session-1", status: "running" },
    createdAt: "2026-08-14T00:00:00Z",
    updatedAt: "2026-08-14T00:00:00Z"
  }
}

function observation(machineId, name = machineId) {
  return {
    machine: { machine: { id: machineId, name }, agents: [] },
    projects: [],
    tasks: []
  }
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

test("tries alternate profiles for one daemon before declaring the machine unreachable", async () => {
  const profiles = [
    profile("stale", "Workstation stale", { agentId: "codex", password: "old" }),
    profile("valid", "Workstation valid", { backend: "claude", agentId: "claude", password: "new" })
  ]
  const attempts = []
  const fleet = await discoverFleet(profiles, async (config) => {
    attempts.push(config.password)
    if (config.password === "old") throw new Error("unauthorized")
    return observation("machine:workstation", "Workstation")
  })
  assert.deepEqual(attempts, ["old", "new"])
  assert.equal(fleet.length, 1)
  assert.equal(fleet[0].state, "online")
  assert.equal(fleet[0].config.password, "new")
  assert.deepEqual(fleet[0].profileIds, ["stale", "valid"])
})

test("discovers two machines simultaneously and preserves daemon identity", async () => {
  const profiles = [
    profile("workstation", "Workstation"),
    profile("server", "Server", { host: "server.local" })
  ]
  const fleet = await discoverFleet(profiles, async (config) => {
    const machineId = `machine:${config.host}`
    return {
      machine: {
        machine: { id: machineId, name: config.host },
        agents: [{ id: "codex", label: "Codex", backend: "codex", transport: "acp", managed: true, state: "available", capabilities: {} }]
      },
      projects: [{ id: `project:${config.host}`, machineId, name: "repo", path: "/repo", kind: "git" }],
      tasks: [task(machineId)]
    }
  })
  assert.deepEqual(fleet.map((entry) => entry.machineId).sort(), ["machine:server.local", "machine:workstation.local"])
  assert.deepEqual(fleet.map((entry) => entry.key).sort(), ["http://server.local:4097", "http://workstation.local:4097"])
  assert.ok(fleet.every((entry) => entry.state === "online"))
  assert.ok(fleet.every((entry) => entry.projects[0].machineId === entry.machineId))
})

test("overlapping local task and run ids remain unambiguous across machines", async () => {
  const profiles = [
    profile("workstation", "Workstation"),
    profile("server", "Server", { host: "server.local" })
  ]
  const fleet = await discoverFleet(profiles, async (config) => {
    const machineId = `machine:${config.host}`
    return {
      machine: { machine: { id: machineId, name: config.host }, agents: [] },
      projects: [],
      tasks: [task(machineId, "shared-task-id")]
    }
  })
  const taskIds = fleet.flatMap((machine) => machine.tasks.map((candidate) => candidate.fleetId))
  assert.equal(new Set(taskIds).size, 2)
  assert.deepEqual(taskIds.sort(), [
    fleetTaskID("machine:server.local", "shared-task-id"),
    fleetTaskID("machine:workstation.local", "shared-task-id")
  ].sort())
  assert.ok(fleet.every((machine) => machine.tasks[0].run.id === "run-1"))
})

test("one unreachable machine does not hide reachable machines", async () => {
  const profiles = [
    profile("workstation", "Workstation"),
    profile("laptop", "Laptop", { host: "laptop.local" })
  ]
  const fleet = await discoverFleet(profiles, async (config) => {
    if (config.host === "laptop.local") throw new Error("offline")
    return observation("machine:workstation", "Workstation")
  })
  assert.equal(fleet.length, 2)
  assert.equal(fleet[0].state, "online")
  assert.equal(fleet[0].machineId, "machine:workstation")
  // The endpoint keys the row so it survives going offline; the id is only known once it answers.
  assert.equal(fleet[0].key, "http://workstation.local:4097")
  assert.equal(fleet[1].machineId, null)
  assert.equal(fleet[1].state, "unreachable")
  assert.equal(fleet[1].tasks.length, 0)
  assert.match(fleet[1].error, /offline/)
})

// A laptop is `localhost` to itself and a LAN address to the phone, so endpoint grouping alone
// reports it twice. Only the daemon can say they are the same machine, and it does — once it
// answers, the rows fold into one carrying both saved profiles.
test("one daemon reached by two addresses is one machine", async () => {
  const profiles = [
    profile("local", "Local", { host: "localhost" }),
    profile("lan", "LAN", { host: "192.168.1.64" })
  ]
  const fleet = await discoverFleet(profiles, async () => observation("machine:workstation", "Workstation"))
  assert.equal(fleet.length, 1, "the same daemon must not appear as two machines")
  assert.equal(new Set(fleet.map((entry) => entry.key)).size, fleet.length, "rows must not share a key")
  assert.deepEqual(fleet[0].profileIds.sort(), ["lan", "local"], "both saved profiles must stay attached to the machine")
  assert.equal(fleet[0].machineId, "machine:workstation")
})

test("machines that never answered stay separate rows", async () => {
  const profiles = [
    profile("local", "Local", { host: "localhost" }),
    profile("lan", "LAN", { host: "192.168.1.64" })
  ]
  const fleet = await discoverFleet(profiles, async () => { throw new Error("offline") })
  assert.equal(fleet.length, 2, "without an identity there is nothing to fold on")
  assert.ok(fleet.every((entry) => entry.machineId === null))
})
