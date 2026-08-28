import assert from 'node:assert/strict'
import test from 'node:test'

/*
 * What the model picker and the conversation are told about an OMP Session's model.
 *
 * Two symptoms came from the same gap: OMP reported its model on the transcript page, but the
 * runtime only listened for that on the two backends it was written for. So returning to a
 * working Session showed "Harness default" until something else filled it in, and a turn minted
 * before the answer arrived carried no model at all - which the timeline reads as a model change
 * and announces in the conversation, on the very turn where nothing changed.
 */

globalThis.window ??= globalThis
globalThis.localStorage ??= {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
}

const { api } = await import('./api.ts')
const { buildConversationTimeline } = await import('./work-thread-timeline.ts')

const pages = []
api.loadMessagePage = async () => pages.shift() ?? { messages: [], hasMore: false }

const { registerNativeSessionV3Adapter } = await import('./native-session-v3-adapter.ts')

const CONFIG = { backend: 'omp', host: '127.0.0.1', port: 4099, username: 'harness', password: 'pw', agentId: 'omp' }
const MODEL = { providerID: 'anthropic', modelID: 'claude-sonnet-4' }

function target(overrides = {}) {
  return {
    key: 'machine:omp:omp-1',
    ref: { machineID: 'machine', agentID: 'omp', sessionID: 'omp-1', directory: '/repo' },
    machineID: 'machine',
    agentID: 'omp',
    agentLabel: 'Oh My Pi',
    backend: 'omp',
    transport: 'acp',
    sessionID: 'omp-1',
    directory: '/repo',
    title: 'Session',
    external: false,
    modelsSupported: true,
    model: null,
    requiresExplicitClaim: true,
    canStop: true,
    config: CONFIG,
    ...overrides
  }
}

function message(id, role, text) {
  return { info: { id, role, sessionID: 'omp-1', time: { created: 1 } }, parts: [{ id: `${id}:t`, messageID: id, type: 'text', text }] }
}

test('an OMP transcript page carries the Session model into the open runtime', async () => {
  const updates = []
  const registration = registerNativeSessionV3Adapter(target(), (conversation) => updates.push(conversation))
  try {
    assert.equal(registration.conversation.model, null, 'the Session mounts before its model is known')

    pages.push({
      messages: [
        message('u1', 'user', 'Earlier question'),
        message('a1', 'assistant', 'Earlier answer'),
        message('u2', 'user', 'Follow-up question'),
        message('a2', 'assistant', 'Follow-up answer')
      ],
      hasMore: false,
      model: MODEL
    })
    await registration.controller.loadMessagePage(CONFIG, 'omp-1', '/repo')

    const latest = updates.at(-1)
    assert.deepEqual(latest.model, MODEL, 'the picker must show the model OMP is actually on')
    assert.deepEqual(
      latest.turns.map((turn) => turn.model),
      [MODEL, MODEL],
      'the turns recovered from the transcript adopt it too'
    )
  } finally {
    registration.dispose()
  }
})

test('continuing a recovered OMP Session announces no model change', async () => {
  const updates = []
  const registration = registerNativeSessionV3Adapter(target(), (conversation) => updates.push(conversation))
  try {
    // The first page lands before the model is known, which is what mints turns without one.
    pages.push({
      messages: [
        message('u1', 'user', 'Earlier question'),
        message('a1', 'assistant', 'Earlier answer'),
        message('u2', 'user', 'Follow-up question'),
        message('a2', 'assistant', 'Follow-up answer')
      ],
      hasMore: false
    })
    await registration.controller.loadMessagePage(CONFIG, 'omp-1', '/repo')
    assert.deepEqual(updates.at(-1).turns.map((turn) => turn.model), [null, null])

    pages.push({ messages: [], hasMore: false, model: MODEL })
    await registration.controller.loadMessagePage(CONFIG, 'omp-1', '/repo')

    const conversation = updates.at(-1)
    assert.deepEqual(
      conversation.turns.map((turn) => turn.model),
      [MODEL, MODEL],
      'a turn that never had a model must adopt the recovered one'
    )

    // Continuing on that same model adds a turn carrying it. Against turns that still had none, the
    // timeline read the pair as a switch and wrote "Model changed to ..." into the conversation.
    const next = {
      id: `${conversation.id}:request:new`,
      sequence: conversation.turns.length + 1,
      agentId: 'omp',
      model: MODEL,
      role: 'continue',
      sessionId: 'omp-1',
      status: 'running',
      directory: '/repo',
      prompt: 'Next question',
      startedAt: new Date(3000).toISOString()
    }
    const continued = { ...conversation, turns: [...conversation.turns, next], currentTurn: next, status: 'running' }
    const timeline = buildConversationTimeline(continued, { 'omp-1': [] }, { omp: { label: 'Oh My Pi', backend: 'omp' } })
    assert.equal(
      timeline.filter((entry) => entry.taskdesk?.kind === 'event').length,
      0,
      'continuing on the same model must announce nothing'
    )
  } finally {
    registration.dispose()
  }
})
