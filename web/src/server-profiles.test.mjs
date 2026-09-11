import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const storage = new Map()
globalThis.localStorage = {
  getItem(key) { return storage.get(key) ?? null },
  setItem(key, value) { storage.set(key, String(value)) },
  removeItem(key) { storage.delete(key) },
  clear() { storage.clear() }
}

const {
  WORKSPACE_MACHINES_STORAGE_KEY,
  createWorkspaceMachine,
  loadWorkspaceMachines,
  persistWorkspaceMachines
} = await import('./workspaceMachines.ts')

const initial = loadWorkspaceMachines()
assert.deepEqual(initial, [], 'initial workspace machines must be empty')

const machine = createWorkspaceMachine()
assert.equal(machine.config.port, 4097)
assert.equal(machine.config.username, 'harness')

machine.name = 'Primary Workstation'
machine.config.host = '192.168.1.50'
persistWorkspaceMachines([machine])

const loaded = loadWorkspaceMachines()
assert.equal(loaded.length, 1)
assert.equal(loaded[0].name, 'Primary Workstation')
assert.equal(loaded[0].config.host, '192.168.1.50')

const storageKeys = readFileSync(new URL('./storageKeys.ts', import.meta.url), 'utf8')
assert.match(storageKeys, /WORKSPACE_MACHINES_STORAGE_KEY/, 'the crash-recovery reset must clear workspace machines')
assert.doesNotMatch(storageKeys, /SERVER_PROFILES_STORAGE_KEY/, 'retired server profile storage keys must not remain')

console.log('workspace machine and storage key tests passed')
