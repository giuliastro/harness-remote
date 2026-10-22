import assert from 'node:assert/strict'
import {
  createFetchOpenCodeEventSubscription,
  createOpenCodeEventSubscription,
  eventType,
  parseOpenCodeEvent,
  parseSSEFrame,
  streamURL
} from './opencode-events.ts'

// Captured from OpenCode 1.17.17 GET /event. No `event:` line was present,
// so browser EventSource dispatches these frames through onmessage.
const serverConnected = '{"id":"evt_f7b696456001nNtrSlcthY9fp2","type":"server.connected","properties":{}}'
const sessionCreated = '{"id":"evt_f7b697d14001eRcElcwwtqJe5M","type":"session.created","properties":{"sessionID":"ses_0849682ecffebuK36ytRJ4yFbK","info":{"id":"ses_0849682ecffebuK36ytRJ4yFbK","title":"SSE prototype probe"}}}'
const serverHeartbeat = '{"id":"evt_f7b698b6f001csz0LF7XTKPuPw","type":"server.heartbeat","properties":{}}'
const globalSessionCreated = JSON.stringify({
  directory: '/home/giulio/Software/harness-remote',
  payload: JSON.parse(sessionCreated)
})
const globalHeartbeat = JSON.stringify({
  directory: '/home/giulio/Software/harness-remote',
  payload: JSON.parse(serverHeartbeat)
})

assert.deepEqual(parseOpenCodeEvent(sessionCreated), {
  ok: true, name: 'message', raw: sessionCreated, data: JSON.parse(sessionCreated)
})
assert.deepEqual(parseOpenCodeEvent(globalSessionCreated), {
  ok: true, name: 'message', raw: globalSessionCreated, data: JSON.parse(globalSessionCreated)
})
assert.equal(eventType(JSON.parse(globalSessionCreated)), 'session.created')
assert.equal(eventType(JSON.parse(globalHeartbeat)), 'server.heartbeat')
assert.equal(eventType({ type: 'message.updated' }), 'message.updated')
assert.equal(eventType(['unexpected']), null)
assert.deepEqual(parseOpenCodeEvent(JSON.stringify(['future', 'event']), 'future.event'), {
  ok: true, name: 'future.event', raw: JSON.stringify(['future', 'event']), data: ['future', 'event']
})
assert.deepEqual(parseSSEFrame('event: session.updated\ndata: {"id":"ses_1"}\n\n'), {
  ok: true,
  name: 'session.updated',
  raw: '{"id":"ses_1"}',
  data: { id: 'ses_1' }
})
assert.deepEqual(parseSSEFrame('data: {"id":"ses_2"}\n\n'), {
  ok: true,
  name: 'message',
  raw: '{"id":"ses_2"}',
  data: { id: 'ses_2' }
})
assert.equal(parseSSEFrame(': keep-alive\n\n'), null)
const malformed = parseOpenCodeEvent('not json')
assert.equal(malformed.ok, false)
assert.equal(malformed.raw, 'not json')
assert.equal(malformed.name, 'message')

assert.equal(streamURL('http://127.0.0.1:4097', 'project'), 'http://127.0.0.1:4097/event')
assert.equal(streamURL('http://127.0.0.1:4097/', 'project', '/repo with spaces'), 'http://127.0.0.1:4097/event?directory=%2Frepo+with+spaces')
assert.equal(streamURL('https://server.example', 'global'), 'https://server.example/global/event')

const sources = []
const delays = []
const events = []
const statuses = []
const logs = []
const timers = []
let nextTimerID = 1

const subscription = createOpenCodeEventSubscription({
  url: 'http://127.0.0.1:4097/event',
  reconnect: { initialDelayMs: 100, maxDelayMs: 400 },
  createEventSource(url) {
    const source = { url, closeCalls: 0, close() { this.closeCalls += 1 } }
    sources.push(source)
    return source
  },
  schedule(callback, delay) {
    delays.push(delay)
    const timer = { id: nextTimerID++, callback, cancelled: false }
    timers.push(timer)
    return timer.id
  },
  cancel(timerID) {
    const timer = timers.find((item) => item.id === timerID)
    if (timer) timer.cancelled = true
  },
  onEvent(event) { events.push(event) },
  onStatus(status) { statuses.push(status) },
  logger(message) { logs.push(message) }
})

