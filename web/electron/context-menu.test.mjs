import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const { buildContextMenu } = await import('../dist-electron/electron/context-menu.js')

const flags = { canUndo: false, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
const t = (key) => `[${key}]`
const rolesOf = (menu) => menu.filter((entry) => entry.type !== 'separator').map((entry) => entry.role ?? entry.label)

test('an editable field gets the full edit menu with the platform flags applied', () => {
  const menu = buildContextMenu({ isEditable: true, selectionText: '', linkURL: '', editFlags: flags }, t)
  assert.deepEqual(rolesOf(menu), ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
  assert.equal(menu.find((entry) => entry.role === 'undo').enabled, false)
  assert.equal(menu.find((entry) => entry.role === 'paste').label, '[ctx.paste]')
})

test('selected transcript text can be copied, and links copied by address', () => {
  const copied = []
  const menu = buildContextMenu(
    { isEditable: false, selectionText: 'npm test', linkURL: 'https://example.com', editFlags: flags },
    t,
    { copyLink: (url) => copied.push(url) }
  )
  assert.deepEqual(rolesOf(menu), ['copy', '[ctx.copyLink]', 'selectAll'])
  menu.find((entry) => entry.label === '[ctx.copyLink]').click()
  assert.deepEqual(copied, ['https://example.com'])
})

test('without a selection the read-only menu does not offer an inert Copy', () => {
  const menu = buildContextMenu({ isEditable: false, selectionText: '  ', linkURL: '', editFlags: flags }, t)
  assert.deepEqual(rolesOf(menu), ['selectAll'])
})

test('the main window wires the menu to the renderer context-menu event', async () => {
  const main = await readFile(new URL('./main.ts', import.meta.url), 'utf8')
  assert.match(main, /contents\.on\("context-menu"/)
  assert.match(main, /buildContextMenu\(params, desktopTranslator\(language, app\.getLocale\(\)\)/)
})
