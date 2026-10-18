import assert from 'node:assert/strict'
import test from 'node:test'

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

// OpenCode 2 is a distinct backend id but its native export carries the same OpenCode assistant
// envelopes, so it must use the same transcript-proven lifecycle as OpenCode 1. Before that parity,
// a reasoning-only reply with a completed timestamp looked finished and a persisted final answer
// could not settle a turn on its own.
const CONFIG = {
  backend: 'opencode2',
  host: '127.0.0.1',
  port: 4097,
  username: 'harness',
  password: 'pw',
  agentId: 'opencode2'
}
const MODEL = { providerID: 'opencode', modelID: 'longcat-2.5-preview-free' }
const SESSION_ID = 'opencode2-reasoning-only-session'
const DIRECTORY = '/repo'
const PROMPT = 'What does this software do?'
const FINAL = 'This software controls native coding-agent sessions.'

function target() {
  return {
    key: `machine:opencode2:${SESSION_ID}`,
    ref: { machineID: 'machine', agentID: 'opencode2', sessionID: SESSION_ID, directory: DIRECTORY },
    machineID: 'machine',
    agentID: 'opencode2',
    agentLabel: 'OpenCode 2',
    backend: 'opencode2',
    transport: 'acp',
    sessionID: SESSION_ID,
    directory: DIRECTORY,
    title: 'Existing OpenCode 2 Session',
    external: true,
    modelsSupported: true,
    model: MODEL,
    requiresExplicitClaim: false,
    canStop: true,
    config: CONFIG
  }
}

function userMessage() {
  return {
    info: {
      id: 'native-user-1',
      role: 'user',
      sessionID: SESSION_ID,
      time: { created: 1000 },
      model: MODEL
    },
    parts: [{ id: 'native-user-1:text', messageID: 'native-user-1', type: 'text', text: PROMPT }]
  }
}

function reasoningOnlyAssistant() {
  return {
    info: {
      id: 'native-assistant-1',
      role: 'assistant',
      sessionID: SESSION_ID,
      time: { created: 1001, completed: 1002 },
      finish: 'stop',
      providerID: MODEL.providerID,
      modelID: MODEL.modelID
    },
    parts: [{
      id: 'native-assistant-1:reasoning',
      messageID: 'native-assistant-1',
      type: 'reasoning',
      text: 'I should answer the user, but no final answer has been persisted.'
    }]
  }
}

function finalAssistant() {
  return {
    info: {
      id: 'native-assistant-1',
      role: 'assistant',
      sessionID: SESSION_ID,
      time: { created: 1001, completed: 1003 },
      finish: 'stop',
      providerID: MODEL.providerID,
      modelID: MODEL.modelID
    },
    parts: [
      {
        id: 'native-assistant-1:reasoning',
        messageID: 'native-assistant-1',
        type: 'reasoning',
        text: 'I should answer the user.'
      },
      {
        id: 'native-assistant-1:text',
        messageID: 'native-assistant-1',
        type: 'text',
        text: FINAL
      }
    ]
  }
}

test('OpenCode 2 idle + finish=stop + reasoning-only never becomes successful Ready', async () => {
  storage.clear()
  let page = { messages: [], hasMore: false }
  api.loadMessagePage = async () => page
  api.listStatuses = async () => ({ [SESSION_ID]: { type: 'idle' } })
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'accepted', clientRequestId: 'request-1' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })

  const updates = []
  const registration = registerNativeSessionV3Adapter(target(), (conversation) => updates.push(conversation))
  try {
    await registration.controller.loadMessagePage(CONFIG, SESSION_ID, DIRECTORY)

    const accepted = await registration.controller.continueConversation(
      CONFIG,
      registration.conversation.id,
      { prompt: PROMPT, model: MODEL }
    )
    assert.equal(accepted.status, 'running', 'accepted OpenCode 2 prompt starts optimistically running')

    // A completed reasoning-only envelope must not look like a finished OpenCode 2 turn just because
    // it carries a completed timestamp.
    page = { messages: [userMessage(), reasoningOnlyAssistant()], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, SESSION_ID, DIRECTORY, undefined, 200, true)

    const firstIdle = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.equal(firstIdle.status, 'running', 'one idle edge cannot turn reasoning-only activity into success')

    await new Promise((resolve) => setTimeout(resolve, 850))
    const stableIdle = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.equal(
      stableIdle.status,
      'running',
      'even stable native idle cannot report Ready until the durable transcript contains final assistant text'
    )
    assert.equal(stableIdle.error, null, 'the bounded no-final recovery owns eventual failure presentation')

    // The persisted final answer alone must settle the same turn, exactly as it does for OpenCode 1.
    page = { messages: [userMessage(), finalAssistant()], hasMore: false }
    await registration.controller.loadMessagePage(CONFIG, SESSION_ID, DIRECTORY, undefined, 200, true)
    const completed = updates.at(-1)
    assert.equal(completed.status, 'completed', 'durable final text is authoritative completion proof')
    assert.equal(completed.error, null)
  } finally {
    registration.dispose()
    api.loadMessagePage = originalLoadMessagePage
    api.listStatuses = originalListStatuses
    globalThis.fetch = originalFetch
    if (originalStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = originalStorage
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
})
