import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createOpenCode2HistoryLoader } from '../src/opencode2-session-history.js'
import { AcpService } from '../src/acp-service.js'

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
