import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { api } from './api.ts'
import { SessionModeList, SessionModeMenu } from './components/session-mode-control.tsx'

const config = { backend: 'claude', host: 'mode-machine.invalid', port: 4097, username: 'harness', password: 'secret' }
const originalFetch = globalThis.fetch
const calls = []
const claudeModes = {
  loaded: true,
  currentModeId: 'default',
  modes: [
    { id: 'default', name: 'Manual', description: 'Always ask before making changes' },
    { id: 'acceptEdits', name: 'Accept edits', description: 'Automatically accept all file edits' },
    { id: 'bypassPermissions', name: 'Bypass permissions', description: 'Accepts all permissions', unrestricted: true }
  ]
}

try {
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: new URL(String(input)), init })
    return new Response(JSON.stringify(claudeModes), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  // A background read must never ask the bridge to open the Session; only the picker does.
  await api.loadSessionModes(config, 'ses-1', '/repo with spaces')
  assert.equal(calls[0].url.pathname, '/session/ses-1/mode')
  assert.equal(calls[0].url.searchParams.get('load'), null)
  assert.equal(calls[0].url.searchParams.get('directory'), '/repo with spaces')

  await api.loadSessionModes(config, 'ses-1', '/repo', true)
  assert.equal(calls[1].url.searchParams.get('load'), '1')
  assert.equal(calls[1].url.searchParams.get('directory'), '/repo')

  await api.setSessionMode(config, 'ses-1', 'acceptEdits', '/repo')
  assert.equal(calls[2].url.pathname, '/session/ses-1/mode')
  assert.equal(calls[2].init.method, 'POST')
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { modeId: 'acceptEdits' })
} finally {
  globalThis.fetch = originalFetch
}

const modes = (state, extra = {}) => ({
  state,
  busy: false,
  error: null,
  current: state?.modes.find((mode) => mode.id === state.currentModeId),
  refresh: async () => {},
  open: async () => {},
  select: async () => {},
  ...extra
})

// The list shows the harness's own names and descriptions, marks the current one, and flags a
// mode that removes approvals.
const list = renderToStaticMarkup(createElement(SessionModeList, { modes: modes(claudeModes) }))
assert.match(list, /role="radiogroup"/)
assert.equal((list.match(/role="radio"/g) || []).length, 3)
assert.match(list, /aria-checked="true"[^>]*class="tdw-mode-option selected"[\s\S]*Manual/)
assert.match(list, /class="tdw-mode-option unrestricted"[\s\S]*Bypass permissions/)
assert.match(list, /Automatically accept all file edits/)

// A harness that advertises no modes says so instead of an empty list, and hides the toolbar control.
const none = { loaded: true, modes: [] }
assert.match(renderToStaticMarkup(createElement(SessionModeList, { modes: modes(none) })), /tdw-mode-note/)
assert.equal(renderToStaticMarkup(createElement(SessionModeMenu, { modes: modes(none) })), '')

// Before the Session is open the toolbar still offers the picker, which is what opens it.
const unknown = renderToStaticMarkup(createElement(SessionModeMenu, { modes: modes({ loaded: false, modes: [] }) }))
assert.match(unknown, /class="tdw-mode-trigger"/)

// An unrestricted current mode tints the toolbar control.
const bypass = { ...claudeModes, currentModeId: 'bypassPermissions' }
assert.match(renderToStaticMarkup(createElement(SessionModeMenu, { modes: modes(bypass) })), /tdw-mode-control unrestricted/)

// A failed switch is reported in the list.
assert.match(renderToStaticMarkup(createElement(SessionModeList, { modes: modes(claudeModes, { error: 'boom' }) })), /role="alert"[^>]*>[^<]*boom/)

console.log('session mode control tests passed')
