import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

test('native export paging keeps whole user turns and reports only earlier turns', async () => {
  const assistant = (id) => ({ id, type: 'assistant', time: { created: 1, completed: 2 }, content: [{ type: 'text', text: id }] })
  const messages = []
  for (let turn = 1; turn <= 23; turn += 1) {
    messages.push({ id: `u${turn}`, type: 'user', time: { created: turn }, text: `prompt ${turn}`, files: [] })
    messages.push(...Array.from({ length: 20 }, (_, index) => assistant(`a${turn}-${index}`)))
  }
  const loader = createOpenCode2HistoryLoader({
    runExport: async () => ({ info: { id: 'ses_turns' }, messages: structuredClone(messages) })
  })

  // The limit would slice inside the newest turn. Show twenty complete exchanges at once.
  const newest = await loader.page('ses_turns', { limit: 5 })
  assert.equal(newest.messages[0].info.id, 'u4')
  assert.equal(newest.messages.length, 420)
  assert.equal(newest.before, 'u4')
  assert.equal(newest.hasMore, true)

  const oldest = await loader.page('ses_turns', { limit: 5, before: newest.before })
  assert.equal(oldest.messages[0].info.id, 'u1')
  assert.equal(oldest.messages.length, 63)
  assert.equal(oldest.before, null)
  assert.equal(oldest.hasMore, false)
  assert.equal(oldest.model, undefined)
})

test('a byte-heavy newest page stays under the desktop transport budget', async () => {
  const text = 'x'.repeat(2 * 1024 * 1024)
  const messages = []
  for (let turn = 1; turn <= 3; turn += 1) {
    messages.push({ id: `u${turn}`, type: 'user', text: `prompt ${turn}`, files: [], time: { created: turn } })
    messages.push({
      id: `a${turn}`, type: 'assistant', time: { created: turn, completed: turn },
      finish: 'stop', content: [{ type: 'text', text, time: { created: turn, completed: turn } }]
    })
  }
  const loader = createOpenCode2HistoryLoader({ runExport: async () => ({ info: { id: 'ses_bytes' }, messages }) })
  const page = await loader.page('ses_bytes', { limit: 200 })
  assert.equal(page.messages[0].info.role, 'user')
  assert.equal(page.messages[0].parts[0].text, 'prompt 3', 'the newest turn must stay complete and visible')
  assert.equal(page.hasMore, true)
  assert.ok(Buffer.byteLength(JSON.stringify(page.messages)) < 8 * 1024 * 1024, 'one response must stay below the desktop transport cap')

  const older = await loader.page('ses_bytes', { limit: 200, before: page.before })
  assert.equal(older.messages[0].parts[0].text, 'prompt 2')
  assert.equal(older.hasMore, true)
  assert.ok(Buffer.byteLength(JSON.stringify(older.messages)) < 8 * 1024 * 1024)
})

test('a three-prompt Session with many assistant steps opens complete without earlier-history paging', async () => {
  const messages = []
  for (let turn = 1; turn <= 3; turn += 1) {
    messages.push({ id: `u${turn}`, type: 'user', text: `prompt ${turn}`, files: [] })
    messages.push(...Array.from({ length: 110 }, (_, index) => ({
      id: `a${turn}-${index}`, type: 'assistant', content: [{ type: 'text', text: 'step' }]
    })))
  }
  const loader = createOpenCode2HistoryLoader({
    runExport: async () => ({ info: { id: 'ses_short' }, messages })
  })
  const page = await loader.page('ses_short', { limit: 200 })
  assert.deepEqual(page.messages.filter((message) => message.info.role === 'user').map((message) => message.info.id), ['u1', 'u2', 'u3'])
  assert.equal(page.messages.length, 333)
  assert.equal(page.before, null)
  assert.equal(page.hasMore, false)
})

test('native export paging does not slice a long single turn away from its prompt', async () => {
  const loader = historyLoader()
  const page = await loader.page('ses_test', { limit: 1 })
  assert.deepEqual(page.messages.map(message => message.info.id), ['u1', 'a1', 'a2'])
  assert.equal(page.before, null)
  assert.equal(page.hasMore, false)
})

test('native export paging rejects invalid cursors and invalid exports visibly', async () => {
  const loader = historyLoader()
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

test('a structured tool failure is normalized to the message the transcript renders', async () => {
  const failed = structuredClone(exported)
  failed.messages[2].content.push({
    type: 'tool', id: 'edit-call', name: 'edit',
    state: {
      status: 'error',
      input: { filePath: 'bridge/src/harness-profiles.js', oldString: 'missing', newString: 'x' },
      error: { type: 'tool.execution', message: 'Could not find oldString in bridge/src/harness-profiles.js.' }
    },
    time: { created: 3, completed: 4 }
  })
  const loader = createOpenCode2HistoryLoader({ runExport: async () => failed })
  const page = await loader.page('ses_test')
  const toolPart = page.messages[1].parts.at(-1)
  assert.equal(toolPart.tool, 'edit')
  assert.equal(toolPart.state.status, 'error')
  assert.equal(toolPart.state.error, 'Could not find oldString in bridge/src/harness-profiles.js.')
  assert.equal(typeof toolPart.state.error, 'string')
})

test('a large export that exits immediately is read completely from a file descriptor', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opencode2-large-export-'))
  try {
    const script = path.join(directory, 'exporter.mjs')
    const text = 'x'.repeat(5 * 1024 * 1024)
    // OpenCode can exit before a pipe drains, truncating a large export. Redirecting stdout to a
    // file (as the loader now does) keeps the same early exit complete.
    await writeFile(script, `process.stdout.write(JSON.stringify({ info: { id: process.argv[5] }, messages: [{ id: 'u1', type: 'user', text: ${JSON.stringify(text)}, files: [] }] }))\nprocess.exit(0)\n`)
    const loader = createOpenCode2HistoryLoader({ command: process.execPath, args: [script, 'acp'] })
    const messages = await loader('ses_large')
    assert.equal(messages.length, 1)
    assert.equal(messages[0].parts[0].text.length, text.length)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
