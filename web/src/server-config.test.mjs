import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { streamURL } from './opencode-events.ts'
import { agentScopedPath, authHeader, baseUrl, hasCredentials, isValidServerConfig, machineBaseUrl } from './serverConfig.ts'

const config = (host, port = 4096) => ({ backend: 'opencode', host, port, username: 'opencode', password: 'secret' })

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

const daemon = { ...config('192.168.1.64', 4097), backend: 'codex', agentId: 'opencode' }
assert.equal(machineBaseUrl(daemon), 'http://192.168.1.64:4097', 'machine discovery must stay above agent routing')
assert.equal(baseUrl(daemon), 'http://192.168.1.64:4097/v1/agents/opencode', 'selected agents live below one machine address')
assert.equal(agentScopedPath(daemon, '/session'), '/v1/agents/opencode/session', 'direct path routing must use the selected agent')
assert.equal(agentScopedPath({ ...daemon, agentId: undefined }, '/session'), '/session', 'legacy profiles keep their old paths')
assert.equal(
  streamURL(baseUrl(daemon), 'global'),
  'http://192.168.1.64:4097/v1/agents/opencode/global/event',
  'event streams must keep the selected agent prefix'
)
assert.equal(
  baseUrl({ ...daemon, agentId: 'claude/code' }),
  'http://192.168.1.64:4097/v1/agents/claude%2Fcode',
  'agent ids must be URL encoded rather than interpolated as paths'
)

for (const host of ['Giulio-S7', 'http://192.168.1.64', 'https://example.com']) {
  assert.doesNotThrow(() => streamURL(baseUrl(config(host)), 'global'), `streamURL must not throw for ${host}`)
}

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
assert.equal(app.includes('isMixedContentBlocked'), false, 'settings must not warn that a plain-http server requires HTTPS')
assert.match(app, /if \(draftConfig\.host\.trim\(\) && !isValidServerConfig\(draftConfig\)\) return/, 'automatic saving must refuse a half-typed configuration instead of persisting a crash')
assert.equal(app.includes('if (!config.host || config.port <= 0)'), false, 'connection guards must use the shared validity check, not a truthiness test')
assert.match(app, /const hasConfiguredServer = isValidServerConfig\(config\)/, 'navigation must gate on a usable configuration')

const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
assert.match(main, /<ErrorBoundary resetKeys=\{SERVER_STORAGE_KEYS\}>/, 'a crash must render recoverable UI instead of an empty root')

const boundary = readFileSync(new URL('./ErrorBoundary.tsx', import.meta.url), 'utf8')
assert.match(boundary, /localStorage\.removeItem\(key\)/, 'recovery must clear the saved server configuration')

const creds = (username, password) => ({ backend: 'opencode', host: 'localhost', port: 4096, username, password })

assert.equal(authHeader(creds('opencode', 'secret')), 'Basic b3BlbmNvZGU6c2VjcmV0', 'the ordinary case must still produce the standard header')
assert.equal(authHeader(creds(' opencode ', ' secret ')), authHeader(creds('opencode', 'secret')), 'surrounding whitespace must not change the credentials sent')
assert.equal(authHeader(creds('opencode', 'pàssword')), 'Basic b3BlbmNvZGU6cMOgc3N3b3Jk', 'credentials must be encoded as UTF-8 before base64')
assert.notEqual(authHeader(creds('opencode', 'pàssword')), 'Basic b3BlbmNvZGU6cOBzc3dvcmQ=', 'the Latin-1 encoding btoa produces on its own must not be what goes on the wire')
assert.doesNotThrow(() => authHeader(creds('opencode', 'påsswörd☂')), 'a character above U+00FF must not throw')
assert.equal(hasCredentials(creds('opencode', 'secret')), true, 'a complete pair must count as credentials')
assert.equal(hasCredentials(creds('opencode', '')), false, 'a missing password must not be sent as an empty one')
assert.equal(hasCredentials(creds('opencode', '   ')), false, 'a password of only spaces is an empty one')
assert.equal(hasCredentials(creds('', 'secret')), false, 'a password without a username cannot form a header')

const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
assert.ok(api.includes('function unauthorizedDetail(') && api.includes('and none were sent.'), 'a 401 must say whether credentials were sent at all, not just that the request was unauthorized')
assert.equal(api.includes('config.username && config.password'), false, 'credential checks must go through the shared helper, so an untrimmed field cannot pass one check and fail another')

console.log('server config regression tests passed')
