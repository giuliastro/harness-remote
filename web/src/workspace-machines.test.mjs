import assert from "node:assert/strict"
import test from "node:test"
import { sameMachineConnection } from "./machineConnection.ts"

const connection = (overrides = {}) => ({
  backend: "opencode",
  host: "machine.local",
  port: 4096,
  username: "harness",
  password: "test-password",
  ...overrides
})

test("a saved machine snapshot is reused only for the same connection", () => {
  assert.equal(sameMachineConnection(connection(), connection({ host: "MACHINE.LOCAL" })), true)
  assert.equal(sameMachineConnection(connection(), connection({ port: 4097 })), false)
  assert.equal(sameMachineConnection(connection(), connection({ username: "other" })), false)
  assert.equal(sameMachineConnection(connection(), connection({ password: "corrected-password" })), false)
  assert.equal(sameMachineConnection(connection(), connection({ agentId: "codex" })), false)
})
