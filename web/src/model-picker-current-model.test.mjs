import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ModelPicker, modelOptionKey } from './components/model-picker.tsx'
import { modelForCurrentDestination } from './components/work-thread-conversation.tsx'

const current = { providerID: 'openai', modelID: 'gpt-6.1-sol', variant: 'xhigh' }
const render = (props) => renderToStaticMarkup(React.createElement(ModelPicker, {
  models: [], value: '', onChange: () => {}, ...props
}))

const emptyCatalog = render({ currentModel: current })
assert.match(emptyCatalog, /gpt-6\.1-sol/, 'empty catalog should still show the recovered native model')
assert.match(emptyCatalog, /<strong>gpt-6\.1-sol · xhigh<\/strong>/, 'the native variant stays visible even where mobile styles hide the detail line')
assert.match(emptyCatalog, /openai · xhigh/, 'the native model label should include provider and variant')
assert.match(emptyCatalog, /unavailable in catalog/, 'the empty-catalog label should explain that the current model is not selectable')
assert.match(emptyCatalog, /disabled/, 'a native-only model must not become a selectable control')

const missingCatalogModel = render({
  models: [{ providerID: 'anthropic', providerName: 'Anthropic', modelID: 'sonnet', modelName: 'Sonnet' }],
  value: modelOptionKey(current),
  currentModel: current
})
assert.match(missingCatalogModel, /gpt-6\.1-sol/, 'a known native model missing from a nonempty catalog should remain visible')
assert.doesNotMatch(missingCatalogModel, /<option|role="option"/, 'the missing model must not be added as a selectable catalog entry')

const noSelection = render({})
assert.match(noSelection, /Harness default/, 'without a verified selection or known native model, show the harness default')

const knownCatalog = render({
  models: [{ providerID: 'openai', providerName: 'OpenAI', modelID: 'gpt-6.1-sol', modelName: 'GPT-6.1 Sol', variant: 'xhigh' }],
  value: modelOptionKey(current),
  currentModel: current
})
assert.match(knownCatalog, /GPT-6\.1 Sol/, 'a catalog model should keep its catalog display name')
assert.match(knownCatalog, /OpenAI · xhigh/, 'a catalog model should keep its selected variant')

const sameCurrentDestination = { agentID: 'codex', backend: 'codex' }
assert.deepEqual(
  modelForCurrentDestination(current, sameCurrentDestination, sameCurrentDestination, true),
  current,
  'the native model may be shown for the same current destination'
)
assert.equal(
  modelForCurrentDestination(current, sameCurrentDestination, { agentID: 'claude', backend: 'claude' }, true),
  null,
  'the native model must not carry across a harness switch'
)
assert.equal(
  modelForCurrentDestination(current, sameCurrentDestination, sameCurrentDestination, false),
  null,
  'the native model must not carry to another machine'
)

console.log('current native model picker behavior passed')
