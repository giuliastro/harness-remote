import assert from 'node:assert/strict'
import { createSharedBrowserEventSubscriptions } from './shared-browser-event-stream.ts'

function fakeConnect() {
  const transports = []
  const connect = (options) => {
    const transport = {
      options,
      closeCalls: 0,
      emitEvent(event) { options.onEvent(event) },
      emitStatus(status) { options.onStatus?.(status) },
      close() { this.closeCalls += 1 }
    }
    transports.push(transport)
    return transport
  }
  return { connect, transports }
}

// Equivalent header identities share one live stream; status is replayed, but
// events that happened before subscription are never replayed.
{
  const { connect, transports } = fakeConnect()
  const shared = createSharedBrowserEventSubscriptions(connect)
  const firstEvents = []
  const firstStatuses = []
  const secondEvents = []
  const secondStatuses = []
  const first = shared.subscribe({
    url: 'https://daemon.example/event',
    headers: { Authorization: 'Bearer secret', 'X-Harness-Backend': 'codex' },
    onEvent: (event) => firstEvents.push(event),
    onStatus: (status) => firstStatuses.push(status)
  })
  assert.equal(transports.length, 1)
  transports[0].emitStatus({ type: 'connected' })
  transports[0].emitEvent({ id: 'before-second' })
  const second = shared.subscribe({
    url: 'https://daemon.example/event',
    headers: { 'x-harness-backend': 'codex', authorization: 'Bearer secret' },
    onEvent: (event) => secondEvents.push(event),
    onStatus: (status) => secondStatuses.push(status)
  })
  assert.equal(transports.length, 1, 'header key order and casing should not create another transport')
  assert.deepEqual(secondStatuses, [{ type: 'connected' }], 'new subscriber should receive the latest status')
  assert.deepEqual(secondEvents, [], 'events must not be replayed')

  transports[0].emitEvent({ id: 'live' })
  assert.deepEqual(firstEvents.map((event) => event.id), ['before-second', 'live'])
  assert.deepEqual(secondEvents.map((event) => event.id), ['live'])
  first.close()
  first.close()
  assert.equal(transports[0].closeCalls, 0, 'closing one listener must retain the shared transport')
  transports[0].emitEvent({ id: 'after-first-close' })
  assert.deepEqual(firstEvents.map((event) => event.id), ['before-second', 'live'])
  assert.deepEqual(secondEvents.map((event) => event.id), ['live', 'after-first-close'])
  second.close()
  second.close()
  assert.equal(transports[0].closeCalls, 1, 'final close should close the transport exactly once')
  const reopened = shared.subscribe({
    url: 'https://daemon.example/event',
    headers: { authorization: 'Bearer secret', 'x-harness-backend': 'codex' },
    onEvent() {}
  })
  assert.equal(transports.length, 2, 'a subscription after final close should create a fresh transport')
  reopened.close()
}

// Credentials, backend routing values, and URLs all partition transport state.
{
  const { connect, transports } = fakeConnect()
  const shared = createSharedBrowserEventSubscriptions(connect)
  const common = { url: 'https://daemon.example/event', onEvent() {} }
  const subscriptions = [
    shared.subscribe({ ...common, headers: { Authorization: 'Bearer one', 'X-Harness-Backend': 'codex' } }),
    shared.subscribe({ ...common, headers: { Authorization: 'Bearer two', 'X-Harness-Backend': 'codex' } }),
    shared.subscribe({ ...common, headers: { Authorization: 'Bearer one', 'X-Harness-Backend': 'pi' } }),
    shared.subscribe({ ...common, url: 'https://other.example/event', headers: { Authorization: 'Bearer one', 'X-Harness-Backend': 'codex' } })
  ]
  assert.equal(transports.length, 4)
  for (const subscription of subscriptions) subscription.close()
  assert.deepEqual(transports.map((transport) => transport.closeCalls), [1, 1, 1, 1])
}

// One throwing subscriber cannot prevent fanout to another subscriber, and
// reporting failures does not leak stream identity or block delivery.
{
  const { connect, transports } = fakeConnect()
  const reported = []
  const shared = createSharedBrowserEventSubscriptions(connect, { reportError: (error) => reported.push(error) })
  const received = []
  const first = shared.subscribe({
    url: 'https://private.example/event',
    headers: { Authorization: 'Bearer private-token' },
    onEvent() { throw new Error('listener failed') },
    onStatus() { throw new Error('status listener failed') }
  })
  const second = shared.subscribe({
    url: 'https://private.example/event',
    headers: { authorization: 'Bearer private-token' },
    onEvent: (event) => received.push(event),
    onStatus: (status) => received.push(status)
  })
  assert.doesNotThrow(() => transports[0].emitEvent({ id: 'still-delivered' }))
  assert.doesNotThrow(() => transports[0].emitStatus({ type: 'connected' }))
  assert.deepEqual(received, [{ id: 'still-delivered' }, { type: 'connected' }])
  assert.deepEqual(reported.map((error) => error.message), ['listener failed', 'status listener failed'])
  first.close()
  second.close()
}

// A failed transport creation must not leave a poisoned registry entry.
{
  let attempts = 0
  const shared = createSharedBrowserEventSubscriptions(() => {
    attempts += 1
    if (attempts === 1) throw new Error('initial creation failed')
    return { close() {} }
  })
  const options = { url: 'https://daemon.example/event', onEvent() {} }
  assert.throws(() => shared.subscribe(options), /initial creation failed/)
  const retry = shared.subscribe(options)
  assert.equal(attempts, 2, 'failed creation should be removed so a later call retries')
  retry.close()
}

console.log('Shared browser event stream tests passed')
