import assert from "node:assert/strict"
import test from "node:test"
import { acpHarnessCapabilityContract } from "../src/harness-capability-contract.js"
import { harnessProfile } from "../src/harness-profiles.js"

test("Copilot provider uses the native ACP stdio server without changing established defaults", () => {
  const provider = harnessProfile("copilot")

  assert.equal(provider.label, "GitHub Copilot CLI")
  assert.equal(provider.command, "copilot")
  assert.deepEqual(provider.args, ["--acp", "--stdio"])
  assert.deepEqual(provider.detectCommands, ["copilot"])
  assert.equal(provider.launchPriority, 50)
  assert.equal(provider.permissionMode, "allow")
})

test("Copilot provider defers model selection to the native CLI when ACP exposes no catalog", () => {
  const provider = harnessProfile("copilot")
  const contract = acpHarnessCapabilityContract(provider)

  assert.equal(provider.capabilities.sessions, true)
  assert.equal(provider.capabilities.prompt, true)
  assert.equal(provider.capabilities.abort, true)
  assert.equal(provider.capabilities.streaming, true)
  assert.equal(provider.capabilities.permissions, true)
  assert.equal(provider.capabilities.commands, true)

  assert.equal(provider.capabilities.models, false)
  assert.equal(provider.capabilities.todos, false)
  assert.equal(provider.capabilities.questions, false)
  assert.equal(provider.capabilities.actions, false)
  assert.equal(provider.capabilities.sessionRename, false)
  assert.equal(provider.capabilities.sessionDelete, false)

  assert.equal(contract.protocol, "acp")
  assert.equal(contract.sessions.discovery, "native-list")
  assert.equal(contract.sessions.transcript, "session-load")
  assert.equal(contract.sessions.continuation, "session-load")
  assert.equal(contract.sessions.stop, "owned-session-native-cancel")
  assert.equal(contract.lifecycle.reconnect, "daemon-reconciliation")
  assert.equal(contract.models.selection, "harness-default")
  assert.equal(contract.models.source, "acp-config-options")
  assert.deepEqual(contract.models.variantConfigIDs, [])
})
