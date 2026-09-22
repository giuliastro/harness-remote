import assert from 'node:assert/strict'
import test from 'node:test'

globalThis.window ??= globalThis
globalThis.localStorage ??= {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
}

const { api } = await import('./api.ts')
const {
  nativeSessionIsWorking,
  registerNativeSessionV3Adapter,
  stabilizePiTailMessageIDs
} = await import('./native-session-v3-adapter.ts')

const pages = []
api.loadMessagePage = async () => pages.shift() ?? { messages: [], hasMore: false }

const PI_CONFIG = { backend: 'pi', host: '127.0.0.1', port: 4099, username: 'harness', password: 'pw', agentId: 'pi' }

function target(backend = 'pi', sessionID = `${backend}-1`) {
  return {
    key: `machine:${backend}:${sessionID}`,
    ref: { machineID: 'machine', agentID: backend, sessionID, directory: '/repo' },
    machineID: 'machine',
    agentID: backend,
    agentLabel: backend === 'pi' ? 'PI' : 'Other ACP',
    backend,
    transport: 'acp',
    sessionID,
    directory: '/repo',
    title: 'Session',
    external: false,
    modelsSupported: false,
    model: null,
    requiresExplicitClaim: true,
    canStop: true,
    config: { ...PI_CONFIG, backend, agentId: backend }
  }
}

function textMessage(id, role, text, { sessionID = 'pi-1', error } = {}) {
  return {
    info: {
      id,
      role,
      sessionID,
      time: { created: 1 },
      ...(error ? { error } : {})
    },
    parts: [{ id: `${id}:text`, messageID: id, type: 'text', text }]
  }
}

function ids(messages) {
  return messages.map((message) => message.info.id)
}

test('native Session working-state aliases remain behavioral rather than source-text contracts', () => {
  for (const status of ['busy', 'starting', 'running', 'working', 'retry', 'waiting', 'in_progress', 'in-progress']) {
    assert.equal(nativeSessionIsWorking(status), true, `${status} must keep the Session visibly working`)
  }
  assert.equal(nativeSessionIsWorking('  WAITING  '), true, 'working-state matching remains trimmed and case-insensitive')

  for (const status of [undefined, '', 'idle', 'ready', 'completed', 'failed', 'cancelled']) {
    assert.equal(nativeSessionIsWorking(status), false, `${String(status)} must not be treated as working`)
  }
})

test('PI current-tail live ACP ids remain stable when the authoritative journal replaces them', async () => {
  const registration = registerNativeSessionV3Adapter(target(), () => {})
  try {
    pages.push({
      messages: [
        textMessage('live-user', 'user', 'Explain the failure'),
        textMessage('live-assistant', 'assistant', 'The answer')
      ],
      hasMore: false
    })
    const live = await registration.controller.loadMessagePage(PI_CONFIG, 'pi-1', '/repo')
    assert.deepEqual(ids(live.messages), ['live-user', 'live-assistant'])

    pages.push({
      messages: [
        textMessage('journal-user', 'user', 'Explain the failure'),
        textMessage('journal-assistant', 'assistant', 'The answer')
      ],
      hasMore: false
    })
    const journal = await registration.controller.loadMessagePage(PI_CONFIG, 'pi-1', '/repo')

    assert.deepEqual(
      ids(journal.messages),
      ['live-user', 'live-assistant'],
      'the journal replacement must preserve the browser identities already shown for the same PI turn'
    )
    assert.deepEqual(
      journal.messages.map((message) => message.parts[0].messageID),
      ['live-user', 'live-assistant'],
      'part ownership must follow the stabilized message identity'
    )
  } finally {
    registration.dispose()
  }
})

test('PI stabilization fails closed when repeated identical messages are ambiguous', () => {
  const previousAmbiguous = [
    textMessage('live-a1', 'assistant', 'Same answer'),
    textMessage('live-a2', 'assistant', 'Same answer')
  ]
  const oneJournalAnswer = [textMessage('journal-a1', 'assistant', 'Same answer')]
  assert.deepEqual(
    ids(stabilizePiTailMessageIDs(previousAmbiguous, oneJournalAnswer)),
    ['journal-a1'],
    'multiple previous candidates must never be guessed into one identity'
  )

  const oneLiveAnswer = [textMessage('live-a1', 'assistant', 'Same answer')]
  const repeatedJournalAnswers = [
    textMessage('journal-a1', 'assistant', 'Same answer'),
    textMessage('journal-a2', 'assistant', 'Same answer')
  ]
  assert.deepEqual(
    ids(stabilizePiTailMessageIDs(oneLiveAnswer, repeatedJournalAnswers)),
    ['journal-a1', 'journal-a2'],
    'multiple new messages with the same semantic key must remain distinct'
  )
})

test('PI terminal errors stabilize by their prompt identity without text-aliasing ordinary replies', () => {
  const previous = [
    textMessage('live-user', 'user', 'Try the request'),
    textMessage('live-error', 'assistant', 'Provider said one thing', {
      error: { name: 'ProviderError', message: 'Provider said one thing' }
    })
  ]
  const next = [
    textMessage('journal-user', 'user', 'Try the request'),
    textMessage('journal-error', 'assistant', 'Persisted provider wording changed', {
      error: { name: 'ProviderError', message: 'Persisted provider wording changed' }
    })
  ]

  const stabilized = stabilizePiTailMessageIDs(previous, next)
  assert.deepEqual(ids(stabilized), ['live-user', 'live-error'])
  assert.equal(stabilized[1].parts[0].messageID, 'live-error')

  const unrelatedNormalReply = [textMessage('journal-normal', 'assistant', 'Provider said one thing')]
  assert.deepEqual(
    ids(stabilizePiTailMessageIDs([previous[1]], unrelatedNormalReply)),
    ['journal-normal'],
    'an error envelope must not become a text-key candidate for an ordinary assistant reply'
  )
})

test('PI identity stabilization is current-tail only', async () => {
  const registration = registerNativeSessionV3Adapter(target(), () => {})
  try {
    pages.push({
      messages: [textMessage('live-user', 'user', 'Older prompt')],
      hasMore: true
    })
    await registration.controller.loadMessagePage(PI_CONFIG, 'pi-1', '/repo')

    pages.push({
      messages: [textMessage('journal-user', 'user', 'Older prompt')],
      hasMore: false
    })
    const older = await registration.controller.loadMessagePage(PI_CONFIG, 'pi-1', '/repo', 'older-cursor')
    assert.deepEqual(
      ids(older.messages),
      ['journal-user'],
      'explicit older-page history must keep its native ids rather than being rewritten by tail reconciliation'
    )
  } finally {
    registration.dispose()
  }
})

test('non-PI backends never use PI tail identity reconciliation', async () => {
  const backend = 'claude'
  const config = { ...PI_CONFIG, backend, agentId: backend }
  const registration = registerNativeSessionV3Adapter(target(backend, 'claude-1'), () => {})
  try {
    pages.push({
      messages: [textMessage('live-user', 'user', 'Same prompt', { sessionID: 'claude-1' })],
      hasMore: false
    })
    await registration.controller.loadMessagePage(config, 'claude-1', '/repo')

    pages.push({
      messages: [textMessage('journal-user', 'user', 'Same prompt', { sessionID: 'claude-1' })],
      hasMore: false
    })
    const next = await registration.controller.loadMessagePage(config, 'claude-1', '/repo')
    assert.deepEqual(ids(next.messages), ['journal-user'])
  } finally {
    registration.dispose()
  }
})
