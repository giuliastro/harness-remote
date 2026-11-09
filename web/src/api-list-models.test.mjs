import assert from 'node:assert/strict'
import { api } from './api.ts'

// Behavioral replacement for the old source-text guards in model-regression.test.mjs: exercise the
// real model-catalog API and verify both request scoping and the catalog contract returned to the UI.
const originalFetch = globalThis.fetch
const calls = []

try {
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify({
      providers: [
        {
          id: 'provider-a',
          name: 'Provider A',
          models: {
            'catalog-key': {
              id: 'model-x',
              name: 'Model X',
              description: 'Primary model',
              status: 'active',
              capabilities: {
                attachment: true,
                toolcall: true
              },
              limit: {
                context: 123456,
                output: 7890
              },
              variants: {
                ultra: {},
                low: {},
                max: {},
                medium: {}
              }
            },
            secondary: {
              name: 'Secondary',
              capabilities: {
                tools: true
              },
              limit: {
                context: 32000,
                output: 4096
              }
            }
          }
        },
        {
          id: 'provider-b',
          name: '',
          models: {
            plain: {
              description: 'No optional capabilities'
            }
          }
        }
      ],
      default: {
        'provider-a': 'catalog-key',
        'provider-b': 'plain'
      }
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }

  const models = await api.listModels(
    {
      backend: 'opencode',
      host: 'model-machine.invalid',
      port: 4096,
      username: 'harness',
      password: 'secret'
    },
    '/tmp/project with spaces',
    'ses/model scope'
  )

  assert.equal(calls.length, 1, 'listModels must issue exactly one catalog request')
  const requestURL = new URL(calls[0].url)
  assert.equal(requestURL.pathname, '/config/providers')
  assert.equal(requestURL.searchParams.get('directory'), '/tmp/project with spaces')
  assert.equal(requestURL.searchParams.get('sessionID'), 'ses/model scope')

  const primary = models.filter((model) => model.providerID === 'provider-a' && model.modelID === 'model-x')
  assert.deepEqual(
    primary.map((model) => model.variant ?? null),
    [null, 'ultra', 'low', 'max', 'medium'],
    'variant order must remain exactly as advertised by the harness catalog'
  )

  assert.deepEqual(primary[0], {
    providerID: 'provider-a',
    providerName: 'Provider A',
    modelID: 'model-x',
    modelName: 'Model X',
    description: 'Primary model',
    status: 'active',
    contextLimit: 123456,
    outputLimit: 7890,
    tools: true,
    attachments: true,
    isDefault: true
  })
  for (const variant of primary.slice(1)) {
    assert.equal(variant.isDefault, false, 'a variant must not replace the harness default model')
    assert.equal(variant.contextLimit, 123456)
    assert.equal(variant.outputLimit, 7890)
    assert.equal(variant.tools, true)
    assert.equal(variant.attachments, true)
  }

  const secondary = models.find((model) => model.providerID === 'provider-a' && model.modelID === 'secondary')
  assert.ok(secondary)
  assert.equal(secondary.tools, true, 'the alternate tools capability must be honored')
  assert.equal(secondary.attachments, false)
  assert.equal(secondary.contextLimit, 32000)
  assert.equal(secondary.outputLimit, 4096)
  assert.equal(secondary.isDefault, false)

  const plain = models.find((model) => model.providerID === 'provider-b' && model.modelID === 'plain')
  assert.ok(plain)
  assert.equal(plain.providerName, 'provider-b', 'provider id must remain the name fallback')
  assert.equal(plain.tools, false)
  assert.equal(plain.attachments, false)
  assert.equal(plain.isDefault, true)

  // A browser request that survived a suspended tab used to have no abort boundary at all. Exercise
  // the real listSessions path with an accelerated timer and require the request signal to abort.
  const originalSetTimeout = globalThis.setTimeout
  let timeoutDelay
  let abortObserved = false
  try {
    globalThis.setTimeout = (callback, delay, ...args) => {
      timeoutDelay = delay
      return originalSetTimeout(callback, 0, ...args)
    }
    globalThis.fetch = (_input, init = {}) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        abortObserved = true
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }, { once: true })
    })
    await assert.rejects(
      api.listSessions({
        backend: 'opencode',
        host: 'sleeping-machine.invalid',
        port: 4097,
        username: 'harness',
        password: 'secret'
      }),
      /timed out after 30s/,
      'ordinary browser Session reads must not survive indefinitely after idle/suspend'
    )
    assert.equal(timeoutDelay, 30_000, 'browser API timeout must match the existing native default')
    assert.equal(abortObserved, true, 'browser API timeout must abort the underlying fetch transport')
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }

  // A cold DeepSeek npx launch may install and unpack the runtime before either endpoint replies.
  // Exercise the browser transport's actual abort timer for both UI requests.
  for (const invoke of [
    (config) => api.listModels(config),
    (config) => api.createSession(config, 'cold start')
  ]) {
    let deepseekTimeoutDelay
    let deepseekAborted = false
    try {
      globalThis.setTimeout = (callback, delay, ...args) => {
        deepseekTimeoutDelay = delay
        return originalSetTimeout(callback, 0, ...args)
      }
      globalThis.fetch = (_input, init = {}) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          deepseekAborted = true
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        }, { once: true })
      })
      await assert.rejects(invoke({ backend: 'deepseek', host: 'cold-start.invalid', port: 4098, username: '', password: '' }), /timed out after 300s/)
      assert.equal(deepseekTimeoutDelay, 300_000)
      assert.equal(deepseekAborted, true)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  }
} finally {
  globalThis.fetch = originalFetch
}

console.log('model catalog API behavioral tests passed')
