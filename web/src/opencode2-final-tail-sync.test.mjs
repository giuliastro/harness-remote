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
const storage = new MemoryStorage()
globalThis.window ??= globalThis
globalThis.localStorage = storage

const { api } = await import('./api.ts')
const { mergeLatestMessageFeed } = await import('./message-pages.ts')
const { registerNativeSessionV3Adapter } = await import('./native-session-v3-adapter.ts')
const { buildConversationTimeline } = await import('./work-thread-timeline.ts')

const originalLoadMessagePage = api.loadMessagePage
const originalListStatuses = api.listStatuses
const CONFIG = {
  backend: 'opencode2',
  host: '127.0.0.1',
  port: 4097,
  username: 'harness',
  password: 'pw',
  agentId: 'opencode2'
}
const SESSION_ID = 'opencode2-final-tail-sync'
const DIRECTORY = '/repo'
const MODEL = { providerID: 'opencode', modelID: 'longcat-2.5-preview-free' }

function target(status = 'idle') {
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
    title: 'OpenCode 2 Session',
    external: true,
    modelsSupported: true,
    model: MODEL,
    requiresExplicitClaim: false,
    canStop: true,
    status: { type: status },
    config: CONFIG
  }
}

function userMessage(id, text, created) {
  return {
    info: { id, role: 'user', sessionID: SESSION_ID, time: { created }, model: MODEL },
    parts: [{ id: `${id}:text`, messageID: id, type: 'text', text }]
  }
}

function assistantMessage(id, text, created, finish = 'stop') {
  return {
    info: { id, role: 'assistant', sessionID: SESSION_ID, time: { created, completed: created + 1 }, finish, model: MODEL },
    parts: [{ id: `${id}:text`, messageID: id, type: 'text', text }]
  }
}

function texts(timeline) {
  return timeline
    .filter((message) => message.info.role === 'assistant')
    .map((message) => message.parts.filter((part) => part.type === 'text').map((part) => part.text).join(''))
}

function prompts(timeline) {
  return timeline
    .filter((message) => message.info.role === 'user')
    .map((message) => message.parts.filter((part) => part.type === 'text').map((part) => part.text).join(''))
}

test('an open OpenCode 2 Session discovers a desktop turn and settles on its final reply', async () => {
  storage.clear()
  let messages = [
    userMessage('native-user-1', 'first', 1000),
    assistantMessage('native-answer-1', 'one', 1001)
  ]
  let status = 'busy'
  api.loadMessagePage = async () => ({ messages, hasMore: false })
  api.listStatuses = async () => ({ [SESSION_ID]: { type: status } })
  const updates = []
  const registration = registerNativeSessionV3Adapter(target('busy'), (conversation) => updates.push(conversation))
  try {
    await registration.controller.loadMessagePage(CONFIG, SESSION_ID, DIRECTORY)
    let conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.deepEqual(conversation.turns.map((turn) => turn.prompt), ['first'])

    messages = [
      ...messages,
      userMessage('native-user-2', 'second', 2000),
      assistantMessage('native-progress-2', 'working', 2001, 'tool-calls')
    ]
    await registration.controller.loadMessagePage(CONFIG, SESSION_ID, DIRECTORY)
    conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.deepEqual(conversation.turns.map((turn) => turn.prompt), ['first', 'second'])

    messages = [...messages, assistantMessage('native-answer-2', 'final result', 2002)]
    status = 'idle'
    await registration.controller.loadMessagePage(CONFIG, SESSION_ID, DIRECTORY)
    conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.equal(conversation.status, 'completed', 'durable final text must settle a desktop-started OpenCode 2 turn')
    assert.ok(texts(buildConversationTimeline(conversation, { [SESSION_ID]: messages }, {})).at(-1).endsWith('final result'))
    assert.ok(updates.some((update) => update.turns.length === 2))
  } finally {
    registration.dispose()
    api.loadMessagePage = originalLoadMessagePage
    api.listStatuses = originalListStatuses
  }
})

test('a desktop-started OpenCode 2 turn that stops without final text leaves Working after stable idle', async () => {
  storage.clear()
  const messages = [
    userMessage('native-user-1', 'first', 1000),
    assistantMessage('native-progress-1', '', 1001, 'tool-calls')
  ]
  let status = 'busy'
  api.loadMessagePage = async () => ({ messages, hasMore: false })
  api.listStatuses = async () => ({ [SESSION_ID]: { type: status } })
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  const registration = registerNativeSessionV3Adapter(target('busy'), () => {})
  try {
    await registration.controller.loadMessagePage(CONFIG, SESSION_ID, DIRECTORY)
    let conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.equal(conversation.status, 'running')

    status = 'idle'
    conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.equal(conversation.status, 'running', 'one idle edge is not enough to drop an external turn')

    now += 16_000
    conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.notEqual(conversation.status, 'running', 'stable native idle must end an external turn with no final text')
  } finally {
    Date.now = realNow
    registration.dispose()
    api.loadMessagePage = originalLoadMessagePage
    api.listStatuses = originalListStatuses
  }
})

test('an OpenCode 2 live-to-journal identity switch keeps one turn and shows the journal final reply', async () => {
  storage.clear()
  const liveMessages = []
  for (let turn = 1; turn <= 25; turn += 1) {
    liveMessages.push(userMessage(`live-user-${turn}`, `prompt ${turn}`, turn * 1000))
    liveMessages.push(assistantMessage(`live-answer-${turn}`, `answer ${turn}`, turn * 1000 + 1))
  }

  // The mounted Session first reads the bridge's live cache, which mints its own ids.
  let messages = liveMessages
  let status = 'busy'
  api.loadMessagePage = async () => ({ messages, hasMore: false })
  api.listStatuses = async () => ({ [SESSION_ID]: { type: status } })
  const registration = registerNativeSessionV3Adapter(target('busy'), () => {})
  try {
    const initial = await registration.controller.loadMessagePage(CONFIG, SESSION_ID, DIRECTORY)
    let feed = { messages: initial.messages, before: initial.before, hasMore: initial.hasMore }
    let conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)
    assert.equal(conversation.turns.length, 25)

    // Once the turn settles, OpenCode 2 serves the same tail from its journal under native ids.
    // A long Session pages only its newest twenty turns, so the page is not "complete".
    const journalMessages = []
    for (let turn = 6; turn <= 25; turn += 1) {
      journalMessages.push(userMessage(`journal-user-${turn}`, `prompt ${turn}`, turn * 1000))
      journalMessages.push(assistantMessage(
        `journal-answer-${turn}`,
        turn === 25 ? 'journal final result' : `answer ${turn}`,
        turn * 1000 + 1
      ))
    }
    messages = journalMessages
    status = 'idle'
    const page = await registration.controller.loadMessagePage(CONFIG, SESSION_ID, DIRECTORY)
    feed = mergeLatestMessageFeed(feed, { messages: page.messages, before: page.before, hasMore: true })
    conversation = await registration.controller.refreshConversation(CONFIG, registration.conversation.id)

    assert.equal(conversation.status, 'completed')
    const timeline = buildConversationTimeline(conversation, { [SESSION_ID]: feed.messages }, {})
    assert.deepEqual(prompts(timeline), Array.from({ length: 25 }, (_, index) => `prompt ${index + 1}`))
    assert.equal(texts(timeline).at(-1), 'journal final result')
  } finally {
    registration.dispose()
    api.loadMessagePage = originalLoadMessagePage
    api.listStatuses = originalListStatuses
  }
})
