import assert from "node:assert/strict"
import test from "node:test"
import { acpHarnessCapabilityContract } from "../src/harness-capability-contract.js"
import { harnessProfile } from "../src/harness-profiles.js"

test("OpenCode 2 provider uses the dedicated binary alias and rich ACP surface", () => {
  const provider = harnessProfile("opencode2")
  const contract = acpHarnessCapabilityContract(provider)

  assert.equal(provider.label, "OpenCode 2")
  assert.equal(provider.command, process.platform === "win32" ? "npx.cmd" : "npx")
  assert.deepEqual(provider.args, ["--yes", "--package=@opencode/cli", "opencode", "acp"])
  assert.equal(provider.adapterCommand, "opencode2")
  assert.deepEqual(provider.adapterArgs, ["acp"])
  assert.equal(provider.allowPackageFallback, true)
  assert.deepEqual(provider.detectCommands, ["opencode2"])
  assert.equal(provider.launchPriority, 60)

  assert.equal(provider.capabilities.sessions, true)
  assert.equal(provider.capabilities.prompt, true)
  assert.equal(provider.capabilities.abort, true)
  assert.equal(provider.capabilities.streaming, true)
  assert.equal(provider.capabilities.models, true)
  assert.equal(provider.capabilities.commands, true)
  assert.equal(provider.capabilities.permissions, true)
  assert.equal(provider.capabilities.sessionRename, false)
  assert.equal(provider.capabilities.sessionDelete, false)

  assert.deepEqual(contract.models.variantConfigIDs, ["effort"])
  assert.equal(contract.sessions.discovery, "native-list")
  assert.equal(contract.sessions.transcript, "session-load")
})

test("MiMo provider keeps a conservative surface after real ACP lifecycle validation", () => {
  const provider = harnessProfile("mimo")
  const contract = acpHarnessCapabilityContract(provider)

  assert.equal(provider.label, "MiMo Code")
  assert.equal(provider.command, "mimo")
  assert.deepEqual(provider.args, ["acp"])
  assert.deepEqual(provider.detectCommands, ["mimo"])
  assert.equal(provider.launchPriority, 70)
  assert.equal(provider.authenticate, false)
  assert.deepEqual(provider.environment, {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "mimo/mimo-auto" })
  })

  assert.equal(provider.capabilities.sessions, true)
  assert.equal(provider.capabilities.prompt, true)
  assert.equal(provider.capabilities.abort, true)
  assert.equal(provider.capabilities.streaming, true)
  assert.equal(provider.capabilities.permissions, true)

  assert.equal(provider.capabilities.models, false)
  assert.equal(provider.capabilities.commands, false)
  assert.equal(provider.capabilities.todos, false)
  assert.equal(provider.capabilities.questions, false)
  assert.equal(provider.capabilities.actions, false)
  assert.equal(provider.capabilities.sessionRename, false)
  assert.equal(provider.capabilities.sessionDelete, false)

  assert.deepEqual(contract.models.variantConfigIDs, [])
  assert.equal(contract.sessions.discovery, "native-list")
  assert.equal(contract.sessions.transcript, "session-load")
  assert.equal(contract.lifecycle.reconnect, "daemon-reconciliation")
})
