import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTranslator, languageOptions, normalizeLanguage } from './i18n.ts'

assert.equal(normalizeLanguage('it'), 'it')
assert.equal(normalizeLanguage('zh-TW'), 'zh-TW')
assert.equal(normalizeLanguage('zh-CN'), 'zh-CN')
assert.equal(normalizeLanguage('zh-Hans'), 'zh-CN')
assert.equal(normalizeLanguage('zh'), 'zh-CN')
assert.equal(normalizeLanguage('zh-HK'), 'zh-TW')
assert.equal(normalizeLanguage('fr'), 'en')
assert.ok(languageOptions.some((language) => language.code === 'zh-TW'))
assert.ok(languageOptions.some((language) => language.code === 'zh-CN'))

const en = createTranslator('en')
const it = createTranslator('it')
const zh = createTranslator('zh-TW')
const zhCN = createTranslator('zh-CN')

assert.equal(en('sessions.title'), 'Sessions')
assert.equal(it('sessions.title'), 'Sessioni')
assert.equal(zh('sessions.title'), '工作階段')

assert.equal(en('sessions.remoteSessionTitle'), 'Remote session')
assert.equal(it('sessions.remoteSessionTitle'), 'Sessione remota')
assert.equal(zh('sessions.remoteSessionTitle'), '遠端工作階段')

assert.equal(en('session.deleteTitle'), 'Delete session?')
assert.equal(it('session.deleteTitle'), 'Eliminare la sessione?')
assert.equal(zh('session.deleteTitle'), '刪除工作階段？')

assert.equal(en('detail.nothingToUndo'), 'Nothing to undo in this session.')
assert.equal(it('detail.nothingToRedo'), 'Non c’è nulla da ripristinare in questa sessione.')
assert.equal(zh('detail.nothingToUndo'), '此工作階段沒有可復原的內容。')

assert.equal(en('detail.sessionActions'), 'Session actions')
assert.equal(it('detail.sessionActions'), 'Azioni sessione')
assert.equal(zh('detail.sessionActions'), '工作階段動作')

const source = readFileSync(new URL('./i18n.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const languageMarkers = [
  ['en', '  en: {'],
  ['it', '  it: {'],
  ['zh-TW', "  'zh-TW': {"],
  ['zh-CN', "  'zh-CN': {"]
]
const languageStarts = Object.fromEntries(languageMarkers.map(([code, marker]) => [code, source.indexOf(marker)]))
const languageEnd = source.indexOf('\n  }\n}\n\nexport const languageOptions', languageStarts['zh-CN']) + 4
const keysFor = (code, nextCode) => {
  const start = languageStarts[code]
  const end = nextCode ? languageStarts[nextCode] : languageEnd
  return [...source.slice(start, end).matchAll(/^\s*'([^']+)':/gm)]
    .map((match) => match[1])
    .filter((key) => !languageMarkers.some(([language]) => language === key))
}
const englishKeys = keysFor('en', 'it')
for (const [code, nextCode] of [['it', 'zh-TW'], ['zh-TW', 'zh-CN'], ['zh-CN', null]]) {
  const translated = new Set(keysFor(code, nextCode))
  const missing = englishKeys.filter((key) => !translated.has(key))
  assert.deepEqual(missing, [], `${code} must translate every English i18n key`)
}

assert.equal(it('sf.scanAnotherMachine'), 'Scansiona un’altra macchina')
assert.equal(it('sf.viewSessions'), 'Vai alle sessioni')
assert.equal(zh('sf.scanAnotherMachine'), '掃描另一台機器')
assert.equal(zhCN('sf.scanAnotherMachine'), '扫描另一台机器')
assert.equal(zh('command.openSettings'), '開啟設定')
assert.equal(zhCN('detail.attachImage'), '附加图片')

// Unknown keys should remain visible during development instead of rendering blank UI.
assert.equal(en('missing.key'), 'missing.key')
assert.equal(en('detail.opencode'), '🤖 OpenCode')
assert.equal(it('detail.changedFilesTitle'), 'File modificati')
assert.equal(zh('detail.changedFilesTitle'), '已變更檔案')
assert.equal(en('detail.linesAddedDeleted', { additions: 3, deletions: 1 }), '+3 lines · -1 lines')
assert.equal(it('detail.aheadBehind', { ahead: 1, behind: 2 }), '1 avanti · 2 indietro')
assert.equal(zh('detail.fileStatusSource'), '來自 /file/status')
assert.equal(en('detail.fileStatusLabel'), 'Changed files')
assert.equal(it('detail.fileStatusLabel'), 'File modificati')
assert.equal(zh('detail.fileStatusLabel'), '已變更檔案')

assert.equal(en('settings.theme'), 'Theme')
assert.equal(it('settings.themeDark'), 'Scuro')
assert.equal(zh('settings.themeSystem'), '跟隨系統')
assert.equal(en('todo.title'), 'Todo Items')

assert.equal(en('action.preparingTool', { tool: 'write' }), 'Preparing write')
assert.equal(it('action.preparingTool', { tool: 'write' }), 'Preparazione di write')
assert.equal(zh('action.preparingTool', { tool: 'write' }), '正在準備 write')
assert.equal(zhCN('sessions.title'), '会话')
assert.equal(zhCN('session.deleteTitle'), '删除会话？')
assert.equal(zhCN('detail.changedFilesTitle'), '已更改文件')
assert.equal(zhCN('settings.themeSystem'), '跟随系统')
assert.equal(zhCN('action.preparingTool', { tool: 'write' }), '正在准备 write')
assert.equal(zhCN('detail.linesAddedDeleted', { additions: 3, deletions: 1 }), '+3 行 · -1 行')

assert.equal(en('settings.deleteServerTitle'), 'Delete saved server?')
assert.equal(it('settings.deleteServerTitle'), 'Eliminare il server salvato?')
assert.equal(zh('settings.deleteServerTitle'), '刪除已儲存的伺服器？')

console.log('i18n tests passed')
