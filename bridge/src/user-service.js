import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const OWNER_MARKER = "Harness Remote managed user service v1"
const LINUX_UNIT = "harness-remote.service"
const MAC_LABEL = "com.harnessremote.gateway"
const WINDOWS_TASK = "Harness Remote Gateway"

function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options })
}

function systemdQuote(value) {
  return `"${String(value).replaceAll("%", "%%").replaceAll("$", "$$").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")
}

function windowsQuote(value) {
  const text = String(value)
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`
}

function atomicWrite(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, content, { mode })
  fs.renameSync(temporary, file)
  try { fs.chmodSync(file, mode) } catch { /* Windows ACLs inherit from the user's profile directory. */ }
}

function assertOwned(file, marker) {
  if (!fs.existsSync(file)) return false
  const body = fs.readFileSync(file, "utf8")
  if (!body.includes(marker)) throw new Error(`Refusing to modify ${file}: it exists but is not owned by Harness Remote.`)
  return true
}

function runtimeDirectory({ platform, home, localAppData }) {
  if (platform === "linux") return path.join(home, ".local", "share", "harness-remote", "runtime")
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Harness Remote", "runtime")
  if (platform === "win32") return path.join(localAppData || path.join(home, "AppData", "Local"), "HarnessRemote", "runtime")
  throw new Error("User services are supported on Linux, macOS, and Windows.")
}

function prepareRuntime({ sourceLauncherPath, runtimeDir }) {
  const sourceRoot = path.resolve(path.dirname(sourceLauncherPath), "..", "..")
  const sourceRuntime = path.join(sourceRoot, "bridge", "src")
  const rootManifest = path.join(sourceRoot, "package.json")
  const bridgeManifest = path.join(sourceRoot, "bridge", "package.json")
  if (!fs.existsSync(path.join(sourceRuntime, "launcher.js")) || !fs.existsSync(rootManifest)) {
    throw new Error(`Cannot find the Harness Remote runtime next to ${sourceLauncherPath}. Reinstall with the packaged npx command.`)
  }
  const requireFromPackage = createRequire(sourceLauncherPath)
  let qrPackage
  try {
    let candidate = requireFromPackage.resolve("qrcode-terminal")
    while (path.dirname(candidate) !== candidate && !fs.existsSync(path.join(candidate, "package.json"))) candidate = path.dirname(candidate)
    if (!fs.existsSync(path.join(candidate, "package.json"))) throw new Error("package.json not found")
    qrPackage = candidate
  } catch {
    throw new Error("Cannot locate the gateway's qrcode-terminal runtime dependency; reinstall the package before installing the service.")
  }

  if (fs.existsSync(runtimeDir)) {
    if (!assertOwned(path.join(runtimeDir, ".harness-remote-runtime"), OWNER_MARKER)) {
      throw new Error(`Refusing to replace ${runtimeDir}: it exists but is not owned by Harness Remote.`)
    }
    fs.rmSync(runtimeDir, { recursive: true, force: true })
  }
  const parent = path.dirname(runtimeDir)
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  const staging = `${runtimeDir}.${process.pid}.staging`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(path.join(staging, "bridge"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(staging, "node_modules"), { recursive: true, mode: 0o700 })
  try {
    fs.cpSync(sourceRuntime, path.join(staging, "bridge", "src"), { recursive: true, dereference: true })
    fs.copyFileSync(rootManifest, path.join(staging, "package.json"))
    if (fs.existsSync(bridgeManifest)) fs.copyFileSync(bridgeManifest, path.join(staging, "bridge", "package.json"))
    else fs.writeFileSync(path.join(staging, "bridge", "package.json"), JSON.stringify({ type: "module" }), { mode: 0o600 })
    fs.cpSync(qrPackage, path.join(staging, "node_modules", "qrcode-terminal"), { recursive: true, dereference: true })
    fs.writeFileSync(path.join(staging, ".harness-remote-runtime"), OWNER_MARKER, { mode: 0o600 })
    fs.renameSync(staging, runtimeDir)
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw new Error(`Could not install a stable Harness Remote runtime at ${runtimeDir}: ${error.message}`)
  }
  return path.join(runtimeDir, "bridge", "src", "launcher.js")
}

function removeRuntime(runtimeDir) {
  const marker = path.join(runtimeDir, ".harness-remote-runtime")
  if (!assertOwned(marker, OWNER_MARKER)) return
  fs.rmSync(runtimeDir, { recursive: true, force: true })
  try { fs.rmdirSync(path.dirname(runtimeDir)) } catch { /* preserve other user data */ }
}

function queryWindowsTask(command) {
  const taskName = WINDOWS_TASK.replaceAll("'", "''")
  const script = `try { $task = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction Stop; 'HR_TASK_FOUND'; $task.State; Export-ScheduledTask -TaskName '${taskName}' } catch { if ($_.FullyQualifiedErrorId -like 'NoMSFT_ScheduledTaskObjectsFound*') { 'HR_TASK_NOT_FOUND' } else { [Console]::Error.WriteLine($_.Exception.Message); exit 9 } }`
  const output = command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]).trim()
  if (output === "HR_TASK_NOT_FOUND") return null
  if (!output.startsWith("HR_TASK_FOUND\n")) throw new Error(`Could not verify ownership of the Windows task '${WINDOWS_TASK}'.`)
  const lines = output.split(/\r?\n/)
  return { running: lines[1]?.trim() === "Running", xml: lines.slice(2).join("\n") }
}

