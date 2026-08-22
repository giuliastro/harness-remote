import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const desktopBridge = readFileSync(new URL('./desktopBridge.ts', import.meta.url), 'utf8')
const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
const machineClient = readFileSync(new URL('./machineClient.ts', import.meta.url), 'utf8')

assert.match(desktopBridge, /window\.harnessDesktop/, 'Electron detection must use preload marker')
assert.match(main, /!window\.harnessDesktop\?\.platform\.isDesktop/, 'Electron must skip service-worker registration')
assert.match(app, /isAndroidPlatform\(Capacitor\.getPlatform\(\)\)/, 'Android back listener must be Android-only')
assert.match(app, /createDesktopOpenCodeEventSubscription/, 'Electron must select desktop event transport')
assert.match(api, /if \(isDesktopPlatform\(\)\)/, 'Electron must select desktop request transport before browser/native paths')
assert.match(api, /desktopRequest\(config,/, 'Desktop request must resolve profile only after synchronization finishes')
assert.doesNotMatch(api, /desktopProfileID\(config\)/, 'API must not resolve an unacknowledged desktop profile before waiting for synchronization')
assert.match(desktopBridge, /profileId: string/, 'Desktop stream adapter must accept profile ID, not URL')
// What this suite is about is transport selection, so it checks that the native branch is the one
// wired to the normalizer. The rule the normalizer implements is exercised for real in
// native-response.test.mjs rather than asserted against the text of its own source.
assert.match(api, /from "\.\/nativeResponse"/, 'Native normalization must come from the module that is unit tested')
assert.match(api, /normalizeNativeResponseData\(response\.data\) as T/, 'Capacitor responses must use native JSON normalization before reaching API callers')
assert.match(machineClient, /if \(typeof parsed === "string"\)/, 'native machine discovery must accept a JSON string payload')
assert.match(machineClient, /parsed = JSON\.parse\(parsed\)/, 'stringified machine discovery payloads must be decoded')
assert.match(machineClient, /remember\(config, machineSnapshot\(response\.data\)\)/, 'Capacitor machine discovery must validate the native response before caching the last-known healthy snapshot')
assert.match(machineClient, /DISCOVERY_STALE_GRACE_MS = 45_000/, 'machine discovery should retain a short last-known-good grace window for transient mobile transport drops')

console.log('platform selection regression tests passed')
