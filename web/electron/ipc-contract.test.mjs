import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const { IPC_CHANNELS, parseDesktopAttentionNotification } = await import('../dist-electron/electron/ipc-contract.js')
const preload = await readFile(new URL('./preload.cts', import.meta.url), 'utf8')
const main = await readFile(new URL('./main.ts', import.meta.url), 'utf8')

test('preload channel map matches main IPC contract', () => {
  for (const [name, channel] of Object.entries(IPC_CHANNELS)) {
    assert.match(preload, new RegExp(`${name}: "${channel}"`), `preload channel ${name} drifted`)
  }
})

test('attention notification payload requires bounded text and exact native Session identity', () => {
  const valid = {
    title: 'Authorization required',
    body: 'write_file\nBoundary: /workspace/**\nThe Session remains blocked until you allow or deny this request.',
    overlayDescription: 'Authorization required · Workstation · Codex',
    target: { machineID: 'machine-1', agentID: 'codex', sessionID: 'session-123' }
  }
  assert.deepEqual(parseDesktopAttentionNotification(valid), valid)
  assert.equal(parseDesktopAttentionNotification({ ...valid, target: { ...valid.target, sessionID: '' } }), null)
  assert.equal(parseDesktopAttentionNotification({ ...valid, title: 'bad\ncontrol' }), null)
  assert.equal(parseDesktopAttentionNotification({ ...valid, body: 'x'.repeat(1001) }), null)
})

test('attention notification click restores the window and sends only the validated Session target', () => {
  assert.match(main, /const parsed = parseDesktopAttentionNotification\(notification\)/)
  assert.match(main, /nativeNotification\.on\("click", \(\) => activateAttention\(notification\)\)/)
  assert.match(main, /if \(window\.isMinimized\(\)\) window\.restore\(\)/)
  assert.match(main, /if \(!window\.isVisible\(\)\) window\.show\(\)/)
  assert.match(main, /window\.focus\(\)/)
  assert.match(main, /window\.webContents\.send\(IPC_CHANNELS\.attentionActivated, notification\.target\)/)
})