function serviceDefinition({ platform, nodePath, launcherPath, args, home, username, localAppData }) {
  if (platform === "linux") {
    const unit = path.join(home, ".config", "systemd", "user", LINUX_UNIT)
    const exec = [nodePath, launcherPath, ...args].map(systemdQuote).join(" ")
    return { platform, file: unit, marker: OWNER_MARKER, content: `[Unit]\nDescription=${OWNER_MARKER}\n\n[Service]\nType=simple\nExecStart=${exec}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n` }
  }
  if (platform === "darwin") {
    const file = path.join(home, "Library", "LaunchAgents", `${MAC_LABEL}.plist`)
    const command = [nodePath, launcherPath, ...args]
    const plistArgs = command.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")
    return { platform, file, marker: OWNER_MARKER, content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${MAC_LABEL}</string>\n  <key>Comment</key><string>${OWNER_MARKER}</string>\n  <key>ProgramArguments</key><array>\n${plistArgs}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><dict><key>Crashed</key><true/></dict>\n  <key>StandardOutPath</key><string>${xml(path.join(home, "Library", "Logs", "HarnessRemote.log"))}</string>\n  <key>StandardErrorPath</key><string>${xml(path.join(home, "Library", "Logs", "HarnessRemote.log"))}</string>\n</dict></plist>\n` }
  }
  if (platform === "win32") {
    const appDir = path.join(localAppData || path.join(home, "AppData", "Local"), "HarnessRemote")
    const definition = path.join(appDir, "service.xml")
    const taskXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>${OWNER_MARKER}</Description></RegistrationInfo><Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger><LogonTrigger><Enabled>true</Enabled><UserId>${xml(username)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(username)}</UserId><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${xml(nodePath)}</Command><Arguments>${xml([launcherPath, ...args].map(windowsQuote).join(" "))}</Arguments><WorkingDirectory>${xml(path.dirname(launcherPath))}</WorkingDirectory></Exec></Actions></Task>`
    return { platform, file: definition, marker: OWNER_MARKER, content: taskXml, appDir, taskName: WINDOWS_TASK }
  }
  throw new Error("User services are supported on Linux, macOS, and Windows.")
}

function serviceArgs(cliArgs) {
  const args = cliArgs.slice()
  if (args.some((value) => /[\r\n\0]/.test(value))) throw new Error("Service options cannot contain newline or NUL characters.")
  if (args.includes("--allow-firewall")) throw new Error("--allow-firewall cannot be used with a background user service. Configure the firewall before installing it.")
  const usernameAt = args.indexOf("--username")
  const passwordAt = args.indexOf("--password")
  if (usernameAt !== args.lastIndexOf("--username") || passwordAt !== args.lastIndexOf("--password")) {
    throw new Error("Use --username and --password at most once when installing a service.")
  }
  if (usernameAt >= 0 && (!args[usernameAt + 1] || args[usernameAt + 1].startsWith("--"))) throw new Error("--username requires a value")
  if (passwordAt >= 0 && (!args[passwordAt + 1] || args[passwordAt + 1].startsWith("--"))) throw new Error("--password requires a value")
  let username = usernameAt >= 0 ? args[usernameAt + 1] : undefined
  let password = passwordAt >= 0 ? args[passwordAt + 1] : undefined
  if (Boolean(username) !== Boolean(password)) throw new Error("--username and --password must be supplied together")
  if (!username) {
    username = "harness"
    password = randomBytes(18).toString("base64url")
    args.push("--username", username, "--password", password)
  }
  return { args, username }
}

export function createUserServiceManager({
  platform = process.platform,
  home = os.homedir(),
  nodePath = process.execPath,
  launcherPath = fileURLToPath(new URL("./launcher.js", import.meta.url)),
  username = process.env.USERNAME || os.userInfo().username,
  env = process.env,
  command = run,
  uid = typeof process.getuid === "function" ? process.getuid() : 0
} = {}) {
  const runtimeDir = runtimeDirectory({ platform, home, localAppData: env.LOCALAPPDATA })
  const managedLauncherPath = path.join(runtimeDir, "bridge", "src", "launcher.js")

  function definition(args = []) {
    const { args: persistentArgs, username: bridgeUsername } = serviceArgs(args)
    const passwordAt = persistentArgs.indexOf("--password")
    return {
      ...serviceDefinition({ platform, nodePath, launcherPath: managedLauncherPath, args: persistentArgs, home, username, localAppData: env.LOCALAPPDATA }),
      credentials: { username: bridgeUsername, password: persistentArgs[passwordAt + 1] }
    }
  }

  function status() {
    const item = definition([])
    if (platform === "linux") {
      if (!assertOwned(item.file, OWNER_MARKER)) return { installed: false, running: false }
      try { command("systemctl", ["--user", "is-active", "--quiet", LINUX_UNIT]); return { installed: true, running: true } }
      catch { return { installed: true, running: false } }
    }
    if (platform === "darwin") {
      if (!assertOwned(item.file, OWNER_MARKER)) return { installed: false, running: false }
      try { command("launchctl", ["print", `gui/${uid}/${MAC_LABEL}`]); return { installed: true, running: true } }
      catch { return { installed: true, running: false } }
    }
    const existing = queryWindowsTask(command)
    if (!existing) return { installed: false, running: false }
    if (!existing.xml.includes(OWNER_MARKER)) throw new Error(`Refusing to inspect ${WINDOWS_TASK}: it is not owned by Harness Remote.`)
    return { installed: true, running: existing.running }
  }

  function install(args = []) {
    const item = definition(args)
    if (item.platform !== "win32" && assertOwned(item.file, OWNER_MARKER)) throw new Error("Harness Remote user service is already installed. Run `npx harness-remote service status` first.")
    if (item.platform === "win32") {
      if (fs.existsSync(item.file)) assertOwned(item.file, OWNER_MARKER)
      const existing = queryWindowsTask(command)
      if (existing && !existing.xml.includes(OWNER_MARKER)) throw new Error(`Refusing to replace ${item.taskName}: it is not owned by Harness Remote.`)
      if (existing) throw new Error("Harness Remote user service is already installed. Run `npx harness-remote service status` first.")
    }
    const stableLauncherPath = prepareRuntime({ sourceLauncherPath: launcherPath, runtimeDir })
    if (stableLauncherPath !== managedLauncherPath) throw new Error("The installed Harness Remote runtime path did not match its service definition.")
    let enableLinger = false
    if (item.platform === "linux") {
      const existingLinger = command("loginctl", ["show-user", username, "--property=Linger", "--value"]).trim()
      if (!new Set(["yes", "no"]).has(existingLinger)) throw new Error(`Could not determine whether systemd user lingering is already enabled for '${username}'.`)
      enableLinger = existingLinger === "no"
    }
    atomicWrite(item.file, item.content)
    if (item.platform === "linux") {
      if (enableLinger) {
        let lingerEnabledHere = false
        try {
          command("loginctl", ["enable-linger", username])
          lingerEnabledHere = true
          atomicWrite(`${item.file}.linger-by-harness-remote`, OWNER_MARKER)
        } catch (error) {
          if (lingerEnabledHere) {
            try { command("loginctl", ["disable-linger", username]) } catch { /* preserve the primary installation error */ }
          }
          fs.unlinkSync(item.file)
          removeRuntime(runtimeDir)
          throw new Error(`Could not enable systemd user lingering for '${username}'. Authenticate the loginctl request and retry. Details: ${error.message}`)
        }
      }
      command("systemctl", ["--user", "daemon-reload"])
      command("systemctl", ["--user", "enable", "--now", LINUX_UNIT])
    } else if (item.platform === "darwin") {
      fs.mkdirSync(path.join(home, "Library", "Logs"), { recursive: true })
      command("launchctl", ["bootstrap", `gui/${uid}`, item.file])
    } else {
      fs.mkdirSync(item.appDir, { recursive: true, mode: 0o700 })
      command("schtasks.exe", ["/Create", "/TN", item.taskName, "/XML", item.file])
      command("schtasks.exe", ["/Run", "/TN", item.taskName])
    }
    return { file: item.file, credentials: item.credentials }
  }

  function uninstall() {
    const item = definition([])
    const installed = status()
    if (!installed.installed) return false
    if (item.platform === "linux") {
      const lingerMarker = `${item.file}.linger-by-harness-remote`
      let disableLingerOnRemoval = false
      if (fs.existsSync(lingerMarker)) {
        if (!assertOwned(lingerMarker, OWNER_MARKER)) throw new Error(`Refusing to modify ${lingerMarker}: it is not owned by Harness Remote.`)
        disableLingerOnRemoval = true
      }
      command("systemctl", ["--user", "disable", "--now", LINUX_UNIT])
      fs.unlinkSync(item.file)
      if (fs.existsSync(lingerMarker)) fs.unlinkSync(lingerMarker)
      command("systemctl", ["--user", "daemon-reload"])
      if (disableLingerOnRemoval) command("loginctl", ["disable-linger", username])
      removeRuntime(runtimeDir)
    } else if (item.platform === "darwin") {
      if (installed.running) command("launchctl", ["bootout", `gui/${uid}/${MAC_LABEL}`])
      fs.unlinkSync(item.file)
      removeRuntime(runtimeDir)
    } else {
      if (installed.running) command("schtasks.exe", ["/End", "/TN", item.taskName])
      command("schtasks.exe", ["/Delete", "/TN", item.taskName])
      if (fs.existsSync(item.file)) {
        assertOwned(item.file, OWNER_MARKER)
        fs.unlinkSync(item.file)
      }
      try { fs.rmdirSync(item.appDir) } catch { /* keep unrelated user files in the directory */ }
      removeRuntime(runtimeDir)
    }
    return true
  }

  return { install, uninstall, status }
}

export function runServiceCommand(args, { manager = createUserServiceManager(), stdout = process.stdout, platform = process.platform } = {}) {
  const [action, ...rest] = args
  if (!new Set(["install", "uninstall", "status"]).has(action)) throw new Error("Usage: harness-remote service <install|uninstall|status> [launcher options]")
  if (action === "install") {
    const { credentials } = manager.install(rest)
    stdout.write(`Harness Remote user service installed and started (${platform}).\n`)
    stdout.write(`Connection credentials\n  Username  ${credentials.username}\n  Password  ${credentials.password}\n`)
    stdout.write(`Run \`npx harness-remote service status\` to check it, or \`npx harness-remote service uninstall\` to remove it.\n`)
    return
  }
  if (action === "uninstall") {
    stdout.write(manager.uninstall() ? "Harness Remote user service stopped and uninstalled.\n" : "Harness Remote user service is not installed.\n")
    return
  }
  const state = manager.status()
  stdout.write(`Harness Remote user service: ${state.installed ? state.running ? "running" : "installed, stopped" : "not installed"}.\n`)
}
