import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { loadMachineIdentity, MachineRegistry } from "../src/machine-registry.js"

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

test("rejects duplicate host identities", () => {
  const registry = new MachineRegistry({ id: "machine_test", name: "workstation" })
  registry.registerHost({ id: "codex" })
  assert.throws(() => registry.registerHost({ id: "codex" }), /already registered/)
})
