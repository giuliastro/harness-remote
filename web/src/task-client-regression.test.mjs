import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTranslator, languageOptions } from './i18n.ts'

const client = readFileSync(new URL('./taskClient.ts', import.meta.url), 'utf8')
const dialog = readFileSync(new URL('./components/task-launch-dialog.tsx', import.meta.url), 'utf8')
const sessions = readFileSync(new URL('./components/session-list.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

const keys = [...new Set([...dialog.matchAll(/t\('(task\.[a-zA-Z.]+)'/g)].map((match) => match[1]))]
assert.ok(keys.length >= 12, 'the task dialog must take its strings from the shared translator')
for (const language of languageOptions) {
  const translate = createTranslator(language.code)
  for (const key of keys) {
    assert.notEqual(translate(key), key, `${key} must be translated for ${language.code}`)
  }
}
assert.ok(sessions.includes("t('task.new')"), 'the task actions must be translated too')

assert.ok(sessions.includes('const TASK_LAUNCH_ENABLED = false'), 'the task action ships hidden until tasks are ready')
assert.equal(
  (sessions.match(/TASK_LAUNCH_ENABLED &&/g) ?? []).length,
  4,
  'both task buttons and the enabled state must read the same flag'
)
assert.equal(sessions.includes('taskCopy'), false, 'there must be one translation table, not two')

assert.ok(dialog.includes('className="task-context"'), 'machine and agent belong to the same context strip')
assert.equal(/<select[^>]*value=\{agentId\}/.test(dialog), false, 'the agent must not be offered as a one-option select')

assert.ok(styles.includes('.task-launch-form'), 'task styles belong in the shared stylesheet')
assert.equal(styles.includes('.sessions-header-actions > button:nth-child('), false, 'header actions must not be styled by position')
assert.ok(styles.includes('.sessions-action-compact'), 'the action that collapses on narrow screens must say so by class')
assert.ok(styles.includes('.sessions-action-label-short'), 'the narrow layout needs a label of its own, not a truncated one')

for (const key of ['sessions.newShort', 'task.newShort']) {
  assert.ok(sessions.includes(`t('${key}')`), `the narrow header must use ${key}`)
  for (const language of languageOptions) {
    assert.notEqual(createTranslator(language.code)(key), key, `${key} must be translated for ${language.code}`)
  }
}
assert.equal(
  (sessions.match(/sessions-action-label-short/g) ?? []).length,
  2,
  'both creation actions need a short label; the compact action drops its label entirely'
)

// Model choice is machine/agent-level state. Machine/project discovery renders the usable dialog
// first; model refresh runs separately with a hard client deadline so a slow provider cannot freeze
// New Task. PI's daemon-side implementation is native RPC and creates no ACP catalog session.
assert.ok(dialog.includes("t('task.model')"), 'the task dialog must offer a model')
assert.ok(dialog.includes('type ModelState = "idle" | "loading" | "fresh" | "stale" | "unavailable"'), 'model freshness must be explicit')
assert.ok(dialog.includes('setTaskConfig(connection.config)'), 'the form must become usable after machine/project discovery')
assert.ok(dialog.indexOf('setTaskConfig(connection.config)') < dialog.indexOf('await refreshModels(connection.config, active.id'), 'model refresh must happen after the base form is populated')
assert.ok(dialog.includes('taskClient.listAgentModels(targetConfig, agentId)'), 'New Task must refresh the agent-level model catalog')
assert.ok(dialog.includes('modelState === "stale"'), 'a cached fallback must be visibly distinguishable from a fresh catalog')
assert.ok(dialog.includes('modelState === "unavailable"'), 'model failure must be visible without replacing the whole dialog')
assert.ok(dialog.includes('await taskClient.launch(taskConfig, task.id)'), 'launch remains the final model validation boundary')
assert.ok(client.includes('MODEL_REFRESH_TIMEOUT_MS = 5_000'), 'model refresh must use a short explicit client deadline')
assert.ok(client.includes('/models`'), 'the task client must expose the agent model endpoint')
assert.ok(client.includes('model?: ModelSelection'), 'the task client must carry the selection to the daemon')

assert.ok(dialog.includes('discoverMachineConnection(config)'), 'the Task dialog must resolve the machine endpoint separately from the session endpoint')
assert.ok(dialog.includes('taskClient.listProjects(connection.config)'), 'project discovery must use the resolved daemon endpoint')
assert.ok(dialog.includes('taskClient.createTask(taskConfig'), 'task creation must stay on the resolved daemon endpoint')

assert.ok(client.includes('unwrapPayload'), 'native task payload parsing must reuse the shared unwrapping rules')
assert.ok(client.includes('Make sure this profile can reach the Harness machine daemon'), 'invalid machine payloads should explain the endpoint problem instead of blaming JSON formatting')
assert.equal(
  (client.match(/unauthorizedDetail\(config\)/g) ?? []).length,
  3,
  'desktop, native and browser must all distinguish a rejected password from one that was never sent'
)
assert.equal(client.includes('await response.json() as T'), false, 'the browser transport must normalize like the other two')

assert.ok(dialog.includes('<div className="wizard-footer">'), 'Task actions should use the same shared wizard footer as New Session')
assert.equal(/style=\{\{/.test(dialog), false, 'the dialog must not override the design system with inline styles')
assert.ok(dialog.includes('onClick={starting ? undefined : onClose}'), 'the dialog must not disappear while launch is still working')

console.log('task client regression tests passed')
