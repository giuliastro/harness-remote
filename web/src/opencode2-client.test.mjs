import assert from 'node:assert/strict'
import {
  toAgentOption,
  toCommandOption,
  toDiffFile,
  toFileEntry,
  toMessageEnvelope,
  toModelOption,
  toSession,
  toToolState
} from './opencode2-mappers.ts'

// Shapes captured from a live OpenCode 2.0-beta server (GET /api/session and /api/session/{id}/message).

const liveSession = {
  id: 'ses_003dc6eaeffeXJgbfQFfpD8Od2',
  projectID: 'global',
  agent: 'build',
  model: { id: 'deepseek-v4-flash', providerID: 'opencode-go', variant: 'high' },
  cost: 0.0012965372,
  tokens: { input: 11583, output: 1236, reasoning: 453, cache: { read: 178048, write: 0 } },
  time: { created: 1786641617238, updated: 1786710305014 },
  title: 'Greeting',
  location: { directory: '/home/eric' },
  subpath: 'home/eric'
}

assert.deepEqual(toSession(liveSession), {
  id: 'ses_003dc6eaeffeXJgbfQFfpD8Od2',
  title: 'Greeting',
  directory: '/home/eric',
  time: { created: 1786641617238, updated: 1786710305014 },
  model: { id: 'deepseek-v4-flash', providerID: 'opencode-go', variant: 'high' },
  project: { id: 'global', worktree: '/home/eric' },
  revert: undefined,
  summary: undefined,
  external: false
})

assert.deepEqual(toSession({ id: 's1', time: { created: 1, updated: 2 }, revert: { messageID: 'm1', partID: 'p1' } }), {
  id: 's1',
  title: '',
  directory: '',
  time: { created: 1, updated: 2 },
  model: undefined,
  project: undefined,
  revert: { messageID: 'm1', partID: 'p1' },
  summary: undefined,
  external: false
})

// Assistant message with reasoning + text + a completed shell tool, captured live.
const liveAssistant = {
  id: 'msg_0003ba9350016pezEgfmFkO4kN',
  time: { created: 1786710306618, completed: 1786710307224 },
  type: 'assistant',
  agent: 'build',
  model: { id: 'deepseek-v4-flash', providerID: 'opencode-go', variant: 'high' },
  content: [
    { type: 'reasoning', text: 'Compute the timezone.', state: { reasoningField: 'reasoning_content' }, time: { created: 1, completed: 2 } },
    { type: 'text', text: '**2026-08-13 20:11:56 EDT**' }
  ],
  finish: 'stop'
}

const assistantEnvelope = toMessageEnvelope(liveAssistant, 'ses_x')
assert.equal(assistantEnvelope.info.role, 'assistant')
assert.equal(assistantEnvelope.info.sessionID, 'ses_x')
assert.equal(assistantEnvelope.info.time.completed, 1786710307224)
assert.equal(assistantEnvelope.parts.length, 2)
assert.equal(assistantEnvelope.parts[0].type, 'reasoning')
assert.equal(assistantEnvelope.parts[0].text, 'Compute the timezone.')
assert.equal(assistantEnvelope.parts[1].type, 'text')
assert.equal(assistantEnvelope.parts[1].text, '**2026-08-13 20:11:56 EDT**')

const liveTool = {
  id: 'msg_tool1',
  time: { created: 1, completed: 2 },
  type: 'assistant',
  content: [
    {
      type: 'tool',
      id: 'call_00_ET_y87blQPvx3iDyZ0AK3YG8552',
      name: 'shell',
      executed: false,
      state: {
        status: 'completed',
        input: { command: "stat -c '%n: %y' /tmp/x" },
        content: [
          { type: 'text', text: '/tmp/x: 2026-08-14 00:11:56 +0000' },
          { type: 'text', text: 'Command exited with code 0.' }
        ],
        metadata: { status: 'completed', truncated: false, exit: 0 }
      },
      time: { created: 1, ran: 2, completed: 3 }
    }
  ]
}

