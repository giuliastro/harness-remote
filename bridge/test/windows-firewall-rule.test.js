import assert from "node:assert/strict"
import test from "node:test"
import { allowNodeThroughWindowsFirewall, firewallRuleCommand } from "../src/windows-firewall-rule.js"

const NODE = "C:\Program Files\nodejs\node.exe"

test("the firewall rule replaces any previous rule for this Node and allows inbound on every profile", () => {
  const command = firewallRuleCommand(NODE)
  assert.match(command, /^netsh advfirewall firewall delete rule name="Harness Remote \(Node\.js\)" program="C:\Program Files\nodejs\node\.exe" & /)
  assert.match(command, /add rule name="Harness Remote \(Node\.js\)" program="C:\Program Files\nodejs\node\.exe" dir=in action=allow enable=yes profile=any$/)
})

test("allowing the firewall elevates once and reports the outcome", () => {
  let call
  const ok = allowNodeThroughWindowsFirewall({
    program: NODE,
    platform: "win32",
    run: (file, args, options) => { call = { file, script: args.at(-1), command: options.env.HR_FIREWALL_COMMAND }; return { status: 0 } }
  })
  assert.equal(ok.ok, true)
  assert.equal(call.file, "powershell.exe")
  assert.match(call.script, /-Verb RunAs/)
  assert.doesNotMatch(call.script, /nodejs/, "the program path must not be interpolated into PowerShell source")
  assert.equal(call.command, firewallRuleCommand(NODE))

  const denied = allowNodeThroughWindowsFirewall({ program: NODE, platform: "win32", run: () => ({ status: 1 }) })
  assert.equal(denied.ok, false)
  assert.match(denied.message, /not changed/)
})

test("--allow-firewall changes nothing outside Windows", () => {
  let ran = false
  const result = allowNodeThroughWindowsFirewall({ platform: "linux", run: () => { ran = true; return { status: 0 } } })
  assert.equal(ran, false)
  assert.equal(result.ok, false)
  assert.match(result.message, /only applies to Windows/)
})
