import assert from 'node:assert/strict'
import {
  discoverAgentNativeSessions,
  discoverMachineNativeSessions,
  nativeSessionConfig,
  nativeSessionSurfaceTarget
} from './native-session-discovery.ts'

const base = {
  backend: 'opencode',
  host: '192.168.1.72',
  port: 4099,
  username: 'harness',
  password: 'secret'
}

const codex = {
  id: 'codex',
  label: 'Codex',
  backend: 'codex',
  transport: 'acp',
  managed: true,
  state: 'available',
  capabilities: { sessions: true, abort: true, models: true },
  contract: { sessions: { stop: 'owned-session-native-cancel' } }
}

assert.deepEqual(nativeSessionConfig(base, codex), {
  ...base,
  backend: 'codex',
  agentId: 'codex'
})

const calls = []
const client = {
  async listGlobalSessions(config) {
    calls.push(['global', config.backend, config.agentId])
    return [{
      id: 's1',
      title: 'Native Codex',
      directory: '/repo',
      time: { created: 1, updated: 20 },
      external: true,
      parentID: 'parent-1',
      summary: { additions: 12, deletions: 3, files: 2 },
      tokens: { input: 1200, output: 300, reasoning: 50, cache: { read: 400, write: 20 } },
      cost: 0.25,
      agent: 'plan',
      permission: [
        { permission: 'edit', pattern: '*', action: 'deny' },
        { permission: 'bash', pattern: 'git push *', action: 'ask' }
      ],
      model: { providerID: 'openai', id: 'gpt-5.6', variant: 'high' }
    }]
  },
  async listSessions(config) {
    calls.push(['stable', config.backend, config.agentId])
    return []
  },
  async listStatuses(config) {
    calls.push(['status', config.backend, config.agentId])
    return { s1: { type: 'busy' } }
  }
}

const codexSessions = await discoverAgentNativeSessions(base, codex, client)
assert.equal(codexSessions.length, 1)
assert.equal(codexSessions[0].key, 'codex:s1')
assert.equal(codexSessions[0].agentLabel, 'Codex')
assert.equal(codexSessions[0].backend, 'codex')
assert.equal(codexSessions[0].transport, 'acp')
assert.equal(codexSessions[0].stopCapability, 'owned-session-native-cancel')
assert.equal(codexSessions[0].abortSupported, true)
assert.equal(codexSessions[0].modelsSupported, true)
assert.equal(codexSessions[0].renameSupported, false)
assert.equal(codexSessions[0].deleteSupported, false)
assert.equal(codexSessions[0].session.external, true)
assert.equal(codexSessions[0].status.type, 'busy')
assert.deepEqual(calls, [
  ['global', 'codex', 'codex'],
  ['status', 'codex', 'codex']
])

assert.deepEqual(nativeSessionSurfaceTarget('machine-1', base, codexSessions[0]), {
  key: 'machine-1:codex:s1',
  ref: {
    machineID: 'machine-1',
    agentID: 'codex',
    sessionID: 's1',
    directory: '/repo'
  },
  machineID: 'machine-1',
  sessionID: 's1',
  directory: '/repo',
  title: 'Native Codex',
  agentID: 'codex',
  agentLabel: 'Codex',
  backend: 'codex',
  transport: 'acp',
  config: { ...base, backend: 'codex', agentId: 'codex' },
  status: { type: 'busy' },
  external: true,
  modelsSupported: true,
  renameSupported: false,
  deleteSupported: false,
  model: { providerID: 'openai', modelID: 'gpt-5.6', variant: 'high' },
  parentID: 'parent-1',
  summary: { additions: 12, deletions: 3, files: 2 },
  tokens: { input: 1200, output: 300, reasoning: 50, cache: { read: 400, write: 20 } },
  cost: 0.25,
  nativeAgent: 'plan',
  permission: [
    { permission: 'edit', pattern: '*', action: 'deny' },
    { permission: 'bash', pattern: 'git push *', action: 'ask' }
  ],
  requiresExplicitClaim: true,
  canStop: true
})

// Lightweight ACP discovery may omit `external`. That must never be interpreted as proof that this
// bridge owns the writer; the surface remains observe-only until an explicit claim succeeds.
const missingOwnershipMetadata = nativeSessionSurfaceTarget('machine-1', base, {
  ...codexSessions[0],
  session: { ...codexSessions[0].session, external: undefined }
})
assert.equal(missingOwnershipMetadata.external, false)
assert.equal(missingOwnershipMetadata.requiresExplicitClaim, true)

const fallbackCalls = []
const fallbackClient = {
  async listGlobalSessions(config) {
    fallbackCalls.push(['global', config.agentId])
    throw new Error('unsupported')
  },
  async listSessions(config) {
    fallbackCalls.push(['stable', config.agentId])
    return [{ id: 'p1', title: 'PI native', directory: '/repo', time: { created: 1, updated: 10 } }]
  },
  async listStatuses(config) {
    fallbackCalls.push(['status', config.agentId])
    throw new Error('status unavailable')
  }
}

const pi = { ...codex, id: 'pi', label: 'PI', backend: 'pi' }
const fallbackSessions = await discoverAgentNativeSessions(base, pi, fallbackClient)
assert.equal(fallbackSessions.length, 1)
assert.equal(fallbackSessions[0].key, 'pi:p1')
assert.equal(fallbackSessions[0].status, undefined)
assert.deepEqual(fallbackCalls, [
  ['global', 'pi'],
  ['stable', 'pi'],
  ['status', 'pi']
])

let disabledReads = 0
const disabled = { ...codex, id: 'disabled', capabilities: { sessions: false } }
assert.deepEqual(await discoverAgentNativeSessions(base, disabled, {
  async listGlobalSessions() { disabledReads += 1; return [] },
  async listSessions() { disabledReads += 1; return [] },
  async listStatuses() { disabledReads += 1; return {} }
}), [])
assert.equal(disabledReads, 0)

const machineClient = {
  async listGlobalSessions(config) {
    if (config.agentId === 'broken') throw new Error('adapter failed')
    return [{
      id: `${config.agentId}-session`,
      title: config.agentId,
      directory: '/repo',
      time: { created: 1, updated: config.agentId === 'codex' ? 30 : 15 }
    }]
  },
  async listSessions() { return [] },
  async listStatuses() { return {} }
}

const records = await discoverMachineNativeSessions(base, [
  pi,
  codex,
  { ...codex, id: 'broken', label: 'Broken', backend: 'claude' }
], machineClient)
assert.deepEqual(records.map((record) => record.key), ['codex:codex-session', 'pi:pi-session'])

console.log('native session discovery tests passed')
