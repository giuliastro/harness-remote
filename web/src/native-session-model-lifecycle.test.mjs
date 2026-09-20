import assert from 'node:assert/strict'

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
  sendNativeSessionCommand,
  loadPendingNativeSessionPrompt,
  clearPendingNativeSessionPrompt,
  markPendingNativeSessionPromptAccepted
} = await import('./native-session-prompt.ts')
const { stopNativeSession } = await import('./native-session-stop.ts')
const { lastNativeMessageModel } = await import('./native-session-model.ts')
const { modelCatalogConfig, taskClient } = await import('./taskClient.ts')

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
  sent.push({
    url: String(url),
    headers: options?.headers,
    body: options?.body ? JSON.parse(String(options.body)) : undefined
  })
  return responder(String(url), options)
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

// --- 6. Transcript-proven acceptance clears ambiguous delivery without resending handoff context --
const handoffTarget = target({
  key: 'machine:pi:handoff-target',
  sessionID: 'handoff-target',
  ref: { machineID: 'machine', agentID: 'pi', sessionID: 'handoff-target', directory: '/repo' },
  history: [{
    ref: { machineID: 'machine', agentID: 'omp', sessionID: 'source', directory: '/repo' },
    title: 'Source',
    agentID: 'omp',
    agentLabel: 'OMP',
    backend: 'omp',
    messages: [{
      info: { id: 'source-user', role: 'user', time: { created: 1 } },
      parts: [{ id: 'source-user:text', type: 'text', text: 'previous context' }]
    }]
  }]
})
responder = () => { throw new TypeError('network down') }
await assert.rejects(sendNativeSessionPrompt(handoffTarget, 'take over', MODEL_X), /unknown/)
const handoffPending = loadPendingNativeSessionPrompt(handoffTarget)
assert.ok(handoffPending?.wireText?.includes('TRANSFERRED TASK CONTEXT'), 'the ambiguous first handoff carries its bounded transfer envelope')
markPendingNativeSessionPromptAccepted(handoffTarget)
assert.equal(loadPendingNativeSessionPrompt(handoffTarget), null, 'authoritative transcript proof must retire the ambiguous request id')

responder = () => new Response(JSON.stringify({ status: 'accepted' }), { status: 200 })
await sendNativeSessionPrompt(handoffTarget, 'next ordinary turn', MODEL_X)
const nextWire = sent[sent.length - 1].body.text
assert.equal(nextWire, 'next ordinary turn', 'transcript-proven handoff acceptance must prevent transferred context from being sent twice')

// --- 7. OpenCode current model is recovered from the newest native envelope ----------------------
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

// --- 8. OpenCode assistant envelopes may omit the variant ----------------------------------------
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

// --- 9. Picker membership stays on the selected harness's current catalog ------------------------
sent.length = 0
responder = (url) => {
  assert.doesNotMatch(url, /config\/providers/, 'picker membership must never load historical Session options')
  return new Response(JSON.stringify({
    models: [{
      providerID: 'codex',
      providerName: 'Codex CLI',
      modelID: 'gpt-5.6-sol',
      modelName: 'GPT-5.6-Sol'
    }],
    stale: false,
    refreshedAt: '2026-09-08T00:00:00.000Z'
  }), { status: 200 })
}

// Start from a deliberately mismatched primary profile. The shared catalog boundary must replace
// both routing fields even though the browser's machine-scoped URL needs only the explicit path;
// desktop transport also carries this coherent pair as routing metadata.
const claudePrimaryConfig = {
  backend: 'claude', host: '127.0.0.1', port: 4099, username: 'harness', password: 'pw', agentId: 'claude'
}
assert.deepEqual(modelCatalogConfig(claudePrimaryConfig, 'codex'), { ...claudePrimaryConfig, backend: 'codex', agentId: 'codex' })
assert.deepEqual(
  modelCatalogConfig(claudePrimaryConfig, 'opencode2'),
  { ...claudePrimaryConfig, backend: 'opencode2', agentId: 'opencode2' },
  'provider-kit harness ids must route model requests without a frontend allowlist'
)
const currentCatalog = await taskClient.listAgentModels(claudePrimaryConfig, 'codex')
assert.equal(currentCatalog.models[0]?.modelID, 'gpt-5.6-sol')
assert.equal(sent.length, 1, 'native Session model discovery must be one current-catalog request')
const currentCatalogRequest = new URL(sent[0].url)
assert.equal(currentCatalogRequest.pathname, '/v1/agents/codex/models')
assert.equal(currentCatalogRequest.searchParams.get('sessionID'), null)

