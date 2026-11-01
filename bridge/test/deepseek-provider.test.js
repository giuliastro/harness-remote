import assert from "node:assert/strict"
import test from "node:test"
import { acpHarnessCapabilityContract } from "../src/harness-capability-contract.js"
import { harnessProfile, resolveAcpLaunch } from "../src/harness-profiles.js"

test("DeepSeek Harness uses the pinned ACP adapter and the native ACP surface", () => {
  const provider = harnessProfile("deepseek")
  const contract = acpHarnessCapabilityContract(provider)

  assert.equal(provider.label, "DeepSeek Harness")
  assert.equal(provider.command, process.platform === "win32" ? "npx.cmd" : "npx")
  assert.deepEqual(provider.args, ["--yes", "--package=@openma/deepseek-harness-acp@0.4.40", "dsh-acp"])
  assert.equal(provider.adapterCommand, "dsh-acp")
  assert.equal(provider.allowPackageFallback, true)
  assert.deepEqual(provider.detectCommands, ["dsh", "dsh-acp"])
  assert.equal(provider.launchPriority, 80)
  assert.equal(provider.environment.NO_BROWSER, "1")
  assert.equal(provider.permissionMode, "allow")

  assert.equal(provider.replayAuthoritative, true)
  assert.equal(provider.replayUserChunksAreMessages, true)
  assert.equal(provider.preserveListedTimestamps, true)
  assert.deepEqual(contract.models.variantConfigIDs, ["effort"])
  assert.deepEqual(provider.modelProviderLabels, { "deepseek-official": "DeepSeek" })
  assert.equal(contract.sessions.discovery, "native-list")
  assert.equal(contract.sessions.transcript, "native-journal")
  assert.equal(contract.sessions.externalWriterObservation, "supported-via-journal")
  assert.equal(typeof provider.historyLoader, "function")
  assert.equal(typeof provider.historyLoader.page, "function")
  assert.equal(provider.journalPageWhileOwned, false)
  assert.equal(provider.reloadOnHistoryRefresh, false)

  assert.equal(provider.capabilities.models, true)
  assert.equal(provider.capabilities.todos, true)
  assert.equal(provider.capabilities.commands, true)
  assert.equal(provider.capabilities.permissions, true)
  assert.equal(provider.capabilities.questions, false)
  assert.equal(provider.capabilities.actions, false)
  assert.equal(provider.capabilities.midTurnPrompt, "steer")
  assert.equal(provider.capabilities.sessionRename, true)
  assert.equal(provider.capabilities.sessionDelete, true)
})

test("an installed dsh-acp is preferred over the npx package fallback", () => {
  const found = new Set(["/tools/dsh-acp"])
  assert.deepEqual(
    resolveAcpLaunch(harnessProfile("deepseek"), { find: (name) => found.has(`/tools/${name}`) ? `/tools/${name}` : undefined }),
    { command: "/tools/dsh-acp", args: [], source: "path" }
  )
  assert.deepEqual(
    resolveAcpLaunch(harnessProfile("deepseek"), { find: () => undefined }),
    {
      command: process.platform === "win32" ? "npx.cmd" : "npx",
      args: ["--yes", "--package=@openma/deepseek-harness-acp@0.4.40", "dsh-acp"],
      source: "npx"
    }
  )
})
