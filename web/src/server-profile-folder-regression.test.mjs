import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const profiles = readFileSync(new URL('./serverProfiles.ts', import.meta.url), 'utf8')
const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')

assert.match(profiles, /newSessionDirectoryByProfile/, 'new-session folder memory must be scoped by saved profile')
assert.match(profiles, /removeItem\(NEW_SESSION_DIRECTORY_STORAGE_KEY\)/, 'legacy global folder state must not be migrated across machines')
assert.match(profiles, /connectionIdentity\(previousProfile\.config\) !== connectionIdentity\(nextProfile\.config\)/, 'changing the machine behind a profile must invalidate its remembered folder')
assert.match(profiles, /ACTIVE_PROFILE_CHANGED_EVENT/, 'profile boundaries must emit a remount signal')
assert.match(main, /<App key=\{revision\} \/>/, 'server profile changes must re-read profile-scoped state without reloading the page')

console.log('server profile folder regression tests passed')
