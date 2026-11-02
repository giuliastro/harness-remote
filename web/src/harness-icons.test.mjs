import assert from "node:assert/strict"
import { harnessIconUrl, providerIconUrl } from "./harness-icons.ts"

globalThis.document = { documentElement: { dataset: { skin: "classic" } } }

assert.equal(harnessIconUrl("deepseek"), "/harness-icons/brand/deepseek.svg")
assert.equal(providerIconUrl("deepseek-official"), undefined)

document.documentElement.dataset.skin = "compact"
assert.equal(harnessIconUrl("deepseek"), "/harness-icons/brand/deepseek.svg")
assert.equal(providerIconUrl("deepseek-official"), "/harness-icons/brand/deepseek.svg")

console.log("Harness icon skin mappings passed")
