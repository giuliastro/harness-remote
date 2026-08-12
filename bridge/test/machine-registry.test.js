import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { loadMachineIdentity, MachineRegistry, trackAgentHostLifecycle } from "../src/machine-registry.js"

test("persists one stable machine identity across restarts", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-machine-"))
  t.after(() => rm(directory, { recursive: true, force: true }))

  const first = await loadMachineIdentity(directory, {
    randomUUID: () => "11111111-2222-3333-4444-555555555555",
    hostname: () => "workstation"
  })
  const second = await loadMachineIdentity(directory, {
    randomUUID: () => "different",
    hostname: () => "renamed-host"
  })

  assert.equal(first.id, "machine_11111111-2222-3333-4444-555555555555")
  assert.equal(first.name, "workstation")
  assert.deepEqual(second, first)
})

test("preserves a corrupt machine identity before generating a replacement", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-machine-corrupt-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, "machine.json"), "{broken json", "utf8")
  const warnings = []

  const identity = await loadMachineIdentity(directory, {
    randomUUID: () => "replacement",
    hostname: () => "workstation",
    warn: (message) => warnings.push(message)
  })

  assert.equal(identity.id, "machine_replacement")
  assert.equal(warnings.length, 1)
  const files = await readdir(directory)
  const corrupt = files.find((file) => file.startsWith("machine.json.corrupt-"))
  assert.ok(corrupt)
  assert.equal(await readFile(path.join(directory, corrupt), "utf8"), "{broken json")
})

test("concurrent first starts converge on one machine identity", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "harness-machine-race-"))
  t.after(() => rm(directory, { recursive: true, force: true }))

  const [first, second] = await Promise.all([
    loadMachineIdentity(directory, { randomUUID: () => "first", hostname: () => "workstation" }),
    loadMachineIdentity(directory, { randomUUID: () => "second", hostname: () => "workstation" })
  ])

  assert.deepEqual(second, first)
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, "machine.json"), "utf8")), first)
})

test("represents multiple heterogeneous agent hosts on one machine", () => {
  const registry = new MachineRegistry({ id: "machine_test", name: "workstation" })
  registry.registerHost({
    id: "codex",
    label: "Codex CLI",
    backend: "codex",
    transport: "acp",
    capabilities: { sessions: true, models: true }
  })
  registry.registerHost({
    id: "opencode",
    label: "OpenCode",
    backend: "opencode",
    transport: "http",
    state: "available",
    capabilities: { sessions: true, permissions: true }
  })

  assert.deepEqual(registry.snapshot(), {
    machine: { id: "machine_test", name: "workstation" },
    agents: [
      {
        id: "codex",
        label: "Codex CLI",
        backend: "codex",
        transport: "acp",
        managed: true,
        state: "configured",
        capabilities: { sessions: true, models: true }
      },
      {
        id: "opencode",
        label: "OpenCode",
        backend: "opencode",
        transport: "http",
        managed: true,
        state: "available",
        capabilities: { sessions: true, permissions: true }
      }
    ]
  })
})

test("tracks host startup, failure, and recovery", async () => {
  class FakeAgent extends EventEmitter {
    starts = 0
    failNext = false

    async start() {
      this.starts += 1
      if (this.failNext) {
        this.failNext = false
        throw new Error("start failed")
      }
    }
  }

  const registry = new MachineRegistry({ id: "machine_test", name: "workstation" })
  registry.registerHost({ id: "codex" })
  const agent = trackAgentHostLifecycle(new FakeAgent(), registry, "codex")

  assert.equal(registry.host("codex").state, "configured")
  await agent.start()
  assert.equal(registry.host("codex").state, "available")

  agent.emit("exit", new Error("crashed"))
  assert.equal(registry.host("codex").state, "unavailable")

  await agent.start()
  assert.equal(registry.host("codex").state, "available")

  agent.failNext = true
  await assert.rejects(agent.start(), /start failed/)
  assert.equal(registry.host("codex").state, "unavailable")
})

test("rejects duplicate host identities", () => {
  const registry = new MachineRegistry({ id: "machine_test", name: "workstation" })
  registry.registerHost({ id: "codex" })
  assert.throws(() => registry.registerHost({ id: "codex" }), /already registered/)
})
