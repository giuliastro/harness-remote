import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const desktopBridge = readFileSync(new URL('./desktopBridge.ts', import.meta.url), 'utf8')
const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
const machineClient = readFileSync(new URL('./machineClient.ts', import.meta.url), 'utf8')
const liveRefresh = readFileSync(new URL('./taskdesk-session-live-refresh.ts', import.meta.url), 'utf8')

assert.match(desktopBridge, /window\.harnessDesktop/, 'Electron detection must use preload marker')
assert.match(main, /!window\.harnessDesktop\?\.platform\.isDesktop/, 'Electron must skip service-worker registration')
assert.match(liveRefresh, /Capacitor\.getPlatform\(\) === "android"/, 'Android lifecycle listener must be Android-only')
assert.match(api, /if \(isDesktopPlatform\(\)\)/, 'Electron must select desktop request transport before browser/native paths')
assert.match(api, /desktopRequest\(config,/, 'Desktop request must resolve profile only after synchronization finishes')
assert.match(main, /syncDesktopProfiles\(machines\)/, 'Session-first desktop bootstrap must synchronize WorkspaceMachine profiles before discovery')
assert.match(main, /if \(!desktopReady\)/, 'Session-first workspace must stay gated until Electron acknowledges the profile snapshot')
assert.doesNotMatch(api, /desktopProfileID\(config\)/, 'API must not resolve an unacknowledged desktop profile before waiting for synchronization')
assert.match(desktopBridge, /config: ServerConfig/, 'Desktop stream adapter must resolve the approved machine from config')
assert.match(desktopBridge, /const profileId = desktopProfileID\(options\.config\)/, 'Desktop streams must not trust synthetic renderer profile IDs')
assert.match(api, /from "\.\/nativeResponse"/, 'Native normalization must come from the module that is unit tested')
assert.match(api, /normalizeNativeResponseData\(response\.data\) as T/, 'Capacitor responses must use native JSON normalization before reaching API callers')
assert.match(machineClient, /function parseJSONValue\(value: unknown, label: string\)/, 'machine-scoped payloads must share one JSON-string normalizer')
assert.match(machineClient, /if \(typeof value !== "string"\) return value/, 'native machine discovery must accept already-decoded payloads')
assert.match(machineClient, /JSON\.parse\(value\)/, 'stringified machine discovery payloads must be decoded')
assert.match(machineClient, /remember\(config, machineSnapshot\(response\.data\)\)/, 'Capacitor machine discovery must validate the native response before caching the last-known healthy snapshot')
assert.match(machineClient, /DISCOVERY_STALE_GRACE_MS = 45_000/, 'machine discovery should retain a short last-known-good grace window for transient mobile transport drops')

console.log('platform selection regression tests passed')
