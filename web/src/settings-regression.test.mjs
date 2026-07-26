import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const i18n = readFileSync(new URL('./i18n.ts', import.meta.url), 'utf8')

const testConnection = app.match(/async function testConnection[\s\S]*?async function refreshSessions/)
assert.ok(testConnection, 'testConnection function should be present')
assert.equal(testConnection[0].includes('setView("sessions")'), false, 'Test Connection must not navigate away from settings')
assert.equal(testConnection[0].includes('setConfig(configToTest)'), false, 'Test Connection must not overwrite the current configuration')

const applyConfig = app.match(/function applyConfig[\s\S]*?async function testConnection/)
assert.ok(applyConfig, 'applyConfig function should persist the active configuration')
assert.equal(applyConfig[0].includes('setView("sessions")'), false, 'Automatic saves must leave the user on settings')
assert.ok(app.includes('setTimeout(() => applyConfig(draftConfig), 500)'), 'Configuration edits should be persisted after a short debounce')
assert.equal(app.includes('onClick={saveConfig}'), false, 'Settings should not require a separate Save action')
assert.ok(app.includes("t('settings.draftHint')"), 'Settings should explain automatic saving')
assert.ok(i18n.includes("'settings.saved': 'Changes saved automatically.'"), 'Automatic save feedback should be translated')
assert.ok(i18n.includes("'settings.testedNotSaved'"), 'Test success should remain distinct from connectivity state')
assert.ok(app.includes('function canTestConfig'), 'Settings should have a central testability check for required connection fields')
assert.ok(app.includes('disabled={testingConnection || !canTestDraft || testAlreadyPassedForDraft}'), 'Test button should be disabled when fields are missing, testing is active, or the unchanged configuration already passed')
assert.ok(app.includes('connection-help'), 'Settings should explain whether the current configuration can be tested')
assert.equal(app.includes('settings.hostHint'), false, 'Settings should not render redundant explanatory copy below the host field')
assert.ok(app.includes('Full, versioned backend guides live in the Harness Remote repository'), 'Help should link out instead of duplicating every backend guide')
assert.ok(app.includes('"oh-my-pi-bridge-setup"') && app.includes('"opencode-server-setup"'), 'Help should select the repository guide for the active backend')
assert.ok(app.includes('https://github.com/giuliastro/harness-remote#'), 'Help should link to the canonical repository')
assert.equal(app.includes('https://github.com/gervaso-assistant/opencode-remote-android#'), false, 'Help must not link to the obsolete repository owner')

console.log('settings regression tests passed')