assert.equal(sources.length, 1)
sources[0].onopen?.()
assert.deepEqual(statuses.at(-1), { type: 'connected' })
sources[0].onmessage?.({ data: serverConnected })
sources[0].onmessage?.({ data: sessionCreated })
sources[0].onmessage?.({ data: serverHeartbeat })
assert.equal(events.length, 3)
assert.deepEqual(events[1].data, JSON.parse(sessionCreated))
sources[0].onmessage?.({ data: 'malformed' })
assert.equal(events.length, 3)
assert.deepEqual(statuses.at(-1), { type: 'parse-error', data: 'malformed' })
assert.ok(logs.some((message) => message.includes('unparseable message event')))

sources[0].onerror?.()
assert.equal(sources[0].closeCalls, 1)
assert.deepEqual(delays, [100])
timers[0].callback()
assert.equal(sources.length, 2)
sources[1].onopen?.()
sources[0].onerror?.()
assert.equal(sources[1].closeCalls, 0, 'stale source must not close the current source')
assert.deepEqual(delays, [100], 'stale source must not schedule a reconnect')

sources[1].onerror?.()
assert.deepEqual(delays, [100, 100], 'open resets retry delay')
timers[1].callback()
assert.equal(sources.length, 3)
sources[2].onerror?.()
assert.deepEqual(delays, [100, 100, 200])
timers[2].callback()
assert.equal(sources.length, 4)
sources[3].onerror?.()
assert.deepEqual(delays, [100, 100, 200, 400])
timers[3].callback()
assert.equal(sources.length, 5)
sources[4].onerror?.()
assert.deepEqual(delays, [100, 100, 200, 400, 400])
subscription.close()
assert.equal(sources[4].closeCalls, 1)
assert.equal(timers[4].cancelled, true)
assert.deepEqual(statuses.at(-1), { type: 'closed' })
sources[4].onmessage?.({ data: sessionCreated })
assert.equal(events.length, 3)
subscription.close()
assert.equal(sources[4].closeCalls, 1, 'close must be idempotent')

const invalidDelays = []
const invalidSubscription = createOpenCodeEventSubscription({
  url: 'http://127.0.0.1:4097/event',
  reconnect: { initialDelayMs: 0, maxDelayMs: -1 },
  createEventSource() { throw new Error('factory unavailable') },
  schedule(_callback, delay) { invalidDelays.push(delay); return 1 },
  cancel() {},
  onEvent() {},
  onStatus() {},
  logger() {}
})
assert.deepEqual(invalidDelays, [1_000], 'invalid retry delays should fall back safely')
invalidSubscription.close()

