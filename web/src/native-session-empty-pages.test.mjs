import assert from 'node:assert/strict'
import { discoverAgentNativeSessionPageSkippingEmpty } from './native-session-discovery.ts'

const base = {
  backend: 'codex',
  host: '127.0.0.1',
  port: 4099,
  username: 'harness',
  password: 'secret'
}
const agent = {
  id: 'codex',
  label: 'Codex',
  backend: 'codex',
  transport: 'acp',
  managed: true,
  state: 'available',
  capabilities: { sessions: true }
}

function empty(nextCursor) {
  return { sessions: [], ...(nextCursor ? { nextCursor } : {}) }
}

function populated(id, nextCursor) {
  return {
    sessions: [{
      id,
      title: id,
      directory: '/repo',
      time: { created: 1, updated: 2 },
      status: { type: 'idle' }
    }],
    ...(nextCursor ? { nextCursor } : {})
  }
}

function clientFor(responses, calls = []) {
  return {
    async listGlobalSessionPage(_config, cursor) {
      calls.push(cursor)
      const response = responses.shift()
      if (response instanceof Error) throw response
      if (typeof response === 'function') return response(cursor)
      return response
    },
    async listSessions() { throw new Error('paged reads must not use the stable endpoint') },
    async listStatuses() { return {} }
  }
}

{
  const calls = []
  const page = await discoverAgentNativeSessionPageSkippingEmpty(base, agent, undefined, clientFor([
    empty('page-2'),
    populated('new-session', 'older')
  ], calls))
  assert.deepEqual(calls, [undefined, 'page-2'])
  assert.deepEqual(page.records.map((record) => record.key), ['codex:new-session'])
  assert.equal(page.nextCursor, 'older')
}

{
  const calls = []
  const page = await discoverAgentNativeSessionPageSkippingEmpty(base, agent, undefined, clientFor([
    empty('page-2'), empty('page-3'), empty(undefined)
  ], calls))
  assert.deepEqual(calls, [undefined, 'page-2', 'page-3'])
  assert.deepEqual(page.records, [])
  assert.equal(page.nextCursor, undefined)
}

{
  const calls = []
  const page = await discoverAgentNativeSessionPageSkippingEmpty(base, agent, undefined, clientFor([
    populated('first-page', 'older'), empty('should-not-be-read')
  ], calls))
  assert.deepEqual(calls, [undefined])
  assert.deepEqual(page.records.map((record) => record.key), ['codex:first-page'])
  assert.equal(page.nextCursor, 'older')
}

{
  const calls = []
  const client = clientFor([empty('p2'), empty('p3'), empty('p4'), empty('p5')], calls)
  const capped = await discoverAgentNativeSessionPageSkippingEmpty(base, agent, undefined, client)
  assert.deepEqual(calls, [undefined, 'p2', 'p3', 'p4'])
  assert.deepEqual(capped.records, [])
  assert.equal(capped.nextCursor, 'p5', 'the request cap must preserve a manual continuation cursor')

  const resumed = await discoverAgentNativeSessionPageSkippingEmpty(base, agent, capped.nextCursor, clientFor([
    populated('resumed-session')
  ]))
  assert.deepEqual(resumed.records.map((record) => record.key), ['codex:resumed-session'])
}

{
  const calls = []
  const page = await discoverAgentNativeSessionPageSkippingEmpty(base, agent, undefined, clientFor([
    empty('cycle'), empty('cycle')
  ], calls))
  assert.deepEqual(calls, [undefined, 'cycle'])
  assert.deepEqual(page.records, [])
  assert.equal(page.nextCursor, 'cycle')
}

{
  const calls = []
  const page = await discoverAgentNativeSessionPageSkippingEmpty(base, agent, 'a', clientFor([
    empty('b'), empty('a')
  ], calls))
  assert.deepEqual(calls, ['a', 'b'])
  assert.equal(page.nextCursor, 'a')
}

{
  const calls = []
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  let page
  try {
    page = await discoverAgentNativeSessionPageSkippingEmpty(base, agent, undefined, clientFor([
      () => {
        now += 25
        return empty('slow-next')
      },
      async () => new Promise(() => {})
    ], calls), 45)
  } finally {
    Date.now = realNow
  }
  assert.deepEqual(calls, [undefined, 'slow-next'])
  assert.deepEqual(page.records, [])
  assert.equal(page.nextCursor, 'slow-next', 'aggregate timeout must preserve the last successful cursor')
}

{
  const calls = []
  const page = await discoverAgentNativeSessionPageSkippingEmpty(base, agent, undefined, clientFor([
    empty('retry-me'), new Error('later page failed')
  ], calls))
  assert.deepEqual(calls, [undefined, 'retry-me'])
  assert.deepEqual(page.records, [])
  assert.equal(page.nextCursor, 'retry-me')
}

await assert.rejects(
  discoverAgentNativeSessionPageSkippingEmpty(base, agent, 'initial-cursor', clientFor([
    new Error('initial page failed')
  ])),
  /initial page failed/
)

console.log('native-session-empty-pages: all behavioral checks passed')
