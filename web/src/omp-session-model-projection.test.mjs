import assert from 'node:assert/strict'
import test from 'node:test'

/*
 * What the model picker and the conversation are told about an OMP Session's model.
 *
 * Two symptoms came from the same gap: OMP reported its model on the transcript page, but the
 * projection only listened for that on the two backends it was written for. So returning to a
 * working Session showed "Harness default" until something else filled it in, and a Run minted
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
const { buildWorkThreadTimeline } = await import('./work-thread-timeline.ts')

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

test('an OMP transcript page carries the Session model into the open projection', async () => {
  const updates = []
  const registration = registerNativeSessionV3Adapter(target(), (task) => updates.push(task))
  try {
    assert.equal(registration.task.model, null, 'the Session mounts before its model is known')

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
      latest.runs.map((run) => run.model),
      [MODEL, MODEL],
      'the Runs recovered from the transcript adopt it too'
    )
  } finally {
    registration.dispose()
  }
})

test('continuing a recovered OMP Session announces no model change', async () => {
  const updates = []
  const registration = registerNativeSessionV3Adapter(target(), (task) => updates.push(task))
  try {
    // The first page lands before the model is known, which is what mints Runs without one.
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
    assert.deepEqual(updates.at(-1).runs.map((run) => run.model), [null, null])

    pages.push({ messages: [], hasMore: false, model: MODEL })
    await registration.controller.loadMessagePage(CONFIG, 'omp-1', '/repo')

    const task = updates.at(-1)
    assert.deepEqual(
      task.runs.map((run) => run.model),
      [MODEL, MODEL],
      'a Run that never had a model must adopt the recovered one'
    )

    // Continuing on that same model adds a Run carrying it. Against Runs that still had none, the
    // timeline read the pair as a switch and wrote "Model changed to ..." into the conversation.
    const next = {
      id: `${task.id}:request:new`,
      sequence: task.runs.length + 1,
      agentId: 'omp',
      model: MODEL,
      role: 'continue',
      sessionId: 'omp-1',
      status: 'running',
      directory: '/repo',
      prompt: 'Next question',
      startedAt: new Date(3000).toISOString()
    }
    const continued = { ...task, runs: [...task.runs, next], run: next, status: 'running' }
    const timeline = buildWorkThreadTimeline(continued, { 'omp-1': [] }, { omp: { label: 'Oh My Pi', backend: 'omp' } })
    assert.equal(
      timeline.filter((entry) => entry.taskdesk?.kind === 'event').length,
      0,
      'continuing on the same model must announce nothing'
    )
  } finally {
    registration.dispose()
  }
})
