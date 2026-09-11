import assert from 'node:assert/strict'
import { probeNativeSessionContinuation } from './native-session-continuation.ts'
import './cross-machine-continuation.test.mjs'
import './cross-machine-route-projects.test.mjs'

function target(overrides = {}) {
  return {
    key: 'machine:codex:s1',
    machineID: 'machine',
    agentID: 'codex',
    agentLabel: 'Codex CLI',
    backend: 'codex',
    transport: 'acp',
    sessionID: 's1',
    directory: '/repo',
    title: 'Session',
    external: false,
    requiresExplicitClaim: true,
    canStop: true,
    config: {
      backend: 'codex',
      host: '127.0.0.1',
      port: 4099,
      username: 'harness',
      password: 'testpw',
      agentId: 'codex'
    },
    ...overrides
  }
}

let claims = 0
const successfulClaim = {
  async claimSession(config, directory, sessionID) {
    claims += 1
    assert.equal(config.agentId, 'codex')
    assert.equal(directory, '/repo')
    assert.equal(sessionID, 's1')
  }
}

const missingExternalMetadata = await probeNativeSessionContinuation(target({ external: false }), successfulClaim)
assert.deepEqual(missingExternalMetadata, { writable: true })
assert.equal(claims, 1, 'ACP continuation must claim when requiresExplicitClaim is true even if external metadata is missing')

claims = 0
const knownExternal = await probeNativeSessionContinuation(target({ external: true }), successfulClaim)
assert.deepEqual(knownExternal, { writable: true })
assert.equal(claims, 1, 'known external ACP Session must cross the claim boundary exactly once')

claims = 0
const alreadyOwned = await probeNativeSessionContinuation(target({ requiresExplicitClaim: false, external: false }), successfulClaim)
assert.deepEqual(alreadyOwned, { writable: true })
assert.equal(claims, 0, 'a target whose ownership is already proven must not perform a redundant claim')

const refused = await probeNativeSessionContinuation(target(), {
  async claimSession() {
    throw new Error('native writer lock is active')
  }
})
assert.equal(refused.writable, false)
assert.equal(refused.reason, 'native writer lock is active')

claims = 0
const openCode = await probeNativeSessionContinuation(target({
  backend: 'opencode',
  transport: 'http',
  agentID: 'opencode',
  external: true,
  requiresExplicitClaim: true,
  config: {
    backend: 'opencode',
    host: '127.0.0.1',
    port: 4099,
    username: 'harness',
    password: 'testpw',
    agentId: 'opencode'
  }
}), {
  async claimSession() {
    claims += 1
  }
})
assert.deepEqual(openCode, { writable: true })
assert.equal(claims, 0, 'OpenCode native HTTP Sessions must not use the ACP claim transport')

console.log('native session continuation tests passed')
