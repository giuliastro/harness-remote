import assert from 'node:assert/strict'
import {
  discoverAgentNativeSessionPage,
  discoverAgentNativeSessions,
  discoverMachineNativeSessions,
  NativeSessionDiscoveryTimeoutError,
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

const dynamicProvider = { ...codex, id: 'mimo', label: 'MiMo Code', backend: 'mimo' }
assert.deepEqual(nativeSessionConfig(base, dynamicProvider), {
  ...base,
  backend: 'mimo',
  agentId: 'mimo'
}, 'machine-advertised provider ids must not fall back to the saved OpenCode backend')

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
assert.equal(codexSessions[0].commandsSupported, false)
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
  commandsSupported: false,
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

const metadataAgent = {
  ...codex,
  id: 'metadata-actions',
  label: 'Metadata Actions',
  capabilities: {
    ...codex.capabilities,
    sessionRename: true,
    sessionDelete: true
  }
}
const metadataSessions = await discoverAgentNativeSessions(base, metadataAgent, {
  async listGlobalSessions() {
    return [{ id: 'metadata-1', title: 'Metadata Session', directory: '/repo', time: { created: 1, updated: 2 } }]
  },
  async listSessions() {
    throw new Error('a successful global discovery must not use the stable fallback')
  },
  async listStatuses() {
    return {}
  }
})
assert.equal(metadataSessions.length, 1)
assert.equal(metadataSessions[0].renameSupported, true)
assert.equal(metadataSessions[0].deleteSupported, true)
const metadataTarget = nativeSessionSurfaceTarget('machine-1', base, metadataSessions[0])
assert.equal(metadataTarget.renameSupported, true)
assert.equal(metadataTarget.deleteSupported, true)

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

const pageCalls = []
const page = await discoverAgentNativeSessionPage(base, codex, "opaque+/cursor==", {
  async listGlobalSessionPage(config, cursor) {
    pageCalls.push([config.agentId, cursor])
    return {
      sessions: [{
        id: "older-codex",
        title: "Older Codex",
        directory: "/repo",
        time: { created: 1, updated: 5 },
        status: { type: "idle" }
      }],
      nextCursor: "tail"
    }
  },
  async listSessions() {
    throw new Error("a paged read must not fall back")
  },
  async listStatuses() {
    throw new Error("inline page status must avoid a duplicate status read")
  }
})
assert.deepEqual(pageCalls, [["codex", "opaque+/cursor=="]])
assert.equal(page.records[0].key, "codex:older-codex")
assert.deepEqual(page.records[0].status, { type: "idle" })
assert.equal(page.nextCursor, "tail")

const nonPaginatedAgents = [
  { id: "opencode", label: "OpenCode", backend: "opencode", transport: "http" },
  { id: "omp", label: "Oh My Pi", backend: "omp", transport: "acp" },
  { id: "pi", label: "PI", backend: "pi", transport: "acp" },
  { id: "claude", label: "Claude Code", backend: "claude", transport: "acp" },
  { id: "codex", label: "Codex", backend: "codex", transport: "acp" }
].map((agent) => ({
  ...agent,
  managed: true,
  state: "available",
  capabilities: { sessions: true, abort: true, models: true },
  contract: { sessions: { stop: "owned-session-native-cancel" } }
}))
const nonPaginatedCalls = []
const nonPaginatedClient = {
  async listGlobalSessionPage(config, cursor) {
    nonPaginatedCalls.push([config.backend, config.agentId, cursor])
    return {
      sessions: [{
        id: `${config.agentId}-existing`,
        title: `${config.agentId} existing Session`,
        directory: "/repo",
        time: { created: 1, updated: 2 },
        status: { type: "idle" }
      }]
    }
  },
  async listSessions() {
    throw new Error("a successful single-page read must not use the stable fallback")
  },
  async listStatuses() {
    throw new Error("inline page status must avoid a duplicate status read")
  }
}

for (const agent of nonPaginatedAgents) {
  const singlePage = await discoverAgentNativeSessionPage(base, agent, undefined, nonPaginatedClient)
  assert.equal(singlePage.nextCursor, undefined, `${agent.id} must not expose a load-older cursor when none was returned`)
  assert.deepEqual(singlePage.records.map((record) => ({
    key: record.key,
    backend: record.backend,
    transport: record.transport,
    status: record.status
  })), [{
    key: `${agent.id}:${agent.id}-existing`,
    backend: agent.backend,
    transport: agent.transport,
    status: { type: "idle" }
  }])
}
assert.deepEqual(nonPaginatedCalls, nonPaginatedAgents.map((agent) => [agent.backend, agent.id, undefined]))

let pagedFallbackReads = 0
const initialFallback = await discoverAgentNativeSessionPage(base, pi, undefined, {
  async listGlobalSessionPage() {
    throw new Error("unsupported")
  },
  async listSessions() {
    pagedFallbackReads += 1
    return [{ id: "fallback-page", title: "Fallback", directory: "/repo", time: { created: 1, updated: 2 } }]
  },
  async listStatuses() {
    return { "fallback-page": { type: "busy" } }
  }
})
assert.equal(pagedFallbackReads, 1)
assert.deepEqual(initialFallback.records.map((record) => record.key), ["pi:fallback-page"])
assert.deepEqual(initialFallback.records[0].status, { type: "busy" })

await assert.rejects(
  discoverAgentNativeSessionPage(base, pi, "cursor-that-cannot-fall-back", {
    async listGlobalSessionPage() { throw new Error("expired cursor") },
    async listSessions() { throw new Error("must not be called") },
    async listStatuses() { throw new Error("must not be called") }
  }),
  /expired cursor/
)

// A cold or hung ACP adapter must consume only its own bounded observation slot. In particular a
// timed-out experimental index must not launch the stable fallback behind the still-running request;
// NativeSessionHome catches this one harness failure and can render already-resolved OpenCode pages.
let timeoutFallbackReads = 0
const timeoutStartedAt = Date.now()
await assert.rejects(
  discoverAgentNativeSessionPage(base, codex, undefined, {
    async listGlobalSessionPage() { return new Promise(() => {}) },
    async listSessions() { timeoutFallbackReads += 1; return [] },
    async listStatuses() { return {} }
  }, 25),
  (error) => error instanceof NativeSessionDiscoveryTimeoutError && /codex/.test(error.message)
)
assert.equal(timeoutFallbackReads, 0, "a timed-out global index must not start a second fallback request")
assert.ok(Date.now() - timeoutStartedAt < 500, "the test harness must observe the configured discovery budget")

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
