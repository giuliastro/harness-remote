import assert from 'node:assert/strict'
import test from 'node:test'

const { api } = await import('./api.ts')
const { registerNativeSessionV3Adapter } = await import('./native-session-v3-adapter.ts')
const { buildConversationTimeline } = await import('./work-thread-timeline.ts')

const originalLoadMessagePage = api.loadMessagePage
const originalListStatuses = api.listStatuses
const config = { backend: 'claude', host: '127.0.0.1', port: 4097, agentId: 'claude' }
const sessionID = 'claude-phone-tail-sync'
const target = {
  key: `machine:claude:${sessionID}`,
  ref: { machineID: 'machine', agentID: 'claude', sessionID, directory: '/repo' },
  machineID: 'machine', agentID: 'claude', agentLabel: 'Claude Code', backend: 'claude',
  transport: 'acp', sessionID, directory: '/repo', title: 'Phone Session',
  external: false, modelsSupported: true, model: null, requiresExplicitClaim: false,
  canStop: true, config
}

function message(id, role, text, created) {
  return {
    info: { id, role, sessionID, time: { created } },
    parts: [{ id: `${id}:text`, messageID: id, type: 'text', text }]
  }
}

test('an open Claude Code Session shows turns written from another client without reopening it', async () => {
  // Only Codex and OpenCode 2 used to turn a newly persisted prompt into a turn while the Session
  // stayed open. A Claude Code Session continued from the phone kept showing its old messages on
  // desktop until the user opened another Session and came back.
  let messages = [message('user-1', 'user', 'first', 1000), message('answer-1', 'assistant', 'one', 1001)]
  api.loadMessagePage = async () => ({ messages, hasMore: false })
  api.listStatuses = async () => ({ [sessionID]: { type: 'idle' } })
  const registration = registerNativeSessionV3Adapter(target, () => undefined)
  try {
    await registration.controller.loadMessagePage(config, sessionID, '/repo')
    let conversation = await registration.controller.refreshConversation(config, registration.conversation.id)
    assert.deepEqual(conversation.turns.map((turn) => turn.prompt), ['first'])

    messages = [...messages, message('user-2', 'user', 'from the phone', 2000), message('answer-2', 'assistant', 'phone reply', 2001)]
    await registration.controller.loadMessagePage(config, sessionID, '/repo')
    conversation = await registration.controller.refreshConversation(config, registration.conversation.id)
    assert.deepEqual(conversation.turns.map((turn) => turn.prompt), ['first', 'from the phone'])
    assert.equal(buildConversationTimeline(conversation, { [sessionID]: messages }, {}).at(-1).parts[0].text, 'phone reply')

    // An ACP replay can re-mint ids and stamp them with the reload time. The same prompts must bind
    // to their existing turns instead of being drawn twice.
    messages = [
      message('replay-user-1', 'user', 'first', 90_000), message('replay-answer-1', 'assistant', 'one', 90_001),
      message('replay-user-2', 'user', 'from the phone', 90_002), message('replay-answer-2', 'assistant', 'phone reply', 90_003)
    ]
    await registration.controller.loadMessagePage(config, sessionID, '/repo')
    conversation = await registration.controller.refreshConversation(config, registration.conversation.id)
    assert.deepEqual(conversation.turns.map((turn) => turn.prompt), ['first', 'from the phone'], 'a replay must not duplicate turns')

    // A genuine repeat of an earlier prompt, while the earlier one is still on the page, is a new turn.
    messages = [...messages, message('user-3', 'user', 'first', 95_000), message('answer-3', 'assistant', 'again', 95_001)]
    await registration.controller.loadMessagePage(config, sessionID, '/repo')
    conversation = await registration.controller.refreshConversation(config, registration.conversation.id)
    assert.deepEqual(conversation.turns.map((turn) => turn.prompt), ['first', 'from the phone', 'first'])
  } finally {
    registration.dispose()
    api.loadMessagePage = originalLoadMessagePage
    api.listStatuses = originalListStatuses
  }
})
