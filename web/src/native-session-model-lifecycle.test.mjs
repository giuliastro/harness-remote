import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/*
 * Regression coverage for the Session-first model-change failure class reported in #287.
 *
 * The reported symptom was that changing model wedged a Session and then contaminated later ones.
 * The client half of that was a durable pending-delivery record: it exists so a retry after a lost
 * response converges on the same daemon ledger entry, but it was kept even when the daemon had
 * definitively refused the request, and it never expired. Because a model change makes the next
 * request differ from the stored one, one refused prompt made every later prompt for that Session
 * fail permanently - across reloads, because the record lives in localStorage.
 */

class MemoryStorage {
  #values = new Map()
  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null }
  setItem(key, value) { this.#values.set(key, String(value)) }
  removeItem(key) { this.#values.delete(key) }
  get size() { return this.#values.size }
  keys() { return [...this.#values.keys()] }
}

const storage = new MemoryStorage()
globalThis.localStorage = storage
globalThis.window ??= globalThis

const {
  sendNativeSessionPrompt,
  loadPendingNativeSessionPrompt,
  clearPendingNativeSessionPrompt
} = await import('./native-session-prompt.ts')
const { lastNativeMessageModel } = await import('./native-session-model.ts')

function target(overrides = {}) {
  return {
    key: 'machine:pi:s1',
    ref: { machineID: 'machine', agentID: 'pi', sessionID: 's1', directory: '/repo' },
    machineID: 'machine',
    agentID: 'pi',
    agentLabel: 'PI',
    backend: 'pi',
    transport: 'acp',
    sessionID: 's1',
    directory: '/repo',
    title: 'Session',
    external: false,
    modelsSupported: true,
    model: null,
    requiresExplicitClaim: false,
    canStop: true,
    config: { backend: 'pi', host: '127.0.0.1', port: 4099, username: 'harness', password: 'pw', agentId: 'pi' },
    ...overrides
  }
}

const MODEL_X = { providerID: 'openai', modelID: 'gpt-5.6' }
const MODEL_Y = { providerID: 'anthropic', modelID: 'claude-opus-4-8', variant: 'high' }

let responder = () => new Response('{}', { status: 200 })
const sent = []
globalThis.fetch = async (url, options) => {
  sent.push({ url: String(url), body: JSON.parse(options.body) })
  return responder()
}

// --- 1. A definite daemon refusal must not leave a record that blocks the next prompt ------------
responder = () => new Response(JSON.stringify({ error: 'Harness session not found', code: 'session_unavailable' }), { status: 409 })
await assert.rejects(sendNativeSessionPrompt(target(), 'first try', MODEL_X), /Harness session not found/)
assert.equal(
  loadPendingNativeSessionPrompt(target()),
  null,
  'a 409 from the daemon proves the prompt was refused without being dispatched, so nothing may stay pending'
)

// The user changes model and sends again. This is the exact reported reproduction.
responder = () => new Response(JSON.stringify({ status: 'accepted', clientRequestId: 'r1' }), { status: 200 })
const afterRefusal = await sendNativeSessionPrompt(target(), 'second try', MODEL_Y)
assert.equal(afterRefusal.status, 'accepted', 'a Session must remain usable after a refused prompt plus a model change')
assert.equal(loadPendingNativeSessionPrompt(target()), null)

// --- 2. A genuinely ambiguous delivery still protects against duplicating a turn -----------------
storage.removeItem
responder = () => { throw new TypeError('network down') }
await assert.rejects(sendNativeSessionPrompt(target(), 'ambiguous', MODEL_X), /Prompt delivery status is unknown/)
const ambiguous = loadPendingNativeSessionPrompt(target())
assert.ok(ambiguous, 'a transport failure leaves delivery genuinely unknown and must be remembered')

await assert.rejects(
  sendNativeSessionPrompt(target(), 'a different prompt', MODEL_Y),
  /unresolved delivery status/,
  'a different prompt must not be sent while an earlier delivery is genuinely ambiguous'
)

// Retrying the same prompt and model reuses the same durable request id.
responder = () => new Response(JSON.stringify({ status: 'accepted' }), { status: 200 })
const retried = await sendNativeSessionPrompt(target(), 'ambiguous', MODEL_X)
assert.equal(retried.clientRequestId, ambiguous.clientRequestId, 'a retry must converge on the same daemon ledger entry')
assert.equal(loadPendingNativeSessionPrompt(target()), null)

// --- 3. An ambiguous record must not block the Session forever -----------------------------------
responder = () => { throw new TypeError('network down') }
await assert.rejects(sendNativeSessionPrompt(target(), 'stale', MODEL_X), /unknown/)
const stale = loadPendingNativeSessionPrompt(target())
assert.ok(stale)
// Age the record past its retry window the way wall-clock time would.
const key = storage.keys().find((candidate) => candidate.includes('native-session-prompt'))
storage.setItem(key, JSON.stringify({ ...stale, createdAt: Date.now() - 11 * 60 * 1000 }))

responder = () => new Response(JSON.stringify({ status: 'accepted' }), { status: 200 })
const afterExpiry = await sendNativeSessionPrompt(target(), 'a completely new prompt', MODEL_Y)
assert.equal(afterExpiry.status, 'accepted', 'an expired ambiguous record must not brick the Session')
assert.notEqual(afterExpiry.clientRequestId, stale.clientRequestId, 'an expired record starts a new delivery identity')

// --- 4. Pending records are per native Session, never shared across harnesses --------------------
clearPendingNativeSessionPrompt(target())
responder = () => { throw new TypeError('network down') }
await assert.rejects(sendNativeSessionPrompt(target(), 'pi prompt', MODEL_X), /unknown/)
const otherHarness = target({ agentID: 'omp', backend: 'omp', key: 'machine:omp:s1', config: { backend: 'omp', host: '127.0.0.1', port: 4099, username: 'harness', password: 'pw', agentId: 'omp' } })
assert.equal(
  loadPendingNativeSessionPrompt(otherHarness),
  null,
  'one harness failing must not make another harness Session look blocked'
)
responder = () => new Response(JSON.stringify({ status: 'accepted' }), { status: 200 })
const otherOk = await sendNativeSessionPrompt(otherHarness, 'omp prompt', MODEL_Y)
assert.equal(otherOk.status, 'accepted', 'a wedged PI Session must not make an OMP Session unusable')

// --- 5. The wire model always carries the selection actually requested ---------------------------
const last = sent[sent.length - 1]
assert.deepEqual(last.body.model, { providerID: 'anthropic', modelID: 'claude-opus-4-8' })
assert.equal(last.body.variant, 'high', 'the variant travels beside the model, not inside it')

// --- 6. OpenCode current model is recovered from the newest native envelope ----------------------
const openCodeModel = lastNativeMessageModel([
  {
    info: {
      id: 'old-user',
      role: 'user',
      time: { created: 1 },
      model: { providerID: 'google', modelID: 'nano-banana' }
    },
    parts: [{ id: 'old-user:text', type: 'text', text: 'old prompt' }]
  },
  {
    info: {
      id: 'new-assistant',
      role: 'assistant',
      time: { created: 2 },
      model: { providerID: 'anthropic', id: 'claude-sonnet-4-6', variant: 'high' }
    },
    parts: [{ id: 'new-assistant:text', type: 'text', text: 'new answer' }]
  }
])
assert.deepEqual(
  openCodeModel,
  { providerID: 'anthropic', modelID: 'claude-sonnet-4-6', variant: 'high' },
  'a stale old user-model envelope must never beat the newer OpenCode assistant model'
)

// --- 7. OpenCode assistant envelopes may omit the variant ----------------------------------------
const flatAssistantModel = lastNativeMessageModel([
  {
    info: {
      id: 'variant-user',
      role: 'user',
      time: { created: 3 },
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6', variant: 'high' }
    },
    parts: [{ id: 'variant-user:text', type: 'text', text: 'use high reasoning' }]
  },
  {
    info: {
      id: 'variant-assistant',
      role: 'assistant',
      time: { created: 4, completed: 5 },
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-6'
    },
    parts: [{ id: 'variant-assistant:text', type: 'text', text: 'done' }]
  }
])
assert.deepEqual(
  flatAssistantModel,
  { providerID: 'anthropic', modelID: 'claude-sonnet-4-6', variant: 'high' },
  'a flat OpenCode assistant envelope must inherit the matching immediately preceding user variant'
)

// --- 8. OMP projection fixes must not change other harness continuation semantics -----------------
const adapter = readFileSync(new URL('./native-session-v3-adapter.ts', import.meta.url), 'utf8')
assert.match(adapter, /if \(entry\.target\.backend === "omp"\) \{[\s\S]*?const model = page\.model \?\? null/, 'OMP page.model must participate in its own projection reconciliation branch')
assert.match(adapter, /entry\.forcedStatus === "running" && entry\.currentModel && !sameModel\(entry\.currentModel, model\)/, 'a lagging OMP journal must not overwrite the selected model while the new turn is live')
assert.match(adapter, /if \(entry\.target\.backend !== "omp"\) \{[\s\S]*?await ensureWriter\(entry\)[\s\S]*?sendNativeSessionPrompt\(entry\.target, prompt, model\)[\s\S]*?appendAcceptedRun\(entry, prompt, model \?\? null/, 'non-OMP harnesses must retain the validated post-accept continuation path')
assert.match(adapter, /page = stabilizeOmpTailPage\(entry, page, before\)/, 'OMP live-to-journal identity repair must stay inside the OMP projection')
assert.match(adapter, /if \(entry\.target\.backend !== "omp" \|\| before\) return page/, 'OMP tail stabilization must not run for another harness')

const ompGateIndex = adapter.indexOf('if (entry.target.backend !== "omp")')
const preparedIndex = adapter.indexOf('const prepared = beginProjectionRun(entry, prompt, model ?? null)', ompGateIndex)
const writerIndex = adapter.indexOf('await ensureWriter(entry)', preparedIndex)
const sendIndex = adapter.indexOf('await sendNativeSessionPrompt(entry.target, prompt, model)', preparedIndex)
assert.ok(ompGateIndex >= 0 && preparedIndex > ompGateIndex && writerIndex > preparedIndex && sendIndex > writerIndex, 'only OMP creates the logical Run boundary before claim/prompt can emit session.updated')
assert.match(adapter, /const effectiveModel = model \?\? entry\.currentModel/, 'an OMP continuation with no explicit picker change must retain the recovered native model')
assert.match(adapter, /if \(run && !run\.model && entry\.currentModel\) run\.model = entry\.currentModel/, 'late OMP model enrichment must fill the current Run instead of leaving Harness default')

console.log('native-session model lifecycle regressions: OK')
