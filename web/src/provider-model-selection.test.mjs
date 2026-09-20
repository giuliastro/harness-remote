import assert from "node:assert/strict"
import test from "node:test"
import { providerModelSelectionMode, providerRequiresExplicitModel, providerUsesModelCatalog } from "./provider-model-selection.ts"

function agent(id, models, selection) {
  return {
    id, label: id, backend: id, transport: "acp", managed: true, state: "available",
    capabilities: { sessions: true, prompt: true, models },
    ...(selection ? { contract: {
      version: 2, protocol: "acp",
      transport: { control: "stdio-json-rpc", events: "acp-session-update" },
      toolCalls: { representation: "acp-session-update" },
      models: { source: "acp-config-options", cacheScope: "machine", variants: "runtime-advertised-only", variantConfigIDs: [], selection },
      lifecycle: { sessionAuthority: "native-harness", create: "native-session", resume: "native-session", stop: "native-abort", reconnect: "daemon-reconciliation" }
    }} : {})
  }
}
test("Copilot uses its runtime catalog without forcing a replacement model on existing Sessions", () => {
  const provider = agent("copilot", true, "optional")
  assert.equal(providerModelSelectionMode(provider), "optional")
  assert.equal(providerUsesModelCatalog(provider), true)
  assert.equal(providerRequiresExplicitModel(provider), false)
})
test("MiMo remains writable without model discovery", () => {
  const provider = agent("mimo", false, "harness-default")
  assert.equal(providerModelSelectionMode(provider), "harness-default")
  assert.equal(providerUsesModelCatalog(provider), false)
  assert.equal(providerRequiresExplicitModel(provider), false)
})
test("OpenCode 2 requires its verified provider catalog", () => {
  const provider = agent("opencode2", true, "required")
  assert.equal(providerUsesModelCatalog(provider), true)
  assert.equal(providerRequiresExplicitModel(provider), true)
})
test("optional model selection may fall back to the harness default", () => {
  const provider = agent("future-provider", true, "optional")
  assert.equal(providerUsesModelCatalog(provider), true)
  assert.equal(providerRequiresExplicitModel(provider), false)
})
test("older machine snapshots keep their historical model semantics", () => {
  assert.equal(providerModelSelectionMode(agent("legacy-model-provider", true)), "required")
  assert.equal(providerModelSelectionMode(agent("legacy-default-provider", false)), "harness-default")
})
