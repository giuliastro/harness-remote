import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
const nativeModel = readFileSync(new URL('./native-session-model.ts', import.meta.url), 'utf8')
const adapter = readFileSync(new URL('./native-session-v3-adapter.ts', import.meta.url), 'utf8')
const conversation = readFileSync(new URL('./components/work-thread-conversation.tsx', import.meta.url), 'utf8')
const picker = readFileSync(new URL('./components/model-picker.tsx', import.meta.url), 'utf8')
const create = readFileSync(new URL('./native-session-create.ts', import.meta.url), 'utf8')

assert.ok(api.includes('listModels(config: ServerConfig'), 'API must expose the model catalog')
assert.ok(api.includes('withDirectory("/config/providers"'), 'OpenCode models stay directory scoped')
assert.match(nativeModel, /lastNativeMessageModel/, 'native Session model recovery must read transcript metadata')
assert.match(nativeModel, /PAGE_MODEL_BACKENDS = new Set\(\["omp", "pi", "codex"\]\)/, 'journal-backed model recovery must remain explicit')
assert.match(nativeModel, /target\.backend === "claude"/, 'Claude model recovery must use its live adapter catalog')
assert.match(adapter, /reconcileNativeSessionModel/, 'the native runtime must absorb authoritative model metadata')
assert.match(adapter, /for \(const turn of entry\.turns\.values\(\)\)/, 'recovered models must fill turns that never recorded one')
assert.match(conversation, /taskClient\.listAgentModels/, 'the active Session controller must use the daemon model catalog')
assert.match(conversation, /modelSelectionTouchedRef/, 'background model recovery must not overwrite an explicit picker choice')
assert.match(conversation, /<ModelPicker/, 'the Session controller must render the shared model picker')
assert.match(picker, /Search model, provider, variant/, 'model catalog must remain searchable')
assert.match(picker, /Harness default/, 'an unavailable catalog must fall back honestly to the harness default')
assert.match(picker, /groupModels/, 'variants must stay grouped with their base model')
assert.match(create, /api\.createSession\(config, title\?\.trim\(\) \|\| undefined, undefined, directory\)/, 'new native Sessions must not invent a stale explicit model')

console.log('Session-first model regression tests passed')
