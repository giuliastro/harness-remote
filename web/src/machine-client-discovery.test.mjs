import assert from 'node:assert/strict'
import { discoverMachine, readMachinePairingGrantStatus, requestMachinePairingGrant } from './machineClient.ts'
import { MachineHttpError } from './machine-request-error.ts'

// Behavioral replacement for the old source-text guards in machine-payload.test.mjs. Exercise the
// real discovery path under Vite so application imports resolve exactly as they do in the web app.
const originalFetch = globalThis.fetch
const discoveryCalls = []
const discoverySnapshot = {
  machine: { id: 'machine-behavior', name: 'Behavior machine' },
  agents: [{ id: 'opencode', state: 'configured' }]
}

try {
  globalThis.fetch = async (input) => {
    discoveryCalls.push(String(input))
    return {
      status: 200,
      ok: true,
      json: async () => JSON.stringify(discoverySnapshot)
    }
  }

  const discovered = await discoverMachine({
    backend: 'opencode',
    host: 'behavior-machine.invalid',
    port: 4096,
    username: 'harness',
    password: 'secret'
  })
  assert.deepEqual(discovered, discoverySnapshot, 'active machine discovery must normalize a JSON-string payload')
  assert.deepEqual(
    discoveryCalls,
    ['http://behavior-machine.invalid:4096/v1/machine'],
    'normal Session-first discovery must use only the configured Machine endpoint'
  )

  discoveryCalls.length = 0
  globalThis.fetch = async (input) => {
    discoveryCalls.push(String(input))
    return { status: 404, ok: false, json: async () => ({}) }
  }

  const missing = await discoverMachine({
    backend: 'opencode',
    host: 'legacy-open-code.invalid',
    port: 4096,
    username: 'harness',
    password: 'secret'
  })
  assert.equal(missing, null)
  assert.deepEqual(
    discoveryCalls,
    ['http://legacy-open-code.invalid:4096/v1/machine'],
    'a missing Machine endpoint must not trigger the legacy 4097 candidate probe'
  )

  discoveryCalls.length = 0
  let releaseSharedProbe
  globalThis.fetch = (input, init = {}) => new Promise((resolve, reject) => {
    discoveryCalls.push(String(input))
    init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    releaseSharedProbe = () => resolve({
      status: 200,
      ok: true,
      json: async () => discoverySnapshot
    })
  })
  const sharedConfig = {
    backend: 'opencode',
    host: 'coalesced-machine.invalid',
    port: 4097,
    username: 'harness',
    password: 'secret'
  }
  const sharedFirst = discoverMachine(sharedConfig)
  const sharedSecond = discoverMachine(sharedConfig)
  await Promise.resolve()
  assert.equal(discoveryCalls.length, 1, 'overlapping refreshes for one machine must share one browser request')
  releaseSharedProbe()
  assert.deepEqual(await sharedFirst, discoverySnapshot)
  assert.deepEqual(await sharedSecond, discoverySnapshot)

  discoveryCalls.length = 0
  const realNow = Date.now
  let fakeNow = 1_000
  Date.now = () => fakeNow
  try {
    let requestNumber = 0
    globalThis.fetch = (input, init = {}) => new Promise((resolve, reject) => {
      requestNumber += 1
      discoveryCalls.push(String(input))
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
      if (requestNumber === 2) {
        resolve({ status: 200, ok: true, json: async () => discoverySnapshot })
      }
    })
    const staleConfig = {
      backend: 'opencode',
      host: 'wake-machine.invalid',
      port: 4097,
      username: 'harness',
      password: 'secret'
    }
    const beforeSleep = discoverMachine(staleConfig)
    await Promise.resolve()
    fakeNow += 12_001
    const afterWake = discoverMachine(staleConfig)
    await assert.rejects(beforeSleep, /restarted after a stale connection/, 'a pre-sleep request must be aborted instead of surviving the wake refresh')
    assert.deepEqual(await afterWake, discoverySnapshot, 'wake refresh must immediately use the replacement request')
    assert.equal(discoveryCalls.length, 2, 'wake recovery must replace exactly one stale request with one fresh request')
  } finally {
    Date.now = realNow
  }
} finally {
  globalThis.fetch = originalFetch
}

// Pairing grants use the same authenticated machine endpoint as every other machine call. The
// client-side behavioral contract: authenticated POST to issue, authenticated GET to poll, parsed
// answer or a typed HTTP error - never a silent success.
{
  const grantCalls = []
  const pairingURLCandidate = `harnessremote://pair?endpoint=${encodeURIComponent('http://192.168.1.20:4097')}&token=${'a'.repeat(43)}&expires=${Date.now() + 60_000}`
  const grantPayload = {
    version: 1,
    expiresAt: Date.now() + 300_000,
    loopbackOnly: false,
    links: [{ endpoint: 'http://192.168.1.20:4097', uri: pairingURLCandidate }]
  }
  const config = {
    backend: 'opencode',
    host: 'pairing-machine.invalid',
    port: 4097,
    username: 'harness',
    password: 'secret'
  }
  try {
    globalThis.fetch = async (input, init = {}) => {
      grantCalls.push({ url: String(input), init })
      return { status: 200, ok: true, json: async () => grantPayload }
    }
    const grant = await requestMachinePairingGrant(config)
    assert.deepEqual(
      grant,
      { expiresAt: grantPayload.expiresAt, loopbackOnly: false, links: grantPayload.links },
      'the issued grant is the parsed daemon answer'
    )
    assert.deepEqual(
      grantCalls.map((call) => [call.url, call.init.method, call.init.headers.Authorization]),
      [['http://pairing-machine.invalid:4097/v1/pairing/grant', 'POST', `Basic ${Buffer.from('harness:secret').toString('base64')}`]],
      'issuing a grant must be an authenticated POST to the machine pairing route'
    )

    grantCalls.length = 0
    globalThis.fetch = async (input, init = {}) => {
      grantCalls.push({ url: String(input), init })
      return { status: 200, ok: true, json: async () => ({ version: 1, expiresAt: grantPayload.expiresAt, claimed: true, expired: false }) }
    }
    const status = await readMachinePairingGrantStatus(config)
    assert.deepEqual(status, { expiresAt: grantPayload.expiresAt, claimed: true, expired: false }, 'grant status must report the daemon truth')
    assert.deepEqual(
      grantCalls.map((call) => [call.url, call.init.method]),
      [['http://pairing-machine.invalid:4097/v1/pairing/grant', 'GET']],
      'status polling must be an authenticated GET to the same route'
    )

    globalThis.fetch = async () => ({ status: 401, ok: false, json: async () => ({}) })
    await assert.rejects(
      () => requestMachinePairingGrant(config),
      (error) => error instanceof MachineHttpError && error.status === 401,
      'an unauthorized grant request must surface as a machine HTTP error'
    )

    globalThis.fetch = async () => ({ status: 200, ok: true, json: async () => ({ version: 1, links: [] }) })
    await assert.rejects(
      () => requestMachinePairingGrant(config),
      /invalid pairing response/,
      'a malformed grant answer must not be treated as a usable QR'
    )
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('machine client discovery behavioral tests passed')
