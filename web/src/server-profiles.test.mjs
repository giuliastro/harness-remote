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
storage.set('opencode.remote.server.opencode2', JSON.stringify({ backend: 'opencode2', host: 'v2.local', port: 4097, username: 'harness', password: 'secret', agentId: 'opencode2' }))
storage.set('opencode.remote.server.omp', JSON.stringify({ backend: 'omp', host: 'pi.local', port: 4097, username: 'omp', password: 'secret' }))
storage.set('opencode.remote.server.copilot', JSON.stringify({ backend: 'copilot', host: 'copilot.local', port: 4097, username: 'harness', password: 'secret', agentId: 'copilot' }))
storage.set('opencode.remote.server.mimo', JSON.stringify({ backend: 'mimo', host: 'mimo.local', port: 4097, username: 'harness', password: 'secret', agentId: 'mimo' }))

const migrated = loadServerProfiles()
assert.equal(migrated.length, 5, 'each backend configuration should migrate to its own saved server')
assert.deepEqual(migrated.map((profile) => profile.config.backend), ['opencode', 'opencode2', 'omp', 'copilot', 'mimo'])
assert.equal(migrated[0].name, 'OpenCode Legacy server')
assert.equal(migrated[1].name, 'OpenCode 2 server 2')

const added = createServerProfile('Work PI', 'pi')
const profiles = [...migrated, added]
persistServerProfiles(profiles, added.id)
assert.equal(JSON.parse(storage.get(SERVER_PROFILES_STORAGE_KEY)).length, 6, 'saved profiles should persist as one collection')
assert.equal(storage.get(ACTIVE_PROFILE_STORAGE_KEY), added.id, 'the selected server should persist independently')
assert.equal(loadActiveServerProfile(loadServerProfiles()).name, 'Work PI', 'the saved selection should be restored at launch')
const restoredOpenCodeProfiles = loadServerProfiles().filter((profile) => profile.config.backend.startsWith('opencode'))
assert.deepEqual(restoredOpenCodeProfiles.map((profile) => profile.config.backend), ['opencode', 'opencode2'], 'legacy OpenCode and OpenCode 2 must round-trip with separate backend ids')
assert.equal(restoredOpenCodeProfiles[1].config.agentId, 'opencode2', 'OpenCode 2 agent routing must persist')
for (const backend of ['copilot', 'mimo']) {
  const profile = loadServerProfiles().find((candidate) => candidate.config.backend === backend)
  assert.ok(profile, `${backend} must persist as an independent profile`)
  assert.equal(profile.config.agentId, backend, `${backend} agent routing must persist without fallback`)
}

// An upgrade can have a new collection created before all older backend-specific keys are migrated.
// Loading must retain that OMP entry instead of letting a reload overwrite its only representation.
storage.clear()
const collectionProfile = {
  id: 'collection-opencode',
  name: 'Current OpenCode',
  config: { backend: 'opencode', host: 'desktop.local', port: 4096, username: 'opencode', password: '' }
}
storage.set(SERVER_PROFILES_STORAGE_KEY, JSON.stringify([collectionProfile]))
storage.set('opencode.remote.server.omp', JSON.stringify({ backend: 'omp', host: 'pi.local', port: 4097, username: 'omp', password: 'secret' }))
const mergedMigration = loadServerProfiles()
assert.deepEqual(mergedMigration.map((profile) => profile.config.backend), ['opencode', 'omp'], 'a legacy OMP profile must survive alongside the saved profile collection')

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

storage.set(SERVER_PROFILES_STORAGE_KEY, JSON.stringify([{
  id: 'old-pi-wizard-profile',
  name: 'PI test machine',
  config: { backend: 'codex', host: 'workstation.local', port: 4097, username: 'harness', password: 'secret', agentId: 'codex' }
}]))
const repaired = loadServerProfiles()[0]
assert.equal(repaired.config.backend, 'pi', 'an unmistakably named PI profile saved by the old fallback must recover PI')
assert.equal(repaired.config.agentId, 'pi', 'the repaired PI profile must target the PI daemon route')

storage.set(SERVER_PROFILES_STORAGE_KEY, JSON.stringify([
  { id: 'known-daemon-profile', name: 'Codex CLI server', config: { backend: 'codex', host: 'localhost', port: 5001, username: 'harness', password: 'secret', agentId: 'codex' } },
  { id: 'old-omp-internal-port-profile', name: 'Oh My Pi TEST', config: { backend: 'omp', host: 'localhost', port: 4096, username: 'harness', password: 'secret' } }
]))
const repairedPort = loadServerProfiles().find((profile) => profile.id === 'old-omp-internal-port-profile')
assert.ok(repairedPort, 'the OMP profile should be retained')
assert.equal(repairedPort.config.port, 5001, 'a named local OMP profile must reuse the known daemon port instead of assuming 4097')
assert.equal(repairedPort.config.agentId, 'omp', 'a repaired OMP daemon profile must use the OMP route')

storage.set(SERVER_PROFILES_STORAGE_KEY, JSON.stringify([{
  id: 'unknown-daemon-port-profile',
  name: 'Oh My Pi TEST',
  config: { backend: 'omp', host: 'localhost', port: 4096, username: 'harness', password: 'secret' }
}]))
const unknownPort = loadServerProfiles()[0]
assert.equal(unknownPort.config.port, 4096, 'a profile with no known machine daemon port must not be guessed')
assert.equal(unknownPort.config.agentId, undefined, 'an unknown daemon port must not fabricate an agent route')

const storageKeys = readFileSync(new URL('./storageKeys.ts', import.meta.url), 'utf8')
assert.match(storageKeys, /SERVER_PROFILES_STORAGE_KEY/, 'the crash-recovery reset must clear saved servers')
assert.match(storageKeys, /ACTIVE_PROFILE_STORAGE_KEY/, 'the crash-recovery reset must clear the selected server')
assert.ok(!/"opencode\.remote\.(serverProfiles|activeServerProfile)"/.test(storageKeys), 'storage keys must have a single definition')

console.log('server profile tests passed')
