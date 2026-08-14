import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, test } from 'node:test'

const { executeDesktopRequest } = await import('../dist-electron/electron/request-transport.js')

const seen = []
const server = createServer((request, response) => {
  seen.push(request.url)
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ url: request.url }))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const profile = {
  id: 'daemon-agent-profile',
  backend: 'codex',
  host: '127.0.0.1',
  port,
  username: 'harness',
  password: 'secret',
  agentId: 'codex'
}

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

test('machine task and project endpoints bypass the saved agent scope', async () => {
  const paths = [
    '/v1/projects',
    '/v1/tasks',
    '/v1/tasks/task-1/worktree',
    '/v1/tasks/task-1/launch',
    '/v1/tasks/task-1/result',
    '/v1/tasks/task-1/finish'
  ]
  for (const path of paths) {
    const result = await executeDesktopRequest(profile, { path })
    assert.equal(result.response.data.url, path)
  }
  assert.deepEqual(seen, paths)
})

test('ordinary backend paths remain agent-scoped', async () => {
  const result = await executeDesktopRequest(profile, { path: '/session' })
  assert.equal(result.response.data.url, '/v1/agents/codex/session')
})
