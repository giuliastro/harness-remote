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

// Waiting for the model catalog: the composer is blocked, and it has to say so rather than look idle.
const modelsLoading = render({ composerDisabled: true, composerBusyLabel: 'Loading models…', draft: 'hello' })
assert.match(modelsLoading, /class="uw-composer-shell busy" aria-busy="true"/)
assert.match(modelsLoading, /<div class="uw-composer-busy" id="uw-composer-busy" role="status" aria-live="polite">/)
assert.match(modelsLoading, /<span>Loading models…<\/span>/)
assert.match(modelsLoading, /<textarea[^>]*disabled=""[^>]*aria-disabled="true"[^>]*aria-describedby="uw-composer-busy"/)
assert.doesNotMatch(modelsLoading, /id="uw-composer-hint"/, 'the busy row replaces the footer hint instead of repeating it')
assert.match(modelsLoading, /<button type="button" class="uw-button uw-button-primary" disabled=""/)

const modelsReady = render({ draft: 'hello' })
assert.doesNotMatch(modelsReady, /uw-composer-busy|aria-busy|aria-disabled/)
assert.match(modelsReady, /class="uw-composer-shell"/)
assert.match(modelsReady, /<small id="uw-composer-hint">/)

console.log('conversation history loading and reply indicator rendering passed')
