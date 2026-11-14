import assert from "node:assert/strict"
import { test } from "node:test"
import { remotePairingLinks, remotePairingURI } from "../src/remote-pairing.js"

const identity = {
  grant: { token: "a".repeat(43), expiresAt: 1_900_000_000_000 },
  machineID: "machine-123",
  dnsName: `m-${"b".repeat(32)}.${"c".repeat(32)}.machine.harness-remote.invalid`,
  pin: "d".repeat(64),
  name: "Studio PC"
}

test("remote QR carries a pinned HTTPS machine identity and a one-time token", () => {
  const uri = remotePairingURI({ endpoint: "https://192.168.1.20:4497", ...identity })
  const parsed = new URL(uri)
  assert.equal(parsed.hostname, "remote-pair")
  assert.equal(parsed.searchParams.get("endpoint"), "https://192.168.1.20:4497")
  assert.equal(parsed.searchParams.get("token"), identity.grant.token)
  assert.equal(parsed.searchParams.get("pin"), identity.pin)
  assert.throws(() => remotePairingURI({ endpoint: "http://192.168.1.20:4497", ...identity }), /Invalid remote pairing link/)
  assert.throws(() => remotePairingURI({ endpoint: "https://192.168.1.20:4497", ...identity, pin: "bad" }), /Invalid remote pairing link/)
})

test("remote QR uses discovered LAN addresses without publishing Basic credentials", () => {
  const links = remotePairingLinks({ host: "0.0.0.0", port: 4497, ...identity,
    interfaces: { wlan0: [{ family: "IPv4", internal: false, address: "192.168.1.20" }] } })
  assert.equal(links.length, 1)
  assert.equal(links[0].endpoint, "https://192.168.1.20:4497")
  assert.ok(!links[0].uri.includes("password"))
})
