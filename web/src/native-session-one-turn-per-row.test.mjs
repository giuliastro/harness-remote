import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * One native user row is one turn, whichever paths claim it. The request this view sent, the tail-row
 * discovery and the queue hand-over each turn rows into turns; every past duplicate was two of them
 * claiming the same row. The adapter now enforces the rule in one place, so this holds even when a
 * path forgets to check the others.
 */

class MemoryStorage {
  #values = new Map()
  getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null }
  setItem(key, value) { this.#values.set(key, String(value)) }
  removeItem(key) { this.#values.delete(key) }
  clear() { this.#values.clear() }
}

const originalStorage = globalThis.localStorage
const originalWindow = globalThis.window
const originalFetch = globalThis.fetch
const storage = new MemoryStorage()
globalThis.window ??= globalThis
globalThis.localStorage = storage

const { api } = await import('./api.ts')
const originalLoadMessagePage = api.loadMessagePage
const originalListStatuses = api.listStatuses
const { registerNativeSessionV3Adapter } = await import('./native-session-v3-adapter.ts')

const CONFIG = { backend: 'claude', host: '127.0.0.1', port: 4097, username: 'harness', password: 'pw', agentId: 'claude' }
const MODEL = { providerID: 'claude', modelID: 'default' }
const DIRECTORY = '/repo'

function target(sessionID) {
  return {
    key: `machine:claude:${sessionID}`,
    ref: { machineID: 'machine', agentID: 'claude', sessionID, directory: DIRECTORY },
    machineID: 'machine',
    agentID: 'claude',
    agentLabel: 'Claude Code',
    backend: 'claude',
    transport: 'acp',
    sessionID,
    directory: DIRECTORY,
    title: 'One turn per row Session',
    external: false,
    modelsSupported: true,
    model: MODEL,
    requiresExplicitClaim: false,
    canStop: true,
    config: CONFIG
  }
}

function user(sessionID, id, text, queued = false) {
  return {
    info: { id, role: 'user', sessionID, time: { created: Date.now() }, ...(queued ? { queued: true } : {}) },
    parts: [{ id: `${id}:text`, messageID: id, type: 'text', text }]
  }
}

function assistant(sessionID, id, text) {
  return {
    info: { id, role: 'assistant', sessionID, time: { created: Date.now() } },
    parts: [{ id: `${id}:text`, messageID: id, type: 'text', text }]
  }
}

function respondWith(results) {
  globalThis.fetch = async () => {
    const body = results.shift()
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
}

function restore() {
  api.loadMessagePage = originalLoadMessagePage
  api.listStatuses = originalListStatuses
  globalThis.fetch = originalFetch
}

test('a dequeued prompt claimed by both the tail discovery and the queue hand-over is one turn', async () => {
  storage.clear()
  const sessionID = 'one-turn-1'
  let page = { messages: [], hasMore: false }
  api.loadMessagePage = async () => page
  api.listStatuses = async () => ({ [sessionID]: { type: 'busy' } })
  respondWith([
    { status: 'accepted', clientRequestId: 'request-1', result: { disposition: 'started', messageID: 'bridge-1' } },
    { status: 'accepted', clientRequestId: 'request-2', result: { disposition: 'queued', messageID: 'bridge-2' } },
    { status: 'accepted', clientRequestId: 'request-3', result: { disposition: 'queued', messageID: 'bridge-3' } }
  ])
  const registration = registerNativeSessionV3Adapter(target(sessionID), () => {})
  try {
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY)
    for (const prompt of ['first', 'second', 'third']) {
      await registration.controller.continueConversation(CONFIG, registration.conversation.id, { prompt, model: MODEL })
    }
    page = { messages: [
      user(sessionID, 'bridge-1', 'first'), assistant(sessionID, 'reply-1', 'counting'),
      user(sessionID, 'bridge-2', 'second', true), user(sessionID, 'bridge-3', 'third', true)
    ], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)
    page = { messages: [
      user(sessionID, 'bridge-1', 'first'), assistant(sessionID, 'reply-1', 'done'),
      user(sessionID, 'bridge-2', 'second'), assistant(sessionID, 'reply-2', 'SECOND-OK'),
      user(sessionID, 'bridge-3', 'third', true)
    ], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)
    let conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.deepEqual(conversation.turns.map((turn) => turn.prompt), ['first', 'second'])
    assert.ok(conversation.turns.every((turn) => turn.id.includes(':request:')), 'prompts sent from this view keep their request identity')

    page = { messages: [...page.messages.slice(0, -1), user(sessionID, 'bridge-3', 'third'), assistant(sessionID, 'reply-3', 'THIRD-OK')], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)
    conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.deepEqual(conversation.turns.map((turn) => turn.prompt), ['first', 'second', 'third'])
    assert.equal(conversation.currentTurn.prompt, 'third')
    assert.equal(new Set(conversation.turns.map((turn) => turn.id)).size, conversation.turns.length)
  } finally {
    registration.dispose()
    restore()
  }
})

test('repeated reads of the same transcript never add a turn', async () => {
  storage.clear()
  const sessionID = 'one-turn-2'
  const rows = [
    user(sessionID, 'n1', 'same text'), assistant(sessionID, 'r1', 'one'),
    user(sessionID, 'n2', 'same text'), assistant(sessionID, 'r2', 'two')
  ]
  let page = { messages: rows, hasMore: false }
  api.loadMessagePage = async () => page
  api.listStatuses = async () => ({ [sessionID]: { type: 'idle' } })
  const registration = registerNativeSessionV3Adapter(target(sessionID), () => {})
  try {
    for (let read = 0; read < 4; read += 1) {
      await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, read > 0)
    }
    const conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.deepEqual(conversation.turns.map((turn) => turn.prompt), ['same text', 'same text'], 'two identical prompts stay two turns, and no read adds a third')
  } finally {
    registration.dispose()
    restore()
  }
})
