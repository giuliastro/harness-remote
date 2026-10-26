import { execFile } from "node:child_process"

const SNAPSHOT_TIMEOUT_MS = 10_000
const LOOPBACK_HOST = /^(localhost|::1|\[::1\]|127(?:\.\d{1,3}){3})$/i

// Read-only. The program path travels through the environment, never through the script text.
const SNAPSHOT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$program = $env:HR_FIREWALL_PROGRAM
$profiles = @(Get-NetConnectionProfile | ForEach-Object { if ([string]$_.NetworkCategory -eq 'DomainAuthenticated') { 'Domain' } else { [string]$_.NetworkCategory } } | Select-Object -Unique)
$firewall = @(Get-NetFirewallProfile | ForEach-Object { [ordered]@{ name = [string]$_.Name; enabled = [string]$_.Enabled; inbound = [string]$_.DefaultInboundAction } })
$rules = @(Get-NetFirewallApplicationFilter -Program $program -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { [string]$_.Direction -eq 'Inbound' -and [string]$_.Enabled -eq 'True' } | ForEach-Object { [ordered]@{ action = [string]$_.Action; profile = [string]$_.Profile } })
[ordered]@{ profiles = $profiles; firewall = $firewall; rules = $rules } | ConvertTo-Json -Compress -Depth 4
`

function list(value) {
  if (Array.isArray(value)) return value
  return value === undefined || value === null ? [] : [value]
}

function covers(ruleProfile, profile) {
  const profiles = String(ruleProfile ?? "").split(",").map((entry) => entry.trim().toLowerCase())
  return profiles.includes("any") || profiles.includes(profile.toLowerCase())
}

/**
 * Active network profiles on which Windows Firewall drops inbound connections to `program`.
 * A profile with the firewall off or with a default Allow is open; otherwise an enabled program
 * Block wins, and only an enabled program Allow for that profile lets a phone through.
 */
export function blockedFirewallProfiles(snapshot) {
  const firewall = new Map(list(snapshot?.firewall).map((entry) => [String(entry?.name).toLowerCase(), entry]))
  const rules = list(snapshot?.rules)
  const blocked = []
  for (const profile of list(snapshot?.profiles).map(String)) {
    const state = firewall.get(profile.toLowerCase())
    if (!state || String(state.enabled) === "False" || String(state.inbound) === "Allow") continue
    const applicable = rules.filter((rule) => covers(rule?.profile, profile))
    if (applicable.some((rule) => rule?.action === "Block")) blocked.push({ profile, explicitBlock: true })
    else if (!applicable.some((rule) => rule?.action === "Allow")) blocked.push({ profile, explicitBlock: false })
  }
  return blocked
}

export function firewallWarningMessage(program, blocked) {
  if (!blocked.length) return null
  const profiles = blocked.map((entry) => entry.profile).join(", ")
  const lines = [
    "",
    `Warning: Windows Firewall blocks incoming connections to ${program} on the active ${profiles} network.`,
    "A phone cannot reach this machine, so QR pairing and remote access will fail as unreachable."
  ]
  if (blocked.some((entry) => entry.explicitBlock)) {
    lines.push(`A firewall rule explicitly blocks this program. Remove or disable it in "Windows Defender Firewall with Advanced Security" → Inbound Rules.`)
  } else {
    lines.push(
      "Allow it once from an administrator PowerShell:",
      `  New-NetFirewallRule -DisplayName "Harness Remote (Node.js)" -Direction Inbound -Action Allow -Profile ${blocked.map((entry) => entry.profile).join(",")} -Program "${program}"`
    )
  }
  return `${lines.join("\n")}\n`
}

export function readFirewallSnapshot(program, { run = execFile } = {}) {
  return new Promise((resolve) => {
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SNAPSHOT_SCRIPT], {
      timeout: SNAPSHOT_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, HR_FIREWALL_PROGRAM: program }
    }, (error, stdout) => {
      if (error) return resolve(null)
      try {
        resolve(JSON.parse(String(stdout).trim()))
      } catch {
        resolve(null)
      }
    })
  })
}

/**
 * Best-effort startup diagnostic. A firewall drop is invisible from this machine (local connections
 * bypass it) and shows up on the phone only as a timeout, so name it where the user launched the
 * runtime. Any failure to read the configuration stays silent rather than guessing.
 */
export async function windowsFirewallWarning({
  host,
  program = process.execPath,
  platform = process.platform,
  readSnapshot = readFirewallSnapshot
} = {}) {
  if (platform !== "win32" || LOOPBACK_HOST.test(String(host ?? "").trim())) return null
  const snapshot = await readSnapshot(program)
  return snapshot ? firewallWarningMessage(program, blockedFirewallProfiles(snapshot)) : null
}
