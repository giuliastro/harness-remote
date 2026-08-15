import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const { IPC_CHANNELS, parseDesktopExternalUrl } = await import('../dist-electron/electron/ipc-contract.js')
const preload = await readFile(new URL('./preload.cts', import.meta.url), 'utf8')

test('preload channel map matches main IPC contract', () => {
  for (const [name, channel] of Object.entries(IPC_CHANNELS)) {
    assert.match(preload, new RegExp(`${name}: "${channel}"`), `preload channel ${name} drifted`)
  }
})

test('external URL validation only permits bounded HTTP(S) targets', () => {
  assert.equal(parseDesktopExternalUrl('https://example.test/path'), 'https://example.test/path')
  assert.equal(parseDesktopExternalUrl('http://localhost:4096/authorize'), 'http://localhost:4096/authorize')
  assert.equal(parseDesktopExternalUrl('javascript:alert(1)'), null)
  assert.equal(parseDesktopExternalUrl('file:///etc/passwd'), null)
  assert.equal(parseDesktopExternalUrl('not a url'), null)
})
