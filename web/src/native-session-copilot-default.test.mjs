import assert from "node:assert/strict"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ConversationStatePill } from "./components/work-thread-conversation.tsx"
import { provenCopilotAutoDefault, shouldClearDeferredCatalogDefault } from "./native-session-model.ts"

const auto = {
  providerID: "copilot",
  providerName: "GitHub Copilot",
  modelID: "auto",
  modelName: "Auto",
  isDefault: true
}

assert.equal(provenCopilotAutoDefault("copilot", [auto]), auto, "the sole Copilot Auto default is a proven native-session fallback")
assert.equal(provenCopilotAutoDefault("codex", [auto]), null, "a catalog cannot project Copilot Auto onto another harness")
assert.equal(provenCopilotAutoDefault("copilot", [{ ...auto, providerID: "codex" }]), null, "other providers keep metadata-first fallback")
assert.equal(provenCopilotAutoDefault("copilot", [auto, { ...auto, modelID: "gpt-6-luna" }]), null, "multiple catalog rows are ambiguous")
assert.equal(provenCopilotAutoDefault("copilot", [{ ...auto, modelID: "specific-model" }]), null, "a specific Copilot model is not inferred as Auto")
assert.equal(provenCopilotAutoDefault("copilot", [{ ...auto, isDefault: false }]), null, "a non-default Copilot Auto row is not proven to be the harness default")

const existingSession = {
  deferModelFallback: true,
  routeChanged: false,
  hasUserPrompt: true,
  currentModelKey: null,
  selectionTouched: false,
  selectedModelKey: "copilot|auto|",
  models: [auto],
  backend: "copilot"
}
assert.equal(shouldClearDeferredCatalogDefault(existingSession), false, "transcript discovery must retain the safe Copilot Auto fallback")
assert.equal(shouldClearDeferredCatalogDefault({ ...existingSession, selectionTouched: true }), false, "an explicit user selection must never be cleared")
assert.equal(shouldClearDeferredCatalogDefault({ ...existingSession, selectedModelKey: "" }), true, "a missing provisional selection remains clearable")
assert.equal(shouldClearDeferredCatalogDefault({ ...existingSession, models: [{ ...auto, providerID: "codex" }] }), true, "generic deferred defaults remain clearable")

const status = renderToStaticMarkup(React.createElement(ConversationStatePill, {
  working: true,
  attention: false,
  workingLabel: "Model catalog unavailable",
  status: "running",
  startedAt: undefined
}))
assert.match(status, /Model catalog unavailable/, "catalog errors should be visible in the conversation state")
assert.doesNotMatch(status, /\d+s/, "a blocked model bootstrap must not display elapsed time from an old turn")

const running = renderToStaticMarkup(React.createElement(ConversationStatePill, {
  working: true,
  attention: false,
  workingLabel: "Codex is working",
  status: "running",
  startedAt: new Date(Date.now() - 5_000).toISOString()
}))
assert.match(running, /Codex is working · \d+s/, "real active turns retain their elapsed timer")

console.log("Copilot native-session model fallback and bootstrap status passed")
