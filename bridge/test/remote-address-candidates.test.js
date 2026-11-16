import assert from "node:assert/strict"
import test from "node:test"
import { remoteAddressCandidates } from "../src/remote-address-candidates.js"

const interfaces = {
  zeta: [
    { address: "192.168.1.21", family: "IPv4", internal: false },
    { address: "2001:db8::1", family: "IPv6", internal: false },
    { address: "2606:4700:4700::1111", family: "IPv6", internal: false },
    { address: "fe80::21%en0", family: "IPv6", internal: false },
    { address: "fd00::21", family: "IPv6", internal: false },
    { address: "ff02::1", family: "IPv6", internal: false },
    { address: "::1", family: "IPv6", internal: true }
  ],
  alpha: [
    { address: "10.0.0.8", family: 4, internal: false },
    { address: "172.16.0.2", family: 4, internal: false },
    { address: "8.8.8.8", family: 4, internal: false },
    { address: "127.0.0.1", family: 4, internal: false },
    { address: "2001:4860:4860::8888", family: 6, internal: false },
    { address: "2001:4860::192.0.2.1", family: 6, internal: false },
    { address: "::1", family: 6, internal: false }
  ]
}

test("returns sorted LAN IPv4 and global IPv6 HTTPS candidates only", () => {
  assert.deepEqual(remoteAddressCandidates({ interfaces, port: 4097, now: 100 }), [
    "https://10.0.0.8:4097",
    "https://172.16.0.2:4097",
    "https://192.168.1.21:4097",
    "https://[2001:4860:4860::8888]:4097",
    "https://[2606:4700:4700::1111]:4097"
  ])
})

test("adds only an active, unexpired, global IPv4 TCP mapping lease", () => {
  const lease = {
    state: "active", transport: "tcp", externalAddress: "93.184.216.34",
    externalPort: 48001, expiresAt: 200
  }
  assert.deepEqual(remoteAddressCandidates({ interfaces: {}, port: 4097, mappingLease: lease, now: 100 }), [
    "https://93.184.216.34:48001"
  ])

  for (const invalidLease of [
    { ...lease, state: "idle" },
    { ...lease, expiresAt: 100 },
    { ...lease, transport: "udp" },
    { ...lease, externalAddress: "192.0.2.8" },
    { ...lease, externalAddress: "10.0.0.1" },
    { ...lease, externalPort: 0 }
  ]) {
    assert.deepEqual(remoteAddressCandidates({ interfaces: {}, port: 4097, mappingLease: invalidLease, now: 100 }), [])
  }
})

test("deduplicates interface entries and validates the configured remote port", () => {
  const duplicated = {
    ...interfaces,
    beta: [{ address: "192.168.1.21", family: "IPv4", internal: false }]
  }
  const candidates = remoteAddressCandidates({ interfaces: duplicated, port: 443, now: 100 })
  assert.equal(candidates.filter((value) => value === "https://192.168.1.21:443").length, 1)
  assert.throws(() => remoteAddressCandidates({ interfaces: duplicated, port: 65_536 }), /port must be/)
})

test("loopback preview returns only the adb-reversible loopback endpoint", () => {
  assert.deepEqual(remoteAddressCandidates({ interfaces, port: 4497, mappingLease: {
    state: "active", transport: "tcp", externalAddress: "93.184.216.34", externalPort: 48001, expiresAt: 200
  }, now: 100, loopbackOnly: true }), ["https://127.0.0.1:4497"])
})
