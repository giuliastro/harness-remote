import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskDeskConversation } from './components/taskdesk-conversation'

function render(overrides = {}) {
  return renderToStaticMarkup(createElement(TaskDeskConversation, {
    messages: [],
    agentLabel: 'OpenCode 2',
    agentBackend: 'opencode2',
    draft: '',
    onDraftChange() {},
    onSend() {},
    ...overrides
  }))
}

// Reopening a busy Session knows its runtime status before its history arrives. Only the history
// loader should appear until we can tell whether the assistant already has a bubble in that turn.
for (const loadingState of [{ loading: true }, { ready: false }]) {
  for (const pendingState of [{ waiting: true }, { sending: true, showWaitingIndicator: false }]) {
    const html = render({ ...loadingState, ...pendingState, workingLabel: 'OpenCode 2 is getting started' })
    assert.match(html, /Loading conversation/)
    assert.doesNotMatch(html, /uw-message-pending/)
    assert.doesNotMatch(html, /OpenCode 2 is getting started/)
  }
}

const resumed = render({ waiting: true, workingLabel: 'OpenCode 2 is working' })
assert.match(resumed, /uw-message-pending/)
assert.match(resumed, /OpenCode 2 is working/)

const freshSend = render({ sending: true, showWaitingIndicator: false, workingLabel: 'OpenCode 2 is getting started' })
assert.match(freshSend, /uw-message-pending/)
assert.match(freshSend, /OpenCode 2 is getting started/)

const hydrated = render({ waiting: true, showWaitingIndicator: false })
assert.doesNotMatch(hydrated, /uw-message-pending/)

console.log('conversation history loading and reply indicator rendering passed')
