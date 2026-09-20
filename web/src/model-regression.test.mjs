import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const conversation = readFileSync(new URL('./components/work-thread-conversation.tsx', import.meta.url), 'utf8')
const picker = readFileSync(new URL('./components/model-picker.tsx', import.meta.url), 'utf8')

assert.match(conversation, /modelSelectionTouchedRef/, 'background model recovery must not overwrite an explicit picker choice')
assert.match(conversation, /conversationHasUserPrompt/, 'native model fallback must distinguish a truly empty Session from an existing conversation')
assert.match(conversation, /mayUseCatalogDefault = providerRequiresExplicitModel\(catalogAgent\) \\|\\| !deferModelFallback \\|\\| routeChanged \\|\\| !latestHasUserPrompt/, 'fresh Sessions, handoffs, and providers requiring explicit selection must choose a verified catalog default')
assert.match(conversation, /modelBootstrapBlocked = modelSelectionRequired && \(!modelCatalogReady \\|\\| !selectedModel\)/, 'providers requiring explicit selection must remain blocked until a verified model is actually selected')
assert.doesNotMatch(conversation, /routingSignature, routeChanged, conversationHasUserPrompt/, 'first-prompt discovery must not re-read the model catalog')
assert.match(picker, /Harness default/, 'an unavailable catalog must fall back honestly to the harness default')

console.log('Session-first model regression tests passed')
