import assert from 'node:assert/strict'
import {
  toAgentOption,
  toCommandOption,
  toDiffFile,
  toFileEntry,
  toFormAnswer,
  toMessageEnvelope,
  toModelOption,
  toQuestionRequest,
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

// A v2 /api/model entry that carries only `id` (no `modelID`) must still be flagged as the default.
const idOnlyModel = toModelOption({ id: 'deepseek-v4-flash', providerID: 'opencode-go', name: 'DeepSeek V4 Flash' }, 'deepseek-v4-flash')
assert.equal(idOnlyModel[0].isDefault, true)
const nonDefault = toModelOption({ id: 'other', providerID: 'opencode-go', name: 'Other' }, 'deepseek-v4-flash')
assert.equal(nonDefault[0].isDefault, false)

// Forms: one question per field, options surfaced by label for the UI.
const liveForm = {
  id: 'frm_1',
  sessionID: 'ses_x',
  title: 'Choose',
  fields: [
    {
      key: 'framework',
      title: 'Which framework?',
      type: 'select',
      options: [
        { value: 'react', label: 'React' },
        { value: 'vue', label: 'Vue' }
      ]
    },
    {
      key: 'features',
      title: 'Which features?',
      type: 'multiselect',
      options: [
        { value: 'ts', label: 'TypeScript' },
        { value: 'ssr', label: 'SSR' }
      ]
    },
    { key: 'name', title: 'Project name?', type: 'string' }
  ]
}

const question = toQuestionRequest(liveForm)
assert.equal(question.id, 'frm_1')
assert.equal(question.sessionID, 'ses_x')
assert.equal(question.questions.length, 3)
assert.equal(question.questions[0].question, 'Which framework?')
assert.equal(question.questions[0].multiple, false)
assert.equal(question.questions[1].multiple, true)
assert.deepEqual(question.questions[0].options, [
  { label: 'React', description: '' },
  { label: 'Vue', description: '' }
])
// A plain `string` field has no options, so it must expose the free-text input (custom).
assert.equal(question.questions[2].custom, true)
assert.deepEqual(question.questions[2].options, [])

// Replies must be keyed by field.key and carry option.value (not the display label), typed per field.
const answer = toFormAnswer(liveForm, [['React'], ['TypeScript', 'SSR'], ['my-app']])
assert.deepEqual(answer, { framework: 'react', features: ['ts', 'ssr'], name: 'my-app' })

// Free-text answers with no matching option pass through unchanged.
const customAnswer = toFormAnswer(liveForm, [['React'], [], ['custom-name']])
assert.deepEqual(customAnswer, { framework: 'react', features: [], name: 'custom-name' })

// Contract field types: string | number | integer | boolean | multiselect | external.
const typedForm = {
  id: 'frm_2',
  sessionID: 'ses_y',
  fields: [
    { key: 'name', title: 'Name', type: 'string' },
    { key: 'count', title: 'Count', type: 'number' },
    { key: 'retries', title: 'Retries', type: 'integer' },
    { key: 'enabled', title: 'Enabled', type: 'boolean' },
    { key: 'nickname', title: 'Nickname', type: 'string', required: false },
    { key: 'token', title: 'Token', type: 'external' }
  ]
}

const typedQuestions = toQuestionRequest(typedForm)
// Plain string/number/integer are answerable via a text input, and required ones block submission.
for (const index of [0, 1, 2]) {
  assert.equal(typedQuestions.questions[index].custom, true)
  assert.equal(typedQuestions.questions[index].optional ?? false, false)
}
// Boolean renders as Yes/No choices, not an open text box.
assert.equal(typedQuestions.questions[3].custom, false)
assert.deepEqual(typedQuestions.questions[3].options, [
  { label: 'Yes', description: '' },
  { label: 'No', description: '' }
])
// Optional and external fields must not block submission.
assert.equal(typedQuestions.questions[4].optional, true)
assert.equal(typedQuestions.questions[5].optional, true)

// number/integer answers are numeric; boolean maps to a real boolean via the synthesized option.
const typedAnswer = toFormAnswer(typedForm, [['Ada'], ['3.5'], ['7'], ['Yes'], [], []])
assert.deepEqual(typedAnswer, { name: 'Ada', count: 3.5, retries: 7, enabled: true })
assert.equal(typeof typedAnswer.count, 'number')
assert.equal(typeof typedAnswer.retries, 'number')
assert.equal(typeof typedAnswer.enabled, 'boolean')
// The blank optional field and the unanswerable external field are omitted, not sent as empty values.
assert.equal('nickname' in typedAnswer, false)
assert.equal('token' in typedAnswer, false)

// A boolean answered "No" maps to false.
assert.equal(toFormAnswer(typedForm, [['Ada'], ['1'], ['1'], ['No'], [], []]).enabled, false)

console.log('OpenCode 2 client mapping tests passed')
