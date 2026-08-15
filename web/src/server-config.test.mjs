import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { streamURL } from './opencode-events.ts'
import { baseUrl, isValidServerConfig } from './serverConfig.ts'

const config = (host, port = 4096) => ({ backend: 'opencode', host, port, username: 'opencode', password: 'secret' })

// Regression: typing `http://192.168.1.64` passes through `http:` and `http://`, both of
// which produced an unparseable base URL. streamURL threw inside a render effect, React
// unmounted the tree, and the already-persisted host reproduced the blank screen on every
// launch until the app data was cleared.
const partialHosts = ['http:', 'http://', 'https:', 'https://', '', '   ']
for (const host of partialHosts) {
  assert.equal(isValidServerConfig(config(host)), false, `half-typed host ${JSON.stringify(host)} must be rejected`)
}

for (const host of ['Giulio-S7', 'localhost', '192.168.1.64', 'http://192.168.1.64', 'https://example.com', 'http://192']) {
  assert.equal(isValidServerConfig(config(host)), true, `usable host ${JSON.stringify(host)} must be accepted`)
}

assert.equal(isValidServerConfig(config('localhost', 0)), false, 'port 0 must be rejected')
assert.equal(isValidServerConfig(config('localhost', 70000)), false, 'out-of-range port must be rejected')
assert.equal(isValidServerConfig(config('localhost', Number.NaN)), false, 'a cleared port field must be rejected')

assert.equal(baseUrl(config('192.168.1.64')), 'http://192.168.1.64:4096', 'a bare host defaults to http')
assert.equal(baseUrl(config('https://example.com')), 'https://example.com:4096', 'an explicit scheme is preserved')

// Every accepted configuration must survive the URL building that previously crashed.
for (const host of ['Giulio-S7', 'http://192.168.1.64', 'https://example.com']) {
  assert.doesNotThrow(() => streamURL(baseUrl(config(host)), 'global'), `streamURL must not throw for ${host}`)
}

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
assert.equal(
  app.includes('isMixedContentBlocked'),
  false,
  'settings must not warn that a plain-http server requires HTTPS'
)
assert.match(
  app,
  /if \(draftConfig\.host\.trim\(\) && !isValidServerConfig\(draftConfig\)\) return/,
  'automatic saving must refuse a half-typed configuration instead of persisting a crash'
)
assert.equal(
  app.includes('if (!config.host || config.port <= 0)'),
  false,
  'connection guards must use the shared validity check, not a truthiness test'
)
assert.match(app, /const hasConfiguredServer = isValidServerConfig\(config\)/, 'navigation must gate on a usable configuration')

const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
assert.match(main, /<ErrorBoundary resetKeys=\{SERVER_STORAGE_KEYS\}>/, 'a crash must render recoverable UI instead of an empty root')

const boundary = readFileSync(new URL('./ErrorBoundary.tsx', import.meta.url), 'utf8')
assert.match(boundary, /localStorage\.removeItem\(key\)/, 'recovery must clear the saved server configuration')

console.log('server config regression tests passed')