// --- 10. Prompt and slash-command mutations use the exact native Session transport ----------------
sent.length = 0
responder = () => new Response(JSON.stringify({ status: 'accepted' }), { status: 200 })
const transportTarget = target({
  key: 'machine:pi:s1/transport',
  sessionID: 's1/transport',
  ref: { machineID: 'machine', agentID: 'pi', sessionID: 's1/transport', directory: '/repo' }
})
const transportPrompt = await sendNativeSessionPrompt(transportTarget, 'transport prompt', MODEL_X)
assert.equal(sent.length, 1)
const promptTransportRequest = new URL(sent[0].url)
assert.equal(promptTransportRequest.pathname, '/v1/agents/pi/session/s1%2Ftransport/prompt')
assert.equal(sent[0].body.clientRequestId, transportPrompt.clientRequestId, 'prompt wire identity must match the accepted mutation identity')
assert.equal(sent[0].body.directory, '/repo')
assert.deepEqual(sent[0].body.model, { providerID: 'openai', modelID: 'gpt-5.6' })

const transportCommand = await sendNativeSessionCommand(transportTarget, '/compact', 'now', MODEL_Y)
assert.equal(sent.length, 2)
const commandTransportRequest = new URL(sent[1].url)
assert.equal(commandTransportRequest.pathname, '/v1/agents/pi/session/s1%2Ftransport/command')
assert.equal(sent[1].body.clientRequestId, transportCommand.clientRequestId, 'command wire identity must match the accepted mutation identity')
assert.equal(sent[1].body.command, 'compact')
assert.equal(sent[1].body.arguments, 'now')
assert.deepEqual(sent[1].body.model, { providerID: 'anthropic', modelID: 'claude-opus-4-8' })
assert.equal(sent[1].body.variant, 'high')

// --- 11. Stop retries keep per-turn mutation identity without swallowing a later turn ------------
sent.length = 0
responder = () => { throw new TypeError('network down') }
await assert.rejects(stopNativeSession(transportTarget, 'turn-1'), /Stop delivery status is unknown/)
assert.equal(sent.length, 1)
const ambiguousStopID = sent[0].body.clientRequestId
assert.ok(ambiguousStopID)
assert.equal(sent[0].body.operationToken, 'turn-1')
assert.equal(sent[0].body.directory, '/repo')
const stopTransportRequest = new URL(sent[0].url)
assert.equal(stopTransportRequest.pathname, '/v1/agents/pi/session/s1%2Ftransport/stop')

responder = () => new Response(JSON.stringify({ status: 'accepted' }), { status: 200 })
const retriedStop = await stopNativeSession(transportTarget, 'turn-1')
assert.equal(sent.length, 2)
assert.equal(sent[1].body.clientRequestId, ambiguousStopID, 'retrying the same turn must reuse the durable Stop request id')
assert.equal(retriedStop.clientRequestId, ambiguousStopID)

const nextTurnStop = await stopNativeSession(transportTarget, 'turn-2')
assert.equal(sent.length, 3)
assert.equal(sent[2].body.operationToken, 'turn-2')
assert.equal(sent[2].body.clientRequestId, nextTurnStop.clientRequestId)
assert.notEqual(nextTurnStop.clientRequestId, ambiguousStopID, 'a later user turn must receive a fresh Stop mutation identity')

console.log('native-session model lifecycle regressions: OK')
