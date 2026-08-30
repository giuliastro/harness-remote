import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, after } from 'node:test'

const { ProfileRegistry, validateDesktopProfile } = await import('../dist-electron/electron/profile-registry.js')
const { restoredBounds } = await import('../dist-electron/electron/window-state.js')
const { executeDesktopRequest, MAX_RESPONSE_BYTES } = await import('../dist-electron/electron/request-transport.js')

const profile = {
  id: 'test-profile',
  backend: 'opencode',
  host: '127.0.0.1',
  port: 0,
  username: 'user',
  password: 'secret'
}

let server
let port
server = createServer(async (request, response) => {
  if (request.url === '/json' && request.method === 'GET') {
    assert.equal(request.headers.authorization, 'Basic dXNlcjpzZWNyZXQ=')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true }))
    return
  }
  if (request.url === '/v1/agents/opencode/query?directory=%2Fwork%2Frepo' && request.method === 'GET') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ url: request.url }))
    return
  }
  if (request.url === '/body' && request.method === 'POST') {
    let body = ''
    for await (const chunk of request) body += chunk
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ method: request.method, body: JSON.parse(body) }))
    return
  }
  if (request.url === '/empty') {
    response.statusCode = 204
    response.end()
    return
  }
  if (request.url === '/error') {
    response.statusCode = 422
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ message: 'bad request' }))
    return
  }
  if (request.url === '/redirect') {
    response.statusCode = 302
    response.setHeader('location', '/json')
    response.end()
    return
  }
  if (request.url === '/large') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify('x'.repeat(MAX_RESPONSE_BYTES + 1)))
    return
  }
  if (request.url === '/slow') {
    setTimeout(() => response.end('{}'), 100)
    return
  }
  if (request.url === '/stall-body') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"partial":')
    return
  }
  if (request.url.startsWith('/echo') || request.url.startsWith('/v1/') || request.url.startsWith('/global/')) {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ url: request.url, backend: request.headers['x-harness-backend'] ?? null }))
    return
  }
  response.statusCode = 404
  response.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
port = server.address().port
const localProfile = { ...profile, port }

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

test('validated registry rejects unsafe targets and persists approved profiles', async () => {
  assert.throws(() => validateDesktopProfile({ ...localProfile, host: 'https://user:pass@example.com' }), /invalid/)
  assert.throws(() => validateDesktopProfile({ ...localProfile, host: 'ftp://example.com' }), /unsupported/)
  assert.throws(() => validateDesktopProfile({ ...localProfile, host: 'example.com/path' }), /invalid/)
  assert.throws(() => validateDesktopProfile({ ...localProfile, host: 'example.com:123' }), /port/)
  assert.throws(() => validateDesktopProfile({ ...localProfile, id: '' }), /ID/)

  const directory = await mkdtemp(join(tmpdir(), 'harness-remote-'))
  const file = join(directory, 'profiles.json')
  const registry = new ProfileRegistry(file)
  await registry.replace([localProfile])
  assert.deepEqual(registry.get(localProfile.id), localProfile)
  const reloaded = new ProfileRegistry(file)
  await reloaded.load()
  assert.deepEqual(reloaded.get(localProfile.id), localProfile)
  assert.throws(() => reloaded.get("deleted-profile"), /Unknown server profile/)
  const persisted = await readFile(file, 'utf8')
  assert.equal(persisted.includes(localProfile.password), true)
  await rm(directory, { recursive: true, force: true })
})
test('registry reload accepts the canonical workspace snapshot after an Electron restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-remote-restart-'))
  const file = join(directory, 'profiles.json')
  const first = new ProfileRegistry(file)
  await first.replace([localProfile], 17)

  const restartedMain = new ProfileRegistry(file)
  await restartedMain.load()
  assert.deepEqual(restartedMain.get(localProfile.id), localProfile)
  const reconciled = await restartedMain.replace([localProfile], 1)
  assert.deepEqual(reconciled.acceptedProfileIDs, [localProfile.id])
  assert.deepEqual(reconciled.unchangedProfileIDs, [localProfile.id])
  await rm(directory, { recursive: true, force: true })
})

