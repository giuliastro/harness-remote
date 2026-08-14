import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTranslator, languageOptions } from './i18n.ts'

const client = readFileSync(new URL('./taskClient.ts', import.meta.url), 'utf8')
const dialog = readFileSync(new URL('./components/task-launch-dialog.tsx', import.meta.url), 'utf8')
const sessions = readFileSync(new URL('./components/session-list.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

// Every key the task surfaces ask for has to exist in every language the app offers. A second
// translation table shipped alongside `i18n.ts` diverged from it immediately — it normalized
// `zh-Hans` differently, so a device set to Simplified Chinese got the app translated and this
// dialog in English. One table, checked here against every locale, is what prevents that.
const keys = [...new Set([...dialog.matchAll(/t\('(task\.[a-zA-Z.]+)'/g)].map((match) => match[1]))]
assert.ok(keys.length >= 12, 'the task dialog must take its strings from the shared translator')
for (const language of languageOptions) {
  const translate = createTranslator(language.code)
  for (const key of keys) {
    assert.notEqual(translate(key), key, `${key} must be translated for ${language.code}`)
  }
}
assert.ok(sessions.includes("t('task.new')"), 'the task actions must be translated too')

// The task path is built and hidden: it stays out of the way until a task is at least as capable
// as the session it wraps. Promoting the weaker of two paths is how a feature gets judged before
// it is ready, so both creation actions must be behind the same flag and New Session must keep its
// primacy while it is off.
assert.ok(sessions.includes('const TASK_LAUNCH_ENABLED = false'), 'the task action ships hidden until tasks are ready')
assert.equal(
  (sessions.match(/TASK_LAUNCH_ENABLED &&/g) ?? []).length,
  4,
  'both task buttons and the enabled state must read the same flag'
)
assert.equal(sessions.includes('taskCopy'), false, 'there must be one translation table, not two')

// Machine and agent are fixed by the active profile. A select holding a single option advertises a
// choice the user does not have; both are stated instead, next to each other.
assert.ok(dialog.includes('className="task-context"'), 'machine and agent belong to the same context strip')
assert.equal(/<select[^>]*value=\{agentId\}/.test(dialog), false, 'the agent must not be offered as a one-option select')

// Task styling belongs to the same stylesheet as everything else, and must respond to width by
// class rather than by DOM position: adding or reordering a header button must not silently
// restyle a different one.
assert.ok(styles.includes('.task-launch-form'), 'task styles belong in the shared stylesheet')
assert.equal(styles.includes('.sessions-header-actions > button:nth-child('), false, 'header actions must not be styled by position')
assert.ok(styles.includes('.sessions-action-compact'), 'the action that collapses on narrow screens must say so by class')
assert.ok(styles.includes('.sessions-action-label-short'), 'the narrow layout needs a label of its own, not a truncated one')

// Buttons are `white-space: nowrap`, so a label that does not fit overflows the button instead of
// wrapping: `New Session` fits a phone header, `Nuova sessione` does not. Both creation actions
// carry a short label, and every language has to supply one.
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

// A task started on the wrong model is a task that has to be thrown away, so the choice belongs
// where the task is created — offered only when the agent has models to offer, since ACP harnesses
// have no listing and would otherwise show an empty control.
assert.ok(dialog.includes("t('task.model')"), 'the task dialog must offer a model')
assert.ok(dialog.includes('models.length > 0 &&'), 'the model field must be absent when the agent has no models to list')
assert.ok(dialog.includes("t('task.modelDefault')"), 'leaving the agent default must stay an explicit choice')
assert.ok(dialog.includes('.catch(() => [] as ModelOption[])'), 'an agent without a model listing must not break the dialog')
assert.ok(client.includes('model?: ModelSelection'), 'the task client must carry the selection to the daemon')

// The endpoint serving sessions is often not the one serving the task APIs.
assert.ok(dialog.includes('discoverMachineConnection(config)'), 'the Task dialog must resolve the machine endpoint separately from the session endpoint')
assert.ok(dialog.includes('taskClient.listProjects(connection.config)'), 'project discovery must use the resolved daemon endpoint')
assert.ok(dialog.includes('taskClient.createTask(taskConfig'), 'task creation must stay on the resolved daemon endpoint')

// Android hands back shapes the browser never produces. All three transports normalize the same way
// and name the same failures, so one endpoint cannot answer in three different ways.
assert.ok(client.includes('unwrapPayload'), 'native task payload parsing must reuse the shared unwrapping rules')
assert.ok(client.includes('Make sure this profile can reach the Harness machine daemon'), 'invalid machine payloads should explain the endpoint problem instead of blaming JSON formatting')
assert.equal(
  (client.match(/unauthorizedDetail\(config\)/g) ?? []).length,
  3,
  'desktop, native and browser must all distinguish a rejected password from one that was never sent'
)
assert.equal(client.includes('await response.json() as T'), false, 'the browser transport must normalize like the other two')

// Shared layout, no one-off sizing.
assert.ok(dialog.includes('<div className="wizard-footer">'), 'Task actions should use the same shared wizard footer as New Session')
assert.equal(/style=\{\{/.test(dialog), false, 'the dialog must not override the design system with inline styles')

console.log('task client regression tests passed')