const toolEnvelope = toMessageEnvelope(liveTool, 'ses_x')
assert.equal(toolEnvelope.parts.length, 1)
assert.equal(toolEnvelope.parts[0].type, 'tool')
assert.equal(toolEnvelope.parts[0].tool, 'shell')
assert.equal(toolEnvelope.parts[0].callID, 'call_00_ET_y87blQPvx3iDyZ0AK3YG8552')
assert.equal(toolEnvelope.parts[0].state?.status, 'completed')
assert.deepEqual(toolEnvelope.parts[0].state?.input, { command: "stat -c '%n: %y' /tmp/x" })
assert.ok(toolEnvelope.parts[0].state?.output?.includes('Command exited with code 0.'))
assert.deepEqual(toolEnvelope.parts[0].state?.metadata, { status: 'completed', truncated: false, exit: 0 })

assert.deepEqual(toToolState({ status: 'error', error: { message: 'boom' } }), {
  status: 'error',
  input: {},
  output: undefined,
  error: 'boom',
  time: undefined,
  metadata: undefined
})

const liveUser = { id: 'msg_user', time: { created: 1 }, type: 'user', text: 'Hello!', files: [], agents: [] }
const userEnvelope = toMessageEnvelope(liveUser, 'ses_x')
assert.equal(userEnvelope.info.role, 'user')
assert.deepEqual(userEnvelope.parts, [{ id: 'msg_user:text', type: 'text', text: 'Hello!' }])

const liveShell = {
  id: 'msg_shell',
  time: { created: 1, completed: 2 },
  type: 'shell',
  command: 'echo hi',
  status: 'exited',
  exit: 0,
  output: { output: 'hi\n', cursor: {}, size: {}, truncated: false }
}
const shellEnvelope = toMessageEnvelope(liveShell, 'ses_x')
assert.equal(shellEnvelope.info.role, 'system')
assert.equal(shellEnvelope.parts[0].type, 'tool')
assert.equal(shellEnvelope.parts[0].tool, 'shell')
assert.equal(shellEnvelope.parts[0].state?.output, 'hi\n')
assert.equal(shellEnvelope.parts[0].state?.status, 'completed')

const modelOptions = toModelOption({
  id: 'deepseek-v4-flash',
  modelID: 'deepseek-v4-flash',
  providerID: 'opencode-go',
  family: 'deepseek-flash',
  name: 'DeepSeek V4 Flash',
  status: 'active',
  enabled: true,
  limit: { context: 1000000, output: 384000 },
  capabilities: { tools: true, input: ['text'], output: ['text'] },
  variants: [{ id: 'low' }, { id: 'high' }, { id: 'max' }]
}, 'deepseek-v4-flash')

assert.equal(modelOptions.length, 4)
assert.equal(modelOptions[0].modelID, 'deepseek-v4-flash')
assert.equal(modelOptions[0].providerID, 'opencode-go')
assert.equal(modelOptions[0].contextLimit, 1000000)
assert.equal(modelOptions[0].outputLimit, 384000)
assert.equal(modelOptions[0].tools, true)
assert.equal(modelOptions[0].attachments, false)
assert.equal(modelOptions[0].isDefault, true)
assert.deepEqual(modelOptions.map((option) => option.variant), [undefined, 'low', 'high', 'max'])
assert.equal(modelOptions.slice(1).every((option) => option.isDefault === false), true)

assert.deepEqual(toAgentOption({ id: 'build', name: 'Build', description: 'Default', mode: 'primary', hidden: false }), {
  id: 'build', name: 'Build', description: 'Default', mode: 'primary', hidden: false
})

assert.deepEqual(toCommandOption({ name: 'init', template: 'x', description: 'Docs' }), {
  name: 'init', description: 'Docs'
})

assert.deepEqual(toFileEntry({ path: 'workspaces/harness-remote/', type: 'directory' }, '/home/eric'), {
  name: 'harness-remote', path: '/home/eric/workspaces/harness-remote/', absolute: '/home/eric/workspaces/harness-remote/', type: 'directory'
})
assert.deepEqual(toFileEntry({ path: 'README.md', type: 'file' }, '/home/eric'), {
  name: 'README.md', path: '/home/eric/README.md', absolute: '/home/eric/README.md', type: 'file'
})

assert.deepEqual(toDiffFile({ file: 'web/src/api.ts', patch: '@@ -1,1 +1,1 @@', additions: 1, deletions: 1, status: 'modified' }), {
  file: 'web/src/api.ts', patch: '@@ -1,1 +1,1 @@', additions: 1, deletions: 1, status: 'modified'
})

console.log('OpenCode 2 client mapping tests passed')
