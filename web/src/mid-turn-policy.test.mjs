import assert from 'node:assert/strict'
import { midTurnPromptPolicy, messageRowText } from './mid-turn-policy.ts'

assert.equal(midTurnPromptPolicy(null), 'queue')
assert.equal(midTurnPromptPolicy(undefined), 'queue')
assert.equal(midTurnPromptPolicy({}), 'queue', 'legacy OpenCode agents publish no capabilities and stay on queue')
assert.equal(midTurnPromptPolicy({ capabilities: { midTurnPrompt: 'queue' } }), 'queue')
assert.equal(midTurnPromptPolicy({ capabilities: { midTurnPrompt: 'steer' } }), 'steer', 'codex-style capability steers')
assert.equal(midTurnPromptPolicy({ capabilities: { midTurnPrompt: 'bogus' } }), 'queue', 'an unknown declaration falls back to queue')

assert.equal(messageRowText({ parts: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a b')
assert.equal(messageRowText({ parts: [{ type: 'image', url: 'x' }] }), '')

console.log('mid-turn policy tests passed')
