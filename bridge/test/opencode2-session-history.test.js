import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createOpenCode2HistoryLoader } from '../src/opencode2-session-history.js'
import { AcpService } from '../src/acp-service.js'
import { harnessProfile } from '../src/harness-profiles.js'

const exported = {
  info: { id: 'ses_test', model: { providerID: 'opencode', id: 'longcat-2.5-preview-free' } },
  messages: [
    { id: 'model', type: 'model-switched' },
    { id: 'u1', type: 'user', time: { created: 1 }, text: 'hello', files: [] },
    { id: 'a1', type: 'assistant', time: { created: 2, completed: 4 }, finish: 'tool-calls', content: [
      { type: 'reasoning', text: 'thinking', time: { created: 2, completed: 3 } },
      { type: 'tool', id: 'call', name: 'shell', state: { status: 'completed', input: { command: 'pwd' }, content: [{ type: 'text', text: '/repo' }] }, time: { created: 3, completed: 4 } }
    ] },
    { id: 'a2', type: 'assistant', time: { created: 5, completed: 6 }, finish: 'stop', content: [{ type: 'text', text: 'final answer' }] },
    { id: 'idle', type: 'idle', outcome: 'succeeded' }
  ]
}
const historyLoader = () => createOpenCode2HistoryLoader({ runExport: async () => structuredClone(exported) })
class Native extends EventEmitter {
  requests = []
  async listSessions() { return [{ sessionId: 'ses_test', cwd: '/missing-opencode2-sandbox', title: 'Old test' }] }
  async start() {}
  async request(method) { this.requests.push(method); throw new Error('Internal error: Internal service failure') }
}

test('native export preserves final answer, stable identities and terminal metadata without opening the project', async () => {
  const native = new Native()
  const options = { historyLoader: historyLoader(), requireExistingDirectory: true }
  const service = new AcpService(native, options)
  const page = await service.messagePage('ses_test')
  assert.deepEqual(page.messages.map(m => m.info.id), ['u1', 'a1', 'a2'])
  assert.equal(page.messages.at(-1).parts[0].text, 'final answer')
  assert.equal(page.messages.at(-1).info.time.completed, 6)
  assert.equal(page.messages[1].parts[1].state.output, '/repo')
  assert.deepEqual(page.model, { providerID: 'opencode', modelID: 'longcat-2.5-preview-free' })
  const restarted = new AcpService(new Native(), options)
  assert.deepEqual(await restarted.messagePage('ses_test'), page)
  assert.deepEqual(native.requests, [])
  await assert.rejects(service.claimSession('ses_test'), /directory is missing or inaccessible.*restore the directory/)
  assert.deepEqual(await service.messagePage('ses_test'), page)
})

test('native export paging retains turn order and invalid exports fail visibly', async () => {
  const loader = historyLoader()
  const tail = await loader.page('ses_test', { limit: 1 })
  assert.equal(tail.messages[0].info.id, 'a2')
  assert.equal(tail.before, 'a2')
  const older = await loader.page('ses_test', { limit: 2, before: tail.before })
  assert.deepEqual(older.messages.map(m => m.info.id), ['u1', 'a1'])
  assert.equal(older.hasMore, false)
  assert.equal(older.model, undefined)
  await assert.rejects(loader.page('ses_test', { before: 'missing' }), /cursor/)
  await assert.rejects(createOpenCode2HistoryLoader({ runExport: async () => ({}) })('ses_test'), /Invalid/)
})

test('continuation reports a removed project even for an already open writer', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode2-missing-project-'))
  const native = new Native()
  native.listSessions = async () => [{ sessionId: 'ses_test', cwd: directory }]
  native.request = async (method) => {
    native.requests.push(method)
    assert.equal(method, 'session/new')
    return { sessionId: 'ses_test' }
  }
  const service = new AcpService(native, { historyLoader: historyLoader(), requireExistingDirectory: true })
  try {
    await service.createSession({ directory })
    await rm(directory, { recursive: true })
    await assert.rejects(service.prompt('ses_test', 'continue'), /directory is missing or inaccessible/)
    assert.deepEqual(native.requests, ['session/new'])
    assert.equal((await service.messagePage('ses_test')).messages.at(-1).parts[0].text, 'final answer')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('native export paging restores default effort as the base model and preserves real effort', async () => {
  const profile = harnessProfile('opencode2')
  for (const variant of ['default', 'high']) {
    const snapshot = structuredClone(exported)
    snapshot.info.model.variant = variant
    const loader = createOpenCode2HistoryLoader({ runExport: async () => snapshot })
    const service = new AcpService(new Native(), {
      historyLoader: loader,
      modelVariantDefaultValues: profile.modelVariantDefaultValues
    })
    assert.deepEqual((await service.messagePage('ses_test')).model, {
      providerID: 'opencode', modelID: 'longcat-2.5-preview-free',
      ...(variant === 'high' ? { variant } : {})
    })
    assert.equal((await loader.page('ses_test')).model.variant, variant, 'normalization must not mutate the native export')
  }
})

test('concurrent reads of one Session share a single native export', async () => {
  let calls = 0
  const loader = createOpenCode2HistoryLoader({
    runExport: async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 25))
      return structuredClone(exported)
    }
  })
  const [first, second, third] = await Promise.all([loader('ses_test'), loader('ses_test'), loader('ses_test')])
  assert.equal(calls, 1, 'overlapping reads of one Session must not spawn overlapping exports')
  assert.deepEqual(first, second)
  assert.deepEqual(second, third)
})

test('a transient truncated export is retried before the read fails', async () => {
  let calls = 0
  const loader = createOpenCode2HistoryLoader({
    runExport: async () => {
      calls += 1
      if (calls < 3) throw new Error('OpenCode 2 returned an invalid history export')
      return structuredClone(exported)
    }
  })
  assert.deepEqual((await loader('ses_test')).map((message) => message.info.id), ['u1', 'a1', 'a2'])
  assert.equal(calls, 3)
})

test('an awaited export retry keeps an otherwise idle process alive', () => {
  const moduleURL = new URL('../src/opencode2-session-history.js', import.meta.url).href
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { createOpenCode2HistoryLoader } from ${JSON.stringify(moduleURL)}
    let attempts = 0
    const loader = createOpenCode2HistoryLoader({ runExport: async () => {
      if (++attempts < 3) throw new Error('truncated export')
      return { info: { id: 'isolated_retry' }, messages: [] }
    } })
    await loader('isolated_retry')
    console.log('retry completed', attempts)
  `], { encoding: 'utf8', timeout: 10_000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /retry completed 3/)
})

test('a non-retryable export failure is surfaced without retrying', async () => {
  let calls = 0
  const loader = createOpenCode2HistoryLoader({
    runExport: async () => {
      calls += 1
      const error = new Error('OpenCode 2 history export timed out')
      error.nonRetryable = true
      throw error
    }
  })
  await assert.rejects(loader('ses_test'), /timed out/)
  assert.equal(calls, 1)
})

test('reads of different Sessions export independently', async () => {
  const started = []
  const loader = createOpenCode2HistoryLoader({
    runExport: async (sessionID) => {
      started.push(sessionID)
      await new Promise((resolve) => setTimeout(resolve, 25))
      return { ...structuredClone(exported), info: { ...exported.info, id: sessionID } }
    }
  })
  await Promise.all([loader('ses_one'), loader('ses_two')])
  assert.deepEqual(started.sort(), ['ses_one', 'ses_two'])
})
