import { spawnSync } from "node:child_process"

export const FIREWALL_RULE_NAME = "Harness Remote (Node.js)"

/**
 * One rule per Node executable, replaced rather than duplicated on repeated use. It covers every
 * network profile because Windows marks most new Wi-Fi networks Public, where a Private-only rule
 * would not let the phone in.
 */
export function firewallRuleCommand(program) {
  const rule = `name="${FIREWALL_RULE_NAME}" program="${program}"`
  return `netsh advfirewall firewall delete rule ${rule} & netsh advfirewall firewall add rule ${rule} dir=in action=allow enable=yes profile=any`
}

/**
 * Explicit, user-requested change: Windows shows its administrator prompt. The command travels
 * through the environment so the program path is never interpolated into PowerShell source.
 */
export function allowNodeThroughWindowsFirewall({
  program = process.execPath,
  platform = process.platform,
  run = spawnSync
} = {}) {
  if (platform !== "win32") return { ok: false, message: "--allow-firewall only applies to Windows; nothing was changed." }
  const script = "$p = Start-Process -FilePath cmd.exe -ArgumentList ('/d /s /c \"' + $env:HR_FIREWALL_COMMAND + '\"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode"
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    env: { ...process.env, HR_FIREWALL_COMMAND: firewallRuleCommand(program) },
    windowsHide: true,
    encoding: "utf8"
  })
  if (result.status === 0) return { ok: true, message: `Windows Firewall now allows incoming connections to ${program}.` }
  return { ok: false, message: "Windows Firewall was not changed (administrator permission was not granted)." }
}
