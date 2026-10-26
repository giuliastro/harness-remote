import assert from "node:assert/strict"
import test from "node:test"
import { blockedFirewallProfiles, firewallWarningMessage, readFirewallSnapshot, windowsFirewallWarning } from "../src/windows-firewall.js"

const NODE = "C:\\Program Files\\nodejs\\node.exe"
const firewall = [
  { name: "Domain", enabled: "True", inbound: "Block" },
  { name: "Private", enabled: "True", inbound: "NotConfigured" },
  { name: "Public", enabled: "True", inbound: "NotConfigured" }
]

test("a Node allowed only on Public is blocked on an active Private network", () => {
  // The machine this was reported on: Windows asked once on a public network and the rule stuck.
  const snapshot = { profiles: ["Private"], firewall, rules: [{ action: "Allow", profile: "Public" }, { action: "Allow", profile: "Public" }] }
  assert.deepEqual(blockedFirewallProfiles(snapshot), [{ profile: "Private", explicitBlock: false }])
  const message = firewallWarningMessage(NODE, blockedFirewallProfiles(snapshot))
  assert.match(message, /Windows Firewall blocks incoming connections/)
  assert.match(message, /active Private network/)
  assert.match(message, /New-NetFirewallRule .*-Profile Private -Program "C:\\Program Files\\nodejs\\node\.exe"/)
})

test("an allow rule for the active profile, Any, or a disabled firewall raises no warning", () => {
  assert.deepEqual(blockedFirewallProfiles({ profiles: ["Private"], firewall, rules: [{ action: "Allow", profile: "Private, Public" }] }), [])
  assert.deepEqual(blockedFirewallProfiles({ profiles: ["Private"], firewall, rules: [{ action: "Allow", profile: "Any" }] }), [])
  assert.deepEqual(blockedFirewallProfiles({
    profiles: ["Private"],
    firewall: [{ name: "Private", enabled: "False", inbound: "NotConfigured" }],
    rules: []
  }), [])
  assert.deepEqual(blockedFirewallProfiles({
    profiles: ["Private"],
    firewall: [{ name: "Private", enabled: "True", inbound: "Allow" }],
    rules: []
  }), [])
  assert.equal(firewallWarningMessage(NODE, []), null)
})

test("an explicit block wins over an allow and points to the blocking rule", () => {
  const blocked = blockedFirewallProfiles({
    profiles: ["Private"],
    firewall,
    rules: [{ action: "Allow", profile: "Private" }, { action: "Block", profile: "Any" }]
  })
  assert.deepEqual(blocked, [{ profile: "Private", explicitBlock: true }])
  const message = firewallWarningMessage(NODE, blocked)
  assert.match(message, /explicitly blocks/)
  assert.doesNotMatch(message, /New-NetFirewallRule/)
})

test("PowerShell's single-object JSON shapes are accepted", () => {
  // ConvertTo-Json collapses one-element arrays in some PowerShell versions.
  assert.deepEqual(blockedFirewallProfiles({ profiles: "Private", firewall, rules: { action: "Allow", profile: "Public" } }), [{ profile: "Private", explicitBlock: false }])
  assert.deepEqual(blockedFirewallProfiles(null), [])
})

test("the check only runs on Windows for a network-reachable bind", async () => {
  let reads = 0
  const readSnapshot = async () => {
    reads += 1
    return { profiles: ["Private"], firewall, rules: [] }
  }
  assert.equal(await windowsFirewallWarning({ host: "0.0.0.0", platform: "linux", readSnapshot }), null)
  assert.equal(await windowsFirewallWarning({ host: "127.0.0.1", platform: "win32", readSnapshot }), null)
  assert.equal(reads, 0)
  assert.match(await windowsFirewallWarning({ host: "0.0.0.0", program: NODE, platform: "win32", readSnapshot }), /Private/)
  assert.equal(await windowsFirewallWarning({ host: "0.0.0.0", program: NODE, platform: "win32", readSnapshot: async () => null }), null)
})

test("the snapshot reader passes the program through the environment and stays silent on failure", async () => {
  let received
  const ok = await readFirewallSnapshot(NODE, {
    run: (file, args, options, callback) => {
      received = { file, script: args.at(-1), program: options.env.HR_FIREWALL_PROGRAM }
      callback(null, '{"profiles":["Private"],"firewall":[],"rules":[]}\n')
    }
  })
  assert.deepEqual(ok, { profiles: ["Private"], firewall: [], rules: [] })
  assert.equal(received.file, "powershell.exe")
  assert.equal(received.program, NODE)
  assert.doesNotMatch(received.script, /nodejs/, "the path must not be interpolated into the script")
  assert.equal(await readFirewallSnapshot(NODE, { run: (_f, _a, _o, callback) => callback(new Error("denied")) }), null)
  assert.equal(await readFirewallSnapshot(NODE, { run: (_f, _a, _o, callback) => callback(null, "not json") }), null)
})
