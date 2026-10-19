import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * A prompt the daemon queues behind the running turn is not a turn of the conversation. The
 * conversation keeps tracking the running turn - so its reply, "getting started" and "working"
 * states stay where they belong - and the queued prompt becomes the newest turn only once the
 * transcript shows the daemon started it. The daemon's `info.queued` flag is the authority, so the
 * hand-over survives a remount and adopts rows another client queued.
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
    title: 'Queued prompt Session',
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

test('a queued prompt stays out of the turns until the transcript shows it started, across a remount', async () => {
  storage.clear()
  const sessionID = 'queued-session-1'
  let page = { messages: [], hasMore: false }
  api.loadMessagePage = async () => page
  api.listStatuses = async () => ({ [sessionID]: { type: 'busy' } })
  respondWith([
    { status: 'accepted', clientRequestId: 'request-a', result: { disposition: 'started', messageID: 'bridge-a' } },
    { status: 'accepted', clientRequestId: 'request-b', result: { disposition: 'queued', messageID: 'bridge-b' } }
  ])

  let registration = registerNativeSessionV3Adapter(target(sessionID), () => {})
  try {
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY)
    const started = await registration.controller.continueConversation(CONFIG, registration.conversation.id, { prompt: 'first', model: MODEL })
    assert.equal(started.currentTurn.prompt, 'first')

    const queued = await registration.controller.continueConversation(CONFIG, registration.conversation.id, { prompt: 'second', model: MODEL })
    assert.equal(queued.turns.length, 1, 'a queued prompt is not a turn')
    assert.equal(queued.currentTurn.prompt, 'first', 'the running turn stays current while the prompt waits')

    page = { messages: [user(sessionID, 'bridge-a', 'first'), assistant(sessionID, 'reply-a', 'working on it'), user(sessionID, 'bridge-b', 'second', true)], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)

    // Switching Session and back remounts the view; the conversation must still not treat the
    // queued prompt as its current turn.
    registration.dispose()
    // A remount starts from a fresh controller that rebuilds the turns from its first page, as the
    // view does; the daemon's queued flag is what keeps the waiting prompt out of them.
    registration = registerNativeSessionV3Adapter(target(sessionID), () => {})
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY)
    const remounted = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.deepEqual(remounted.turns.map((turn) => turn.prompt), ['first'])
    assert.equal(remounted.currentTurn.prompt, 'first')

    page = { messages: [
      user(sessionID, 'bridge-a', 'first'),
      assistant(sessionID, 'reply-a', 'done'),
      user(sessionID, 'bridge-b', 'second'),
      assistant(sessionID, 'reply-b', 'starting the second')
    ], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)
    const after = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.equal(after.turns.length, 2, 'the dequeued prompt became a turn')
    assert.equal(after.currentTurn.prompt, 'second', 'and it is now the current turn')
    assert.equal(after.currentTurn.id.endsWith(':native-user:bridge-b'), true, 'identified by its native row after the remount')
  } finally {
    registration.dispose()
    restore()
  }
})

test('a queued row this client never sent is adopted, and a Stop discards waiting prompts', async () => {
  storage.clear()
  const sessionID = 'queued-session-2'
  let page = { messages: [
    user(sessionID, 'native-1', 'running elsewhere'),
    assistant(sessionID, 'reply-1', 'thinking'),
    user(sessionID, 'native-2', 'queued elsewhere', true)
  ], hasMore: false }
  api.loadMessagePage = async () => page
  api.listStatuses = async () => ({ [sessionID]: { type: 'busy' } })
  respondWith([{ status: 'accepted', clientRequestId: 'stop-1' }])

  const registration = registerNativeSessionV3Adapter(target(sessionID), () => {})
  try {
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY)
    let conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.deepEqual(conversation.turns.map((turn) => turn.prompt), ['running elsewhere'], 'the initial page never turns a queued row into a turn')

    page = { messages: [
      user(sessionID, 'native-1', 'running elsewhere'),
      assistant(sessionID, 'reply-1', 'done'),
      user(sessionID, 'native-2', 'queued elsewhere'),
      assistant(sessionID, 'reply-2', 'now on it')
    ], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)
    conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.deepEqual(conversation.turns.map((turn) => turn.prompt), ['running elsewhere', 'queued elsewhere'])

    page = { messages: [...page.messages, user(sessionID, 'native-3', 'third', true)], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)
    await registration.controller.stopConversation(CONFIG, registration.conversation.id)
    page = { messages: page.messages.slice(0, -1), hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, sessionID, DIRECTORY, undefined, 200, true)
    conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.equal(conversation.turns.some((turn) => turn.prompt === 'third'), false, 'a stopped queued prompt never becomes a turn')
  } finally {
    registration.dispose()
    restore()
    if (originalStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = originalStorage
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
})
