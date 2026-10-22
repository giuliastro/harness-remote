import assert from 'node:assert/strict'
import { filterModelGroups, groupModels, modelOptionKey } from './components/model-picker.tsx'

// The catalog owns variant ordering. These labels are intentionally non-alphabetical and are
// treated as opaque values: the UI must preserve the order supplied by the harness rather than
// infer reasoning semantics from their names.
const catalogVariantOrder = ['medium', 'low', 'xhigh', 'high']
const catalog = [
  {
    providerID: 'openai',
    providerName: 'OpenAI',
    modelID: 'gpt-5.6',
    modelName: 'GPT-5.6',
    isDefault: true,
    isFree: true
  },
  ...catalogVariantOrder.map((variant) => ({
    providerID: 'openai',
    providerName: 'OpenAI',
    modelID: 'gpt-5.6',
    modelName: 'GPT-5.6',
    variant,
    isFree: true
  })),
  {
    providerID: 'anthropic',
    providerName: 'Anthropic',
    modelID: 'claude-sonnet',
    modelName: 'Claude Sonnet',
    description: 'Strong code review model',
    isFree: false
  },
  {
    providerID: 'anthropic',
    providerName: 'Anthropic',
    modelID: 'claude-sonnet',
    modelName: 'Claude Sonnet',
    variant: 'thinking',
    isFree: false
  }
]

const groups = groupModels(catalog)
assert.deepEqual(
  groups.map((group) => group.providerID),
  ['openai', 'anthropic'],
  'without advertised priorities, default-first and alphabetical ordering must stay unchanged'
)
const openAI = groups.find((group) => group.providerID === 'openai' && group.modelID === 'gpt-5.6')
const anthropic = groups.find((group) => group.providerID === 'anthropic' && group.modelID === 'claude-sonnet')

assert.ok(openAI, 'the base model and its variants must remain one model group')
assert.ok(anthropic, 'a second model family must remain separate')
assert.equal(modelOptionKey(openAI.base), 'openai|gpt-5.6|')
assert.deepEqual(
  openAI.variants.map((variant) => variant.variant),
  catalogVariantOrder,
  'reasoning/variant order must be exactly the order advertised by the harness catalog'
)
assert.deepEqual(anthropic.variants.map((variant) => variant.variant), ['thinking'])

const prioritizedGroups = groupModels([
  {
    providerID: 'openai',
    providerName: 'OpenAI',
    modelID: 'gpt-5.6',
    modelName: 'GPT-5.6',
    isDefault: true,
    sortPriority: 1
  },
  {
    providerID: 'xiaomi',
    providerName: 'Xiaomi',
    modelID: 'mimo-v2.6-flash',
    modelName: 'MiMo V2.6 Flash',
    sortPriority: 0
  },
  {
    providerID: 'xiaomi',
    providerName: 'Xiaomi',
    modelID: 'mimo-v2.6-flash',
    modelName: 'MiMo V2.6 Flash',
    variant: 'high',
    variantValue: 'xiaomi/mimo-v2.6-flash/high',
    sortPriority: 0
  }
])
assert.deepEqual(
  prioritizedGroups.map((group) => group.providerID),
  ['xiaomi', 'openai'],
  'catalog priority must sort Xiaomi first even when OpenAI is the default'
)
assert.equal(prioritizedGroups[0].variants[0].variantValue, 'xiaomi/mimo-v2.6-flash/high')

assert.deepEqual(
  filterModelGroups(groups, 'anthropic').map((group) => group.modelID),
  ['claude-sonnet'],
  'model search must match provider identity'
)
assert.deepEqual(
  filterModelGroups(groups, 'code review').map((group) => group.modelID),
  ['claude-sonnet'],
  'model search must match catalog descriptions'
)
assert.deepEqual(
  filterModelGroups(groups, 'thinking').map((group) => group.modelID),
  ['claude-sonnet'],
  'model search must match harness-provided variant labels'
)
assert.deepEqual(
  filterModelGroups(groups, 'GPT-5.6').map((group) => group.modelID),
  ['gpt-5.6'],
  'model search must be case-insensitive across model ids/names'
)
assert.deepEqual(
  filterModelGroups(groups, '', true).map((group) => group.modelID),
  ['gpt-5.6'],
  'free-only filtering must use catalog-confirmed free metadata'
)

console.log('model picker grouping, ordering and filtering behavioral tests passed')
