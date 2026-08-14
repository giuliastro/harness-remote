import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('./taskClient.ts', import.meta.url), 'utf8')
const dialog = readFileSync(new URL('./components/task-launch-dialog.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('./task-launch-mobile.css', import.meta.url), 'utf8')

assert.ok(client.includes('candidate.replace(/^\\uFEFF/, "").trim()'), 'native task payload parsing should tolerate a UTF-8 BOM')
assert.ok(client.includes('"data" in candidate'), 'native task payload parsing should unwrap Capacitor data wrappers')
assert.ok(client.includes('Make sure this profile can reach the Harness machine daemon'), 'invalid machine payloads should explain the endpoint problem instead of blaming JSON formatting')
assert.ok(dialog.includes('discoverMachineConnection(config)'), 'the Task dialog must resolve the machine endpoint separately from the session endpoint')
assert.ok(dialog.includes('taskClient.listProjects(connection.config)'), 'project discovery must use the resolved daemon endpoint')
assert.ok(dialog.includes('taskClient.createTask(taskConfig'), 'task creation must stay on the resolved daemon endpoint')
assert.ok(dialog.includes('<div className="wizard-footer">'), 'Task actions should use the same shared wizard footer as New Session')
assert.equal(dialog.includes('minWidth: "6.5rem"'), false, 'Task cancel must not have a one-off width')
assert.equal(dialog.includes('minWidth: "8rem"'), false, 'Task start must not have a one-off width')
assert.ok(css.includes('.sessions-header-actions > button:first-child'), 'mobile toolbar should spend the icon-only slot on Refresh')
assert.ok(css.includes('.sessions-header-actions > button:nth-child(2),'), 'New Task and New Session should keep balanced labeled slots on mobile')
