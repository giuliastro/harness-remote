import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { streamURL } from './opencode-events.ts'
import { agentScopedPath, authHeader, baseUrl, hasCredentials, isValidServerConfig, machineBaseUrl, normalizeServerHost } from './serverConfig.ts'

const config = (host, port = 4096) => ({ backend: 'opencode', host, port, username: 'opencode', password: 'secret' })

for (const host of ['http:', 'http://', 'https:', 'https://', '', '   ']) {
  assert.equal(isValidServerConfig(config(host)), false, `half-typed host ${JSON.stringify(host)} must be rejected`)
}
for (const host of ['Giulio-S7', 'localhost', '192.168.1.64', 'http://192.168.1.64', 'https://example.com', 'http://192', 'HTTP://LOCALHOST/']) {
  assert.equal(isValidServerConfig(config(host)), true, `usable host ${JSON.stringify(host)} must be accepted`)
}
assert.equal(isValidServerConfig(config('localhost', 0)), false)
assert.equal(isValidServerConfig(config('localhost', 70000)), false)
assert.equal(isValidServerConfig(config('localhost', Number.NaN)), false)
assert.equal(isValidServerConfig(config('example.com/path')), false)
assert.equal(isValidServerConfig(config('example.com:4097')), false)
assert.equal(normalizeServerHost(' LOCALHOST '), 'localhost')
assert.equal(normalizeServerHost('HTTP://LOCALHOST/'), 'http://localhost')
assert.equal(normalizeServerHost('192.168.1.64'), '192.168.1.64')
assert.equal(baseUrl(config('192.168.1.64')), 'http://192.168.1.64:4096')
assert.equal(baseUrl(config('https://example.com')), 'https://example.com:4096')

const daemon = { ...config('192.168.1.64', 4097), backend: 'codex', agentId: 'opencode' }
assert.equal(machineBaseUrl(daemon), 'http://192.168.1.64:4097')
assert.equal(baseUrl(daemon), 'http://192.168.1.64:4097/v1/agents/opencode')
assert.equal(agentScopedPath(daemon, '/session'), '/v1/agents/opencode/session')
assert.equal(agentScopedPath({ ...daemon, agentId: undefined }, '/session'), '/session')
assert.equal(streamURL(baseUrl(daemon), 'global'), 'http://192.168.1.64:4097/v1/agents/opencode/global/event')
assert.equal(baseUrl({ ...daemon, agentId: 'claude/code' }), 'http://192.168.1.64:4097/v1/agents/claude%2Fcode')

const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
const standalone = readFileSync(new URL('./components/standalone-universal-workspace.tsx', import.meta.url), 'utf8')
assert.match(main, /<ErrorBoundary resetKeys=\{SERVER_STORAGE_KEYS\}>/)
assert.match(main, /loadWorkspaceMachines/)
assert.match(main, /<StandaloneUniversalWorkspace/)
assert.doesNotMatch(main, /loadServerProfiles/)
assert.match(standalone, /discoverMachine\(nextMachine\(\)\.config\)/)
assert.match(standalone, /Number\(port\) >= 1 && Number\(port\) <= 65_535/)

const boundary = readFileSync(new URL('./ErrorBoundary.tsx', import.meta.url), 'utf8')
assert.match(boundary, /localStorage\.removeItem\(key\)/)

const creds = (username, password) => ({ backend: 'opencode', host: 'localhost', port: 4096, username, password })
assert.equal(authHeader(creds('opencode', 'secret')), 'Basic b3BlbmNvZGU6c2VjcmV0')
assert.equal(authHeader(creds(' opencode ', ' secret ')), authHeader(creds('opencode', 'secret')))
assert.equal(authHeader(creds('opencode', 'pàssword')), 'Basic b3BlbmNvZGU6cMOgc3N3b3Jk')
assert.doesNotThrow(() => authHeader(creds('opencode', 'påsswörd☂')))
assert.equal(hasCredentials(creds('', '')), false)
assert.equal(hasCredentials(creds('opencode', '')), false)
assert.equal(hasCredentials(creds('', 'secret')), false)
assert.equal(hasCredentials(creds('opencode', 'secret')), true)

console.log('server config regression tests passed')