const fetchEvents = []
const fetchStatuses = []
const fetchCalls = []
const encoder = new TextEncoder()
const fetchSubscription = createFetchOpenCodeEventSubscription({
  url: 'http://127.0.0.1:4097/global/event',
  headers: { Authorization: 'Basic test-token' },
  fetchFn: async (url, init) => {
    fetchCalls.push({ url, init })
    const body = new ReadableStream({
      start(controller) {
        const frame = `data: ${globalSessionCreated}\n\n`
        controller.enqueue(encoder.encode(frame.slice(0, 12)))
        controller.enqueue(encoder.encode(frame.slice(12)))
        controller.close()
      }
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
  },
  onEvent(event) { fetchEvents.push(event) },
  onStatus(status) { fetchStatuses.push(status) },
  logger() {}
})
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(fetchCalls[0].url, 'http://127.0.0.1:4097/global/event')
assert.equal(fetchCalls[0].init.headers.Authorization, 'Basic test-token')
assert.equal(fetchCalls[0].init.headers.Accept, 'text/event-stream')
assert.deepEqual(fetchEvents[0].data, JSON.parse(globalSessionCreated))
assert.ok(fetchStatuses.some((status) => status.type === 'connected'))
assert.ok(fetchStatuses.some((status) => status.type === 'reconnecting'))
fetchSubscription.close()

const invalidContentStatuses = []
const invalidContentSubscription = createFetchOpenCodeEventSubscription({
  url: 'http://127.0.0.1:4097/global/event',
  fetchFn: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
  onEvent() {},
  onStatus(status) { invalidContentStatuses.push(status) },
  logger() {}
})
await new Promise((resolve) => setTimeout(resolve, 0))
assert.ok(invalidContentStatuses.some((status) => status.type === 'connection-error'))
assert.ok(!invalidContentStatuses.some((status) => status.type === 'connected'))
invalidContentSubscription.close()

// A stream that opens, delivers nothing, and never ends must not sit in `connected` forever:
// the caller suppresses its polling fallback while live, so a silent stall has to reconnect.
const stallStatuses = []
let stallConnects = 0
const stallSubscription = createFetchOpenCodeEventSubscription({
  url: 'http://127.0.0.1:4097/global/event',
  stallTimeoutMs: 20,
  reconnect: { initialDelayMs: 5 },
  fetchFn: async () => {
    stallConnects += 1
    // Never enqueues and never closes: mimics a dead TCP connection.
    const body = new ReadableStream({ start() {} })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  },
  onEvent() {},
  onStatus(status) { stallStatuses.push(status) },
  logger() {}
})
await new Promise((resolve) => setTimeout(resolve, 200))
assert.ok(stallStatuses.some((status) => status.type === 'connected'), 'stalled stream should connect first')
assert.ok(stallStatuses.some((status) => status.type === 'reconnecting'), 'stalled stream should reconnect')
assert.ok(stallConnects > 1, `stalled stream should redial, got ${stallConnects} connects`)
stallSubscription.close()

// Browser/OS suspension can freeze the fetch reader and its watchdog timer together. A first-load
// `pageshow` must be ignored, while a real hidden -> visible transition, persisted BFCache restore or
// explicit network recovery must invalidate the pre-sleep socket immediately.
const visibilityTarget = new EventTarget()
const networkTarget = new EventTarget()
let visible = true
let wakeConnects = 0
const wakeSignals = []
const wakeSubscription = createFetchOpenCodeEventSubscription({
  url: 'http://127.0.0.1:4097/global/event',
  stallTimeoutMs: 60_000,
  lifecycle: {
    visibilityTarget,
    networkTarget,
    isVisible: () => visible
  },
  fetchFn: async (_url, init = {}) => {
    wakeConnects += 1
    wakeSignals.push(init.signal)
    const body = new ReadableStream({
      start(controller) {
        init.signal?.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
      }
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  },
  onEvent() {},
  onStatus() {},
  logger() {}
})
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(wakeConnects, 1)
networkTarget.dispatchEvent(new Event('pageshow'))
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(wakeConnects, 1, 'initial pageshow must not create a duplicate startup stream')
visible = false
visibilityTarget.dispatchEvent(new Event('visibilitychange'))
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(wakeConnects, 1, 'backgrounding must not open a replacement stream')
assert.equal(wakeSignals[0].aborted, true, 'backgrounding must abort the active request immediately')
visible = true
visibilityTarget.dispatchEvent(new Event('visibilitychange'))
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(wakeConnects, 2, 'foregrounding after a real hidden state must replace the pre-sleep stream')
visibilityTarget.dispatchEvent(new Event('visibilitychange'))
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(wakeConnects, 2, 'repeated visible events must not create duplicate streams')
const persistedPageShow = new Event('pageshow')
Object.defineProperty(persistedPageShow, 'persisted', { value: true })
networkTarget.dispatchEvent(persistedPageShow)
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(wakeConnects, 3, 'persisted BFCache restore must redial immediately')
networkTarget.dispatchEvent(new Event('online'))
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(wakeConnects, 4, 'network recovery while visible must redial immediately')
wakeSubscription.close()
networkTarget.dispatchEvent(new Event('pageshow'))
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(wakeConnects, 4, 'closed subscriptions must detach lifecycle listeners')

// A hidden document does not start a socket. Network and page lifecycle events stay inert while
// hidden, and a response from an aborted request is cancelled without publishing stale state.
const hiddenVisibilityTarget = new EventTarget()
const hiddenNetworkTarget = new EventTarget()
let hiddenVisible = false
let resolveLateFetch
let hiddenConnects = 0
let lateSignal
let cancelledLateBody = false
const hiddenStatuses = []
const hiddenEvents = []
const hiddenSubscription = createFetchOpenCodeEventSubscription({
  url: 'http://127.0.0.1:4097/global/event',
  lifecycle: {
    visibilityTarget: hiddenVisibilityTarget,
    networkTarget: hiddenNetworkTarget,
    isVisible: () => hiddenVisible
  },
  fetchFn: async (_url, init) => {
    hiddenConnects += 1
    lateSignal = init.signal
    if (hiddenConnects === 1) return await new Promise((resolve) => { resolveLateFetch = resolve })
    return new Response(new ReadableStream({ start(controller) { controller.close() } }), {
      headers: { 'content-type': 'text/event-stream' }
    })
  },
  onEvent(event) { hiddenEvents.push(event) },
  onStatus(status) { hiddenStatuses.push(status) },
  logger() {}
})
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(hiddenConnects, 0, 'hidden initial documents must not fetch')
hiddenNetworkTarget.dispatchEvent(new Event('online'))
hiddenNetworkTarget.dispatchEvent(new Event('pageshow'))
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(hiddenConnects, 0, 'hidden online and pageshow events must not fetch')
hiddenVisible = true
hiddenVisibilityTarget.dispatchEvent(new Event('visibilitychange'))
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(hiddenConnects, 1, 'becoming visible must start one subscription')
// The in-flight fetch deliberately ignores its aborted signal, like some fetch wrappers can.
// Visibility suspension must still make its eventual response stale.
hiddenVisible = false
hiddenVisibilityTarget.dispatchEvent(new Event('visibilitychange'))
assert.equal(lateSignal.aborted, true, 'hiding must abort the pending fetch immediately')
const lateBody = new ReadableStream({
  start(controller) { controller.enqueue(encoder.encode(`data: ${globalSessionCreated}\n\n`)) },
  cancel() { cancelledLateBody = true }
})
resolveLateFetch(new Response(lateBody, { headers: { 'content-type': 'text/event-stream' } }))
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(cancelledLateBody, true, 'late response body must be cancelled')
assert.equal(hiddenStatuses.some((status) => status.type === 'connected'), false, 'late response must not publish connected')
assert.equal(hiddenEvents.length, 0, 'late response must not publish events')
hiddenNetworkTarget.dispatchEvent(new Event('online'))
hiddenNetworkTarget.dispatchEvent(new Event('pageshow'))
await new Promise((resolve) => setTimeout(resolve, 20))
assert.equal(hiddenConnects, 1, 'hidden network events must not reconnect after suspension')
hiddenVisible = true
hiddenVisibilityTarget.dispatchEvent(new Event('visibilitychange'))
await new Promise((resolve) => setTimeout(resolve, 10))
assert.equal(hiddenConnects, 2, 'visible transition must resume a suspended subscription once')
hiddenSubscription.close()

// A retry queued before backgrounding is cancelled and cannot fire on its old delay. Hide as soon
// as the retry is queued: Windows timer granularity can stretch an extra 0ms hop past the 15ms
// retry delay, which would let the retry fire while still visible and prove nothing about the
// cancellation this scenario is actually testing.
const retryVisibilityTarget = new EventTarget()
const retryNetworkTarget = new EventTarget()
let retryVisible = true
let retryConnects = 0
let retryQueued
const retryQueuedPromise = new Promise((resolve) => { retryQueued = resolve })
const retrySubscription = createFetchOpenCodeEventSubscription({
  url: 'http://127.0.0.1:4097/global/event',
  reconnect: { initialDelayMs: 15, maxDelayMs: 15 },
  lifecycle: {
    visibilityTarget: retryVisibilityTarget,
    networkTarget: retryNetworkTarget,
    isVisible: () => retryVisible
  },
  fetchFn: async () => {
    retryConnects += 1
    return new Response(new ReadableStream({ start(controller) { controller.close() } }), {
      headers: { 'content-type': 'text/event-stream' }
    })
  },
  onEvent() {},
  onStatus(status) { if (status.type === 'reconnecting') retryQueued() },
  logger() {}
})
await retryQueuedPromise
assert.equal(retryConnects, 1)
retryVisible = false
retryVisibilityTarget.dispatchEvent(new Event('visibilitychange'))
retryNetworkTarget.dispatchEvent(new Event('online'))
await new Promise((resolve) => setTimeout(resolve, 30))
assert.equal(retryConnects, 1, 'cancelled hidden retry must not reconnect later')
retrySubscription.close()

console.log('OpenCode event subscription tests passed')
