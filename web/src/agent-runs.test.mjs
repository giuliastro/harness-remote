import assert from 'node:assert/strict'
import { normalizeAgentRunStatus, toAgentRun } from './agentRuns.ts'

const session = (overrides = {}) => ({
  id: 'session-1',
  title: 'Fix issue #131',
  directory: '/work/harness-remote',
  updated: 1_723_456_789_000,
  status: 'idle',
  files: 0,
  additions: 0,
  deletions: 0,
  ...overrides
})

assert.equal(normalizeAgentRunStatus('idle'), 'idle')
assert.equal(normalizeAgentRunStatus('busy'), 'working')
assert.equal(normalizeAgentRunStatus('retry'), 'retrying')
assert.equal(normalizeAgentRunStatus('waiting'), 'waiting')
assert.equal(normalizeAgentRunStatus('BUSY'), 'working', 'status normalization should be case-insensitive')
assert.equal(normalizeAgentRunStatus('unknown-backend-state'), 'idle', 'unknown states must fail safe')

// These words already fall through the unknown branch above, so they name a decision rather than
// add behaviour: terminal states come only from the explicit terminalStatus signal. An earlier
// revision mapped them directly, which would have promoted a harness reporting a transient `error`
// to a terminal failed run — visible in a future Inbox as finished, with no way back to working.
// Without a case that says so, restoring those aliases would pass the suite.
for (const word of ['error', 'failure', 'done', 'success', 'completed', 'cancelled', 'aborted']) {
  assert.equal(
    normalizeAgentRunStatus(word),
    'idle',
    `a harness reporting "${word}" must not be read as a terminal run`
  )
}

const openCodeRun = toAgentRun(session({ status: 'busy' }), 'opencode')
assert.deepEqual(openCodeRun, {
  id: 'opencode:session-1',
  backend: 'opencode',
  sessionId: 'session-1',
  title: 'Fix issue #131',
  directory: '/work/harness-remote',
  status: 'working',
  updatedAt: 1_723_456_789_000
})

const codexRun = toAgentRun(session({ id: 'codex-session', status: 'waiting' }), 'codex', {
  machineId: 'workstation',
  projectId: 'harness-remote',
  startedAt: 1_723_456_000_000
})
assert.equal(codexRun.backend, 'codex')
assert.equal(codexRun.sessionId, 'codex-session')
assert.equal(codexRun.status, 'waiting')
assert.equal(codexRun.attention, undefined, 'waiting on agent/subagent work is not user attention')
assert.equal(codexRun.machineId, 'workstation')
assert.equal(codexRun.projectId, 'harness-remote')
assert.equal(codexRun.startedAt, 1_723_456_000_000)

const questionRun = toAgentRun(session(), 'opencode', {
  questions: [
    { id: 'question-other', sessionID: 'another-session' },
    { id: 'question-1', sessionID: 'session-1' }
  ]
})
assert.deepEqual(questionRun.attention, { reason: 'question', requestId: 'question-1' })

const permissionRun = toAgentRun(session(), 'opencode', {
  questions: [{ id: 'question-1', sessionID: 'session-1' }],
  permissions: [{ id: 'permission-1', sessionID: 'session-1' }]
})
assert.deepEqual(
  permissionRun.attention,
  { reason: 'permission', requestId: 'permission-1' },
  'permissions should take precedence when more than one actionable signal exists'
)

const failedRun = toAgentRun(session({ status: 'idle' }), 'claude', { terminalStatus: 'failed' })
assert.equal(failedRun.status, 'failed')
assert.deepEqual(failedRun.attention, { reason: 'failure' })

const completedRun = toAgentRun(session({ status: 'busy' }), 'pi', { terminalStatus: 'completed' })
assert.equal(completedRun.status, 'completed')
assert.deepEqual(completedRun.attention, { reason: 'completion' })

const stoppedRun = toAgentRun(session({ status: 'busy' }), 'omp', { terminalStatus: 'stopped' })
assert.equal(stoppedRun.status, 'stopped')
assert.equal(stoppedRun.attention, undefined)

console.log('agent run normalization tests passed')