test('registry applies a reloaded renderer snapshot with a restarted client revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-remote-revisions-'))
  const registry = new ProfileRegistry(join(directory, 'profiles.json'))
  const empty = await registry.replace([], 1)
  assert.deepEqual(registry.ids(), [])
  const populated = await registry.replace([localProfile], 2)
  assert.ok(populated.revision > empty.revision)
  const reloadedRenderer = await registry.replace([], 1)
  assert.ok(reloadedRenderer.revision > populated.revision)
  assert.deepEqual(registry.ids(), [])
  await rm(directory, { recursive: true, force: true })
})
test('window restore selects saved monitor and keeps title bar visible', async () => {
  const displays = [
    { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    { workArea: { x: 1920, y: -100, width: 2560, height: 1440 } }
  ]
  const bounds = restoredBounds({ x: 2100, y: 20, width: 900, height: 700 }, displays)
  assert.equal(bounds.x, 2100)
  assert.equal(bounds.y, 20)
  const removedDisplay = restoredBounds({ x: 5000, y: 5000, width: 900, height: 700 }, displays)
  assert.ok(removedDisplay.x < 4480)
  assert.ok(removedDisplay.y < 1340)
})


test('request transport enforces approved profile target and HTTP contract', async () => {
  assert.deepEqual((await executeDesktopRequest(localProfile, { path: '/json' })).response.data, { ok: true })
  assert.deepEqual((await executeDesktopRequest(localProfile, { path: '/body', method: 'POST', body: { value: 2 } })).response.data, { method: 'POST', body: { value: 2 } })
  assert.equal((await executeDesktopRequest(localProfile, { path: '/empty' })).response.data, true)
  const httpError = await executeDesktopRequest(localProfile, { path: '/error' })
  assert.equal(httpError.error.message, 'bad request')
  assert.equal(httpError.error.status, 422)
  assert.equal((await executeDesktopRequest(localProfile, { path: '/redirect' })).error.code, 'redirect')
  assert.equal((await executeDesktopRequest(localProfile, { path: '/large' })).error.code, 'response-too-large')
  assert.equal((await executeDesktopRequest(localProfile, { path: 'http://example.com' })).error.code, 'invalid-path')
  assert.equal((await executeDesktopRequest(localProfile, { path: '//example.com' })).error.code, 'invalid-path')
  assert.equal((await executeDesktopRequest(localProfile, { path: '/slow', readTimeout: 10 })).error.code, 'timeout')
  assert.equal((await executeDesktopRequest(localProfile, { path: '/stall-body', readTimeout: 20 })).error.code, 'timeout')
  assert.equal((await executeDesktopRequest(localProfile, { path: '/json', readTimeout: MAX_RESPONSE_BYTES + 1 })).error.code, 'invalid-payload')
})

test('agent-scoped desktop requests preserve their query string', async () => {
  const routed = await executeDesktopRequest(
    { ...localProfile, agentId: 'opencode' },
    { path: '/query?directory=%2Fwork%2Frepo' }
  )
  assert.deepEqual(routed.response.data, { url: '/v1/agents/opencode/query?directory=%2Fwork%2Frepo' })
})

test('machine discovery never carries the backend hint that can divert it into a child harness', async () => {
  const root = await executeDesktopRequest(localProfile, {
    path: '/v1/machine',
    route: { backend: 'opencode' }
  })
  assert.deepEqual(root.response.data, { url: '/v1/machine', backend: null })

  const legacyRoot = await executeDesktopRequest(localProfile, {
    path: '/global/machine',
    route: { backend: 'opencode' }
  })
  assert.deepEqual(legacyRoot.response.data, { url: '/global/machine', backend: null })
})

test('request routing selects an agent inside the approved root machine profile', async () => {
  const routed = await executeDesktopRequest(localProfile, {
    path: '/echo/session',
    route: { backend: 'codex', agentId: 'pi' }
  })
  assert.deepEqual(routed.response.data, { url: '/v1/agents/pi/echo/session', backend: 'codex' })

  const machineRoute = await executeDesktopRequest(localProfile, {
    path: '/v1/machine',
    route: { backend: 'pi', agentId: 'pi' }
  })
  assert.equal(machineRoute.response.data.url, '/v1/machine')

  assert.equal((await executeDesktopRequest(localProfile, {
    path: '/echo/session',
    route: { backend: 'codex', agentId: '../pi' }
  })).error.code, 'invalid-payload')
})

test('HTTP errors expose status without matching prose', async () => {
  const missing = await executeDesktopRequest(localProfile, { path: '/missing' })
  assert.equal(missing.error.code, 'http')
  assert.equal(missing.error.status, 404)
})

test('the registry keeps the selected agent, which is the only thing that routes a profile', async () => {
  const scoped = { ...localProfile, backend: 'codex', agentId: 'codex' }
  assert.deepEqual(validateDesktopProfile(scoped), scoped)
  assert.equal(validateDesktopProfile({ ...scoped, agentId: '  ' }).agentId, undefined)
  assert.throws(() => validateDesktopProfile({ ...scoped, agentId: '../codex' }), /agent/)
  assert.throws(() => validateDesktopProfile({ ...scoped, agentId: 'co dex' }), /agent/)
  assert.throws(() => validateDesktopProfile({ ...scoped, agentId: 42 }), /agent/)

  const directory = await mkdtemp(join(tmpdir(), 'harness-remote-agents-'))
  const registry = new ProfileRegistry(join(directory, 'profiles.json'))
  await registry.replace([scoped])
  assert.equal(registry.get(scoped.id).agentId, 'codex')
  // Switching only the agent is a real change: treating it as unchanged left the event stream
  // subscribed to the agent the user just navigated away from.
  const switched = await registry.replace([{ ...scoped, backend: 'pi', agentId: 'pi' }])
  assert.deepEqual(switched.changedProfileIDs, [scoped.id])
  await rm(directory, { recursive: true, force: true })
})

test('desktop requests carry the profile scope the browser sends, and leave machine routes alone', async () => {
  const scoped = { ...localProfile, backend: 'codex', agentId: 'pi' }
  const agentRequest = await executeDesktopRequest(scoped, { path: '/echo/session' })
  assert.deepEqual(agentRequest.response.data, { url: '/v1/agents/pi/echo/session', backend: 'codex' })

  // TaskDesk and machine discovery are answered by the daemon itself; scoping them to the
  // profile's agent aims them at a bridge where those routes do not exist.
  for (const path of ['/v1/machine', '/global/machine', '/v1/projects', '/v1/tasks', '/v1/tasks/abc/launch', '/v1/agents/omp/models']) {
    const machineRequest = await executeDesktopRequest(scoped, { path })
    assert.equal(machineRequest.response.data.url, path, `${path} should reach the daemon unscoped`)
    assert.equal(machineRequest.response.data.backend, null, `${path} must not carry a backend routing override`)
  }
  const withQuery = await executeDesktopRequest(scoped, { path: '/v1/tasks?limit=1' })
  assert.equal(withQuery.response.data.url, '/v1/tasks?limit=1')

  // Nothing preflights a request from the main process, so an unscoped OpenCode profile still says
  // which harness it wants — which is what lets a daemon route it somewhere other than its primary.
  const unscoped = await executeDesktopRequest({ ...localProfile, backend: 'opencode' }, { path: '/echo/session' })
  assert.deepEqual(unscoped.response.data, { url: '/echo/session', backend: 'opencode' })
})
