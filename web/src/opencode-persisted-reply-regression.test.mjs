import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8')
const adapter = read('./native-session-v3-adapter.ts')
const observer = read('./components/native-session-observer.tsx')
const workThread = read('./components/work-thread-conversation.tsx')

assert.ok(
  adapter.includes('transcriptListeners') && adapter.includes('notifyTranscript(entry)'),
  'background OpenCode transcript recovery must request a mounted tail refresh'
)
assert.ok(
  adapter.includes('openCodeAssistantHasActivity') && adapter.includes('if (!completedByTranscript && !terminalError) {'),
  'an empty OpenCode assistant envelope must not cancel silent-turn recovery'
)
assert.ok(
  adapter.indexOf('page = await api.loadMessagePage') < adapter.indexOf('statuses = await api.listStatuses'),
  'OpenCode silent recovery must read the transcript before optional status enrichment'
)
assert.ok(
  observer.includes('transcriptRefreshToken') && observer.includes('handleTranscriptRefresh'),
  'the mounted native Session observer must propagate background transcript refreshes'
)
assert.ok(
  workThread.includes('transcriptRefreshToken') && workThread.includes('void refreshCurrentTail()'),
  'background transcript recovery must rehydrate the selected WorkThread feed'
)
assert.ok(
  workThread.includes('const tailRefresh = refreshCurrentTail(prior)')
    && workThread.includes('Promise.allSettled([tailRefresh, attentionRefresh])'),
  'status reconciliation must not block the selected transcript tail'
)

console.log('OpenCode persisted-reply recovery guards passed')
