import assert from "node:assert/strict"
import test from "node:test"
import { catalogFingerprint, catalogOwnershipEvidence } from "../scripts/session-first-soak-evidence.mjs"

const sharedModels = [
  { providerID: "shared", modelID: "model-a" },
  { providerID: "shared", modelID: "model-b", variantConfigId: "thinking", variant: "high" }
]

test("catalog fingerprint is order independent and includes variant identity", () => {
  assert.equal(catalogFingerprint(sharedModels), catalogFingerprint([...sharedModels].reverse()))
  assert.notEqual(
    catalogFingerprint(sharedModels),
    catalogFingerprint([{ providerID: "shared", modelID: "model-a" }, { providerID: "shared", modelID: "model-b", variantConfigId: "thinking", variant: "low" }])
  )
})

test("identical provider inventories are valid when diagnostics own separate agent catalogs", () => {
  const evidence = catalogOwnershipEvidence({
    primary: "codex",
    secondary: "claude",
    primaryModels: sharedModels,
    secondaryModels: [...sharedModels],
    state: {
      agents: {
        codex: { catalogModels: 2, catalogSource: "acp-config-options" },
        claude: { catalogModels: 2, catalogSource: "acp-config-options" }
      }
    }
  })

  assert.equal(evidence.catalogsIdentical, true)
  assert.equal(evidence.checks.every((entry) => entry.ok), true)
})

test("missing agent-scoped catalog diagnostics remain a real failure", () => {
  const evidence = catalogOwnershipEvidence({
    primary: "codex",
    secondary: "claude",
    primaryModels: sharedModels,
    secondaryModels: sharedModels,
    state: {
      agents: {
        codex: { catalogModels: 2, catalogSource: "acp-config-options" }
      }
    }
  })

  const failed = evidence.checks.filter((entry) => !entry.ok).map((entry) => entry.message)
  assert.ok(failed.some((message) => message.includes("claude: diagnostics expose")))
  assert.ok(failed.some((message) => message.includes("claude: diagnostics own")))
  assert.ok(failed.some((message) => message.includes("claude: diagnostics identify")))
})
