import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { acpHarnessCapabilityContract } from "../src/harness-capability-contract.js"
import { harnessProfile, resolveAcpLaunch } from "../src/harness-profiles.js"
import { detectBackends } from "../src/launcher.js"

test("Antigravity provider uses the documented native ACP command and discovery", () => {
  const provider = harnessProfile("antigravity")

  assert.equal(provider.label, "Google Antigravity")
  assert.equal(provider.command, "agy")
  assert.deepEqual(provider.args, ["acp"])
  assert.deepEqual(provider.detectCommands, ["agy"])
  assert.equal(provider.launchPriority, 90)
  assert.equal(provider.authenticate, false)
  assert.equal(provider.permissionMode, "prompt")
  assert.deepEqual(resolveAcpLaunch(provider, { find: () => null }), { command: "agy", args: ["acp"], source: "harness" })

  const detected = detectBackends({
    pathValue: path.join(path.parse(process.cwd()).root, "tools"),
    platform: process.platform,
    exists: (candidate) => path.basename(candidate).toLowerCase() === (process.platform === "win32" ? "agy.exe" : "agy"),
    access: () => {}
  })
  assert.deepEqual(detected, ["antigravity"])
})

test("Antigravity declares only verified ACP features and conservative session semantics", () => {
  const provider = harnessProfile("antigravity")
  const contract = acpHarnessCapabilityContract(provider)

  assert.equal(provider.capabilities.sessions, true)
  assert.equal(provider.capabilities.prompt, true)
  assert.equal(provider.capabilities.abort, true)
  assert.equal(provider.capabilities.streaming, true)
  assert.equal(provider.capabilities.models, true)
  assert.equal(provider.capabilities.commands, true)
  assert.equal(provider.capabilities.permissions, true)
  assert.equal(provider.capabilities.questions, false)
  assert.equal(provider.capabilities.todos, false)
  assert.equal(provider.capabilities.actions, false)
  assert.equal(provider.capabilities.midTurnPrompt, "steer")
  assert.equal(provider.capabilities.sessionRename, false)
  assert.equal(provider.capabilities.sessionDelete, true)

  assert.equal(contract.protocol, "acp")
  assert.equal(contract.sessions.discovery, "native-list")
  assert.equal(contract.sessions.transcript, "session-load")
  assert.equal(contract.sessions.externalWriterObservation, "unverified-session-load")
  assert.equal(contract.sessions.continuation, "session-load")
  assert.equal(contract.sessions.writerOwnership, "adapter-defined")
  assert.equal(contract.sessions.stop, "owned-session-native-cancel")
  assert.deepEqual(contract.models.variantConfigIDs, ["thought_level"])
})
