import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const desktopBridge = readFileSync(new URL('./desktopBridge.ts', import.meta.url), 'utf8')
const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')

assert.match(desktopBridge, /window\.harnessDesktop/, 'Electron detection must use preload marker')
assert.match(main, /!window\.harnessDesktop\?\.platform\.isDesktop/, 'Electron must skip service-worker registration')
assert.match(app, /isAndroidPlatform\(Capacitor\.getPlatform\(\)\)/, 'Android back listener must be Android-only')
assert.match(app, /createDesktopOpenCodeEventSubscription/, 'Electron must select desktop event transport')
assert.match(api, /if \(isDesktopPlatform\(\)\)/, 'Electron must select desktop request transport before browser/native paths')
assert.match(api, /desktopRequest\(config,/, 'Desktop request must resolve profile only after synchronization finishes')
assert.doesNotMatch(api, /desktopProfileID\(config\)/, 'API must not resolve an unacknowledged desktop profile before waiting for synchronization')
assert.match(desktopBridge, /profileId: string/, 'Desktop stream adapter must accept profile ID, not URL')
assert.match(api, /function normalizeNativeResponseData\(data: unknown\): unknown/, 'Native transport must normalize stringified JSON payloads')
assert.match(api, /return JSON\.parse\(trimmed\)/, 'Native JSON normalizer must parse JSON-looking strings')
assert.match(api, /normalizeNativeResponseData\(response\.data\) as T/, 'Capacitor responses must use native JSON normalization before reaching API callers')

console.log('platform selection regression tests passed')
