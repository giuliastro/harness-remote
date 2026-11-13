import assert from "node:assert/strict"
import test from "node:test"
import { createNatPmpAdapter, createPcpAdapter, createPortMappingManager, createUpnpIgdAdapter } from "../src/port-mapping.js"

function fakeAdapter(protocol, { externalAddress = "203.0.113.20", externalPort = 48001 } = {}) {
  const calls = []
  const adapter = {
    protocol,
    calls,
    async discover() { calls.push(["discover"]); return { router: "test-router" } },
    async add(args) {
      calls.push(["add", args])
      return { protocol, externalAddress, externalPort, ownerToken: args.ownerToken, expiresAt: 123456 }
    },
    async renew(args) {
      calls.push(["renew", args])
      return { ...args.lease, expiresAt: 123999 }
    },
    async remove(args) { calls.push(["remove", args]) }
  }
  return adapter
}

test("port mapping stays disabled until secure transport is explicitly ready", async () => {
  const adapter = fakeAdapter("pcp")
  const manager = createPortMappingManager({ adapters: [adapter] })
  await assert.rejects(manager.acquire({ internalPort: 4097 }), { code: "SECURE_TRANSPORT_REQUIRED" })
  assert.deepEqual(adapter.calls, [])
  assert.equal(manager.diagnostics().state, "idle")
})

test("acquire, renew and remove operate only on the manager-owned lease", async () => {
  const logs = []
  const adapter = fakeAdapter("upnp-igd")
  const manager = createPortMappingManager({
    adapters: [adapter], secureTransportReady: true, ownerToken: "test-owner", logger: (entry) => logs.push(entry)
  })

  const acquired = await manager.acquire({ internalPort: 4097, transport: "tcp", lifetimeSeconds: 900 })
  assert.equal(acquired.state, "active")
  assert.equal(acquired.protocol, "upnp-igd")
  assert.equal(acquired.externalPort, 48001)
  assert.equal(adapter.calls[1][1].ownerToken, "test-owner")

  const renewed = await manager.renew({ lifetimeSeconds: 1800 })
  assert.equal(renewed.state, "active")
  assert.equal(renewed.expiresAt, 123999)
  assert.equal(adapter.calls[2][1].lease.ownerToken, "test-owner")

  const removed = await manager.remove()
  assert.equal(removed.state, "removed")
  assert.equal(adapter.calls[3][0], "remove")
  assert.equal(adapter.calls[3][1].lease.externalPort, 48001)
  assert.equal(adapter.calls[3][1].ownerToken, "test-owner")
  assert.deepEqual(logs.map(({ event }) => event), ["mapping-created", "mapping-renewed", "mapping-removed"])
  assert.equal(JSON.stringify(manager.diagnostics()).includes("test-owner"), false)
})

test("tries protocols in order and records unavailable routers without failing startup", async () => {
  const absent = { protocol: "pcp", discover: async () => null, add() {}, renew() {}, remove() {} }
  const natPmp = fakeAdapter("nat-pmp")
  const manager = createPortMappingManager({ adapters: [absent, natPmp], secureTransportReady: true })
  const result = await manager.acquire({ internalPort: 3000 })
  assert.equal(result.protocol, "nat-pmp")
  assert.deepEqual(result.attempts, [
    { protocol: "pcp", result: "not-found" },
    { protocol: "nat-pmp", result: "mapped" }
  ])
})

test("rejects renewal if an adapter changes the mapping identity", async () => {
  const adapter = fakeAdapter("pcp")
  adapter.renew = async (args) => ({ ...args.lease, externalPort: args.lease.externalPort + 1 })
  const manager = createPortMappingManager({ adapters: [adapter], secureTransportReady: true })
  await manager.acquire({ internalPort: 3000 })
  await assert.rejects(manager.renew(), { code: "MAPPING_IDENTITY_CHANGED" })
  assert.equal(manager.diagnostics().state, "renewal-failed")
  assert.equal(manager.diagnostics().externalPort, 48001)
})

test("rejects leases that cannot prove protocol ownership", async () => {
  const adapter = fakeAdapter("nat-pmp")
  adapter.add = async () => ({ protocol: "nat-pmp", externalAddress: "203.0.113.20", externalPort: 48001 })
  const manager = createPortMappingManager({ adapters: [adapter], secureTransportReady: true })
  const result = await manager.acquire({ internalPort: 3000 })
  assert.equal(result.state, "unavailable")
  assert.equal(result.attempts[0].code, "INVALID_MAPPING_LEASE")
  assert.equal(manager.diagnostics().externalPort, null)
})

