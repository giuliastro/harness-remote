import assert from 'node:assert/strict'
import { test } from 'node:test'

const { buildTrayMenu, shouldHideWindowOnClose } = await import('../dist-electron/electron/desktop-tray.js')

test('tray menu exposes Open and Quit with the provided labels', () => {
  let opened = 0
  let quit = 0
  const menu = buildTrayMenu(
    { open: 'Apri Harness Remote', quit: 'Esci', tooltip: 'Harness Remote' },
    { open: () => { opened += 1 }, quit: () => { quit += 1 } }
  )
  assert.deepEqual(menu.map((entry) => entry.label ?? entry.type), ['Apri Harness Remote', 'separator', 'Esci'])
  menu[0].click?.({}, undefined, undefined)
  menu[2].click?.({}, undefined, undefined)
  assert.equal(opened, 1)
  assert.equal(quit, 1)
})

test('closing hides only while a tray exists and the app is not quitting', () => {
  assert.equal(shouldHideWindowOnClose(false, true), true)
  assert.equal(shouldHideWindowOnClose(true, true), false)
  assert.equal(shouldHideWindowOnClose(false, false), false)
})
