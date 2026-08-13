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
  ACTIVE_PROFILE_STORAGE_KEY,
  SERVER_PROFILES_STORAGE_KEY,
  createServerProfile,
  loadActiveServerProfile,
  loadServerProfiles,
  persistServerProfiles
} = await import('./serverProfiles.ts')

storage.set('opencode.remote.server.opencode', JSON.stringify({ backend: 'opencode', host: 'desktop.local', port: 4096, username: 'opencode', password: '' }))
storage.set('opencode.remote.server.omp', JSON.stringify({ backend: 'omp', host: 'pi.local', port: 4097, username: 'omp', password: 'secret' }))

const migrated = loadServerProfiles()
assert.equal(migrated.length, 2, 'each legacy backend configuration should migrate to its own saved server')
assert.deepEqual(migrated.map((profile) => profile.config.backend), ['opencode', 'omp'])

const added = createServerProfile('Work PI', 'pi')
const profiles = [...migrated, added]
persistServerProfiles(profiles, added.id)
assert.equal(JSON.parse(storage.get(SERVER_PROFILES_STORAGE_KEY)).length, 3, 'saved profiles should persist as one collection')
assert.equal(storage.get(ACTIVE_PROFILE_STORAGE_KEY), added.id, 'the selected server should persist independently')
assert.equal(loadActiveServerProfile(loadServerProfiles()).name, 'Work PI', 'the saved selection should be restored at launch')

const daemonProfile = {
  id: 'machine-profile',
  name: 'Workstation',
  config: { backend: 'opencode', host: 'workstation.local', port: 4097, username: 'harness', password: 'secret', agentId: 'opencode' }
}
persistServerProfiles([daemonProfile], daemonProfile.id)
const restoredDaemon = loadActiveServerProfile(loadServerProfiles())
assert.equal(restoredDaemon.config.agentId, 'opencode', 'machine agent selection should survive restart')

const malformed = JSON.parse(storage.get(SERVER_PROFILES_STORAGE_KEY))
malformed[0].config.agentId = { invalid: true }
storage.set(SERVER_PROFILES_STORAGE_KEY, JSON.stringify(malformed))
assert.equal(loadServerProfiles()[0].config.agentId, undefined, 'malformed agent ids must not leak from persisted data')

const storageKeys = readFileSync(new URL('./storageKeys.ts', import.meta.url), 'utf8')
assert.match(storageKeys, /SERVER_PROFILES_STORAGE_KEY/, 'the crash-recovery reset must clear saved servers')
assert.match(storageKeys, /ACTIVE_PROFILE_STORAGE_KEY/, 'the crash-recovery reset must clear the selected server')
assert.ok(!/"opencode\.remote\.(serverProfiles|activeServerProfile)"/.test(storageKeys), 'storage keys must have a single definition')

console.log('server profile tests passed')