test("validates requested mapping parameters", async () => {
  const manager = createPortMappingManager({ adapters: [], secureTransportReady: true })
  await assert.rejects(manager.acquire({ internalPort: 0 }), { code: "INVALID_PORT" })
  await assert.rejects(manager.acquire({ internalPort: 65536 }), { code: "INVALID_PORT" })
  await assert.rejects(manager.acquire({ internalPort: 80, transport: "sctp" }), { code: "INVALID_TRANSPORT" })
  await assert.rejects(manager.acquire({ internalPort: 80, lifetimeSeconds: 10 }), { code: "INVALID_LIFETIME" })
})

function mockedIgd({ occupied = false, externalAddress = "8.8.8.8", location = "http://192.168.1.1/description.xml", controlURL = "/upnp/control/WANIPConn1" } = {}) {
  let stored = occupied ? {
    NewPortMappingDescription: "OtherApplication:owned",
    NewInternalClient: "192.168.1.60",
    NewInternalPort: "88"
  } : null
  const actions = []
  const httpRequest = async (url, options = {}) => {
    if (url === "http://192.168.1.1/description.xml") {
      return {
        statusCode: 200,
        body: `<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>${controlURL}</controlURL></service></serviceList></device></root>`
      }
    }
    assert.equal(url, "http://192.168.1.1/upnp/control/WANIPConn1")
    const action = options.headers.SOAPAction.match(/#(\w+)"$/)?.[1]
    actions.push(action)
    const args = Object.fromEntries([...options.body.matchAll(/<([A-Za-z]+)>(.*?)<\/\1>/g)].map((match) => [match[1], match[2]]))
    if (action === "GetSpecificPortMappingEntry") {
      if (stored) return { statusCode: 200, body: `<NewPortMappingDescription>${stored.NewPortMappingDescription}</NewPortMappingDescription><NewInternalClient>${stored.NewInternalClient}</NewInternalClient><NewInternalPort>${stored.NewInternalPort}</NewInternalPort>` }
      return { statusCode: 500, body: "<UPnPError><errorCode>714</errorCode></UPnPError>" }
    }
    if (action === "AddPortMapping") {
      stored = { ...args }
      return { statusCode: 200, body: "" }
    }
    if (action === "GetExternalIPAddress") return { statusCode: 200, body: `<NewExternalIPAddress>${externalAddress}</NewExternalIPAddress>` }
    if (action === "DeletePortMapping") return { statusCode: 200, body: "" }
    throw new Error(`Unexpected SOAP action ${action}`)
  }
  return {
    actions,
    replaceEntry(value) { stored = value },
    adapter: createUpnpIgdAdapter({
      localAddress: "192.168.1.20",
      ssdpSearch: async () => [{ location, sourceAddress: "192.168.1.1" }],
      httpRequest,
      chooseExternalPort: () => 45123
    })
  }
}

test("built-in UPnP adapter discovers a mocked IGD, adds, renews, and removes its marked lease", async () => {
  const mocked = mockedIgd()
  const manager = createPortMappingManager({ adapters: [mocked.adapter], secureTransportReady: true, ownerToken: "unit-test-owner" })
  const acquired = await manager.acquire({ internalPort: 4097, lifetimeSeconds: 600 })
  assert.equal(acquired.state, "active")
  assert.equal(acquired.protocol, "upnp-igd")
  assert.equal(acquired.externalAddress, "8.8.8.8")
  assert.equal(acquired.externalPort, 45123)
  await manager.renew({ lifetimeSeconds: 900 })
  assert.equal((await manager.remove()).state, "removed")
  assert.deepEqual(mocked.actions, [
    "GetSpecificPortMappingEntry", "AddPortMapping", "GetExternalIPAddress",
    "GetSpecificPortMappingEntry", "AddPortMapping", "GetSpecificPortMappingEntry", "DeletePortMapping"
  ])
})

test("built-in UPnP adapter leaves an existing unrelated router mapping untouched", async () => {
  const mocked = mockedIgd({ occupied: true })
  const manager = createPortMappingManager({ adapters: [mocked.adapter], secureTransportReady: true, ownerToken: "other-owner" })
  const result = await manager.acquire({ internalPort: 4097, externalPort: 45123 })
  assert.equal(result.state, "unavailable")
  assert.equal(result.attempts[0].code, "UPNP_PORT_IN_USE")
  assert.deepEqual(mocked.actions, ["GetSpecificPortMappingEntry"])
})

test("built-in UPnP adapter refuses cleanup after another actor replaces its mapping", async () => {
  const mocked = mockedIgd()
  const manager = createPortMappingManager({ adapters: [mocked.adapter], secureTransportReady: true, ownerToken: "cleanup-owner" })
  await manager.acquire({ internalPort: 4097 })
  mocked.replaceEntry({
    NewPortMappingDescription: "OtherApplication:replacement",
    NewInternalClient: "192.168.1.99",
    NewInternalPort: "4098"
  })
  await assert.rejects(manager.remove(), { code: "UPNP_OWNERSHIP_LOST" })
  assert.equal(mocked.actions.includes("DeletePortMapping"), false)
})

test("built-in UPnP adapter rolls back its owned mapping when the router reports a non-global address", async () => {
  const mocked = mockedIgd({ externalAddress: "100.64.12.34" })
  const manager = createPortMappingManager({ adapters: [mocked.adapter], secureTransportReady: true, ownerToken: "rollback-owner" })
  const result = await manager.acquire({ internalPort: 4097 })
  assert.equal(result.state, "unavailable")
  assert.equal(result.attempts[0].code, "UPNP_EXTERNAL_ADDRESS_NOT_GLOBAL")
  assert.equal(mocked.actions.at(-1), "DeletePortMapping")
})

test("built-in UPnP adapter rejects SSDP locations outside the LAN responder origin", async () => {
  const mocked = mockedIgd({ location: "http://192.168.1.99/description.xml" })
  const router = await mocked.adapter.discover()
  assert.equal(router, null)
  assert.deepEqual(mocked.actions, [])
})

test("built-in UPnP adapter rejects non-HTTP SSDP locations", async () => {
  const mocked = mockedIgd({ location: "https://192.168.1.1/description.xml" })
  const router = await mocked.adapter.discover()
  assert.equal(router, null)
  assert.deepEqual(mocked.actions, [])
})

test("built-in UPnP adapter rejects cross-origin control URLs from the description", async () => {
  const mocked = mockedIgd({ controlURL: "http://192.168.1.99:8080/control" })
  const router = await mocked.adapter.discover()
  assert.equal(router, null)
  assert.deepEqual(mocked.actions, [])
})

function natPmpResponse(request) {
  if (request.length === 2 && request[1] === 0) {
    return Buffer.from([0, 128, 0, 0, 0, 0, 0, 1, 8, 8, 8, 8])
  }
  const opcode = request[1]
  const response = Buffer.alloc(16)
  response[0] = 0
  response[1] = opcode + 128
  response.writeUInt16BE(0, 2)
  response.writeUInt32BE(1, 4)
  response.writeUInt16BE(request.readUInt16BE(4), 8)
  response.writeUInt16BE(request.readUInt16BE(6) || 48222, 10)
  response.writeUInt32BE(request.readUInt32BE(8), 12)
  return response
}

test("NAT-PMP adapter obtains, renews, and removes only its router-assigned port tuple", async () => {
  const packets = []
  const adapter = createNatPmpAdapter({
    gatewayAddress: "192.168.1.1", localAddress: "192.168.1.20",
    exchange: async ({ gatewayAddress, request }) => {
      assert.equal(gatewayAddress, "192.168.1.1")
      packets.push(Buffer.from(request))
      return natPmpResponse(request)
    }
  })
  const manager = createPortMappingManager({ adapters: [adapter], secureTransportReady: true, ownerToken: "natpmp-test" })
  const acquired = await manager.acquire({ internalPort: 4097, lifetimeSeconds: 600 })
  assert.equal(acquired.protocol, "nat-pmp")
  assert.equal(acquired.externalAddress, "8.8.8.8")
  assert.equal(acquired.externalPort, 48222)
  assert.equal(acquired.cleanupMode, "lease-expiry")
  assert.match(acquired.limitations[0], /no per-mapping ownership token/)
  assert.equal(packets[1].readUInt16BE(6), 0, "ask the router to allocate an unused external port")
  assert.equal(packets[1].readUInt32BE(8), 300, "bound NAT-PMP leases to five minutes")
  await manager.renew({ lifetimeSeconds: 900 })
  assert.equal(packets[3].readUInt16BE(6), 48222)
  assert.equal(packets[3].readUInt32BE(8), 300)
  const released = await manager.remove()
  assert.equal(packets.length, 4, "shutdown must not send a destructive zero-lifetime request")
  assert.equal(released.state, "lease-expiring")
  assert.equal(released.cleanupMode, "lease-expiry")
  assert.match(released.limitations[0], /no per-mapping ownership token/)
  assert.ok(Number.isFinite(released.expiresAt))
})

function pcpResponse(request, { externalAddress = "8.8.4.4", nonceOverride } = {}) {
  const response = Buffer.alloc(60)
  response[0] = 2
  response[1] = 0x81
  response[3] = 0
  response.writeUInt32BE(request.readUInt32BE(4), 4)
  const nonce = nonceOverride ?? request.subarray(24, 36)
  nonce.copy(response, 24)
  response[36] = request[36]
  response.writeUInt16BE(request.readUInt16BE(40), 40)
  response.writeUInt16BE(request.readUInt16BE(42) || 48223, 42)
  response.set([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 44)
  response.set(externalAddress.split(".").map(Number), 56)
  return response
}

test("PCP adapter binds renewal and deletion to the same nonce and mapping", async () => {
  const packets = []
  const adapter = createPcpAdapter({
    gatewayAddress: "192.168.1.1", localAddress: "192.168.1.20", nonceFactory: () => Buffer.alloc(12, 0xab),
    exchange: async ({ gatewayAddress, request }) => {
      assert.equal(gatewayAddress, "192.168.1.1")
      packets.push(Buffer.from(request))
      return pcpResponse(request)
    }
  })
  const manager = createPortMappingManager({ adapters: [adapter], secureTransportReady: true, ownerToken: "pcp-test" })
  const acquired = await manager.acquire({ internalPort: 4097, lifetimeSeconds: 600 })
  assert.equal(acquired.protocol, "pcp")
  assert.equal(acquired.externalAddress, "8.8.4.4")
  assert.equal(acquired.externalPort, 48223)
  assert.deepEqual([...packets[0].subarray(24, 36)], Array(12).fill(0xab))
  await manager.renew({ lifetimeSeconds: 900 })
  await manager.remove()
  assert.deepEqual(packets[0].subarray(24, 36), packets[1].subarray(24, 36))
  assert.deepEqual(packets[1].subarray(24, 36), packets[2].subarray(24, 36))
  assert.equal(packets[2].readUInt32BE(4), 0)
})

test("PCP adapter rejects nonce mismatches and non-global external IPv4", async () => {
  for (const makeResponse of [
    (request) => pcpResponse(request, { nonceOverride: Buffer.alloc(12, 0xff) }),
    (request) => pcpResponse(request, { externalAddress: "192.168.1.1" })
  ]) {
    const adapter = createPcpAdapter({
      gatewayAddress: "192.168.1.1", localAddress: "192.168.1.20", nonceFactory: () => Buffer.alloc(12, 0xaa),
      exchange: async ({ request }) => makeResponse(request)
    })
    const manager = createPortMappingManager({ adapters: [adapter], secureTransportReady: true })
    const result = await manager.acquire({ internalPort: 4097 })
    assert.equal(result.state, "unavailable")
    assert.ok(["PCP_IDENTITY_MISMATCH", "PCP_EXTERNAL_ADDRESS_NOT_GLOBAL"].includes(result.attempts[0].code))
  }
})

test("NAT-PMP adapter rejects a private external address", async () => {
  const adapter = createNatPmpAdapter({
    gatewayAddress: "192.168.1.1", localAddress: "192.168.1.20",
    exchange: async ({ request }) => request[1] === 0
      ? Buffer.from([0, 128, 0, 0, 0, 0, 0, 1, 192, 168, 1, 1])
      : natPmpResponse(request)
  })
  const manager = createPortMappingManager({ adapters: [adapter], secureTransportReady: true })
  const result = await manager.acquire({ internalPort: 4097 })
  assert.equal(result.state, "unavailable")
  assert.equal(result.attempts[0].code, "NAT_PMP_EXTERNAL_ADDRESS_NOT_GLOBAL")
})
