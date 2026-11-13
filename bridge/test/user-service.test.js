import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { createUserServiceManager, runServiceCommand } from "../src/user-service.js"

function fixture(platform, powerShellResponse, initialLinger = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-remote-service-"))
  const sourceRoot = path.join(home, "npx-cache", "harness-remote")
  const sourceLauncher = path.join(sourceRoot, "bridge", "src", "launcher.js")
  fs.mkdirSync(path.dirname(sourceLauncher), { recursive: true })
  fs.writeFileSync(sourceLauncher, "import './lifecycle-helper.js'\n")
  fs.writeFileSync(path.join(sourceRoot, "package.json"), JSON.stringify({ name: "harness-remote", type: "module" }))
  fs.writeFileSync(path.join(sourceRoot, "bridge", "package.json"), JSON.stringify({ name: "harness-remote-bridge", type: "module" }))
  fs.writeFileSync(path.join(path.dirname(sourceLauncher), "lifecycle-helper.js"), "export const stable = true\n")
  const qrMain = path.join(sourceRoot, "node_modules", "qrcode-terminal", "lib", "main.js")
  fs.mkdirSync(path.dirname(qrMain), { recursive: true })
  fs.writeFileSync(qrMain, "module.exports = {}\n")
  fs.writeFileSync(path.join(sourceRoot, "node_modules", "qrcode-terminal", "package.json"), JSON.stringify({ name: "qrcode-terminal", main: "lib/main.js" }))
  const calls = []
  let active = false
  let linger = initialLinger
  let taskExists = false
  const command = (file, args) => {
    calls.push([file, ...args])
    if (file === "systemctl" && args.includes("is-active")) {
      if (!active) throw new Error("inactive")
    }
    if (file === "systemctl" && args.includes("enable")) active = true
    if (file === "systemctl" && args.includes("disable")) active = false
    if (file === "loginctl" && args[0] === "show-user") return linger ? "yes" : "no"
    if (file === "loginctl" && args[0] === "enable-linger") { linger = true; return "" }
    if (file === "loginctl" && args[0] === "disable-linger") { linger = false; return "" }
    if (file === "launchctl" && args[0] === "print") {
      if (!active) throw new Error("not loaded")
    }
    if (file === "launchctl" && args[0] === "bootstrap") active = true
    if (file === "launchctl" && args[0] === "bootout") active = false
    if (file === "powershell.exe") {
      if (powerShellResponse instanceof Error) throw powerShellResponse
      if (typeof powerShellResponse === "string") return powerShellResponse
      if (!taskExists) return "HR_TASK_NOT_FOUND"
      return `HR_TASK_FOUND\n${active ? "Running" : "Ready"}\n<Task><Description>Harness Remote managed user service v1</Description></Task>`
    }
    if (file === "schtasks.exe" && args[0] === "/Create") taskExists = true
    if (file === "schtasks.exe" && args[0] === "/Run") active = true
    if (file === "schtasks.exe" && args[0] === "/End") active = false
    if (file === "schtasks.exe" && args[0] === "/Delete") taskExists = false
    return ""
  }
  const manager = createUserServiceManager({ platform, home, username: "test-user", launcherPath: sourceLauncher, env: { LOCALAPPDATA: path.join(home, "AppData", "Local") }, command, uid: 501 })
  return { home, sourceRoot, calls, manager }
}

for (const platform of ["linux", "darwin", "win32"]) {
  test(`${platform} user service installs, reports status, and removes only its own service`, () => {
    const { home, sourceRoot, calls, manager } = fixture(platform)
    try {
      assert.deepEqual(manager.status(), { installed: false, running: false })
      manager.install(["--host", "127.0.0.1", "--port", "4567"])
      const windowsTaskDefinition = platform === "win32"
        ? fs.readFileSync(path.join(home, "AppData", "Local", "HarnessRemote", "service.xml"), "utf8")
        : ""
      const runtimeDir = platform === "linux"
        ? path.join(home, ".local", "share", "harness-remote", "runtime")
        : platform === "darwin"
          ? path.join(home, "Library", "Application Support", "Harness Remote", "runtime")
          : path.join(home, "AppData", "Local", "HarnessRemote", "runtime")
      assert.equal(fs.readFileSync(path.join(runtimeDir, "bridge", "src", "lifecycle-helper.js"), "utf8"), "export const stable = true\n")
      assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeDir, "bridge", "package.json"), "utf8")).type, "module")
      const registration = platform === "linux"
        ? fs.readFileSync(path.join(home, ".config", "systemd", "user", "harness-remote.service"), "utf8")
        : platform === "darwin"
          ? fs.readFileSync(path.join(home, "Library", "LaunchAgents", "com.harnessremote.gateway.plist"), "utf8")
          : windowsTaskDefinition
      assert.ok(registration.includes(runtimeDir), `service definition must use the stable runtime path ${runtimeDir}`)
      fs.rmSync(sourceRoot, { recursive: true, force: true })
      assert.deepEqual(manager.status(), { installed: true, running: true })
      assert.equal(manager.uninstall(), true)
      assert.deepEqual(manager.status(), { installed: false, running: false })
      assert.equal(manager.uninstall(), false)
      const serialized = calls.map((call) => call.join(" ")).join("\n")
      assert.doesNotMatch(serialized, /killall|pkill|taskkill|:4567|\/F/)
      if (platform === "linux") {
        assert.match(serialized, /systemctl --user enable --now harness-remote\.service/)
        assert.match(serialized, /systemctl --user disable --now harness-remote\.service/)
        assert.match(serialized, /loginctl enable-linger test-user/)
        assert.match(serialized, /loginctl disable-linger test-user/)
      } else if (platform === "darwin") {
        assert.match(serialized, /gui\/501 .*com\.harnessremote\.gateway\.plist/)
        assert.match(serialized, /gui\/501\/com\.harnessremote\.gateway/)
      } else {
        assert.match(serialized, /Harness Remote Gateway/)
        assert.match(serialized, /\/Delete \/TN Harness Remote Gateway/)
        assert.match(windowsTaskDefinition, /<LogonType>S4U<\/LogonType>/)
        assert.match(windowsTaskDefinition, /<BootTrigger>/)
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
}

test("refuses to overwrite or uninstall a foreign Linux user unit", () => {
  const { home, manager } = fixture("linux")
  const unit = path.join(home, ".config", "systemd", "user", "harness-remote.service")
  fs.mkdirSync(path.dirname(unit), { recursive: true })
  fs.writeFileSync(unit, "[Unit]\nDescription=Someone else's service\n")
  try {
    assert.throws(() => manager.install(), /not owned by Harness Remote/)
    assert.throws(() => manager.uninstall(), /not owned by Harness Remote/)
    assert.match(fs.readFileSync(unit, "utf8"), /Someone else's service/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test("leaves pre-existing systemd user lingering enabled when uninstalling", () => {
  const { home, calls, manager } = fixture("linux", undefined, true)
  try {
    manager.install()
    manager.uninstall()
    assert.equal(calls.some((call) => call[0] === "loginctl" && call[1] === "enable-linger"), false)
    assert.equal(calls.some((call) => call[0] === "loginctl" && call[1] === "disable-linger"), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test("service CLI validates action and prints a concise status", () => {
  const messages = []
  const stdout = { write: (message) => messages.push(message) }
  const manager = { status: () => ({ installed: true, running: false }) }
  runServiceCommand(["status"], { manager, stdout, platform: "linux" })
  assert.match(messages.join(""), /installed, stopped/)
  assert.throws(() => runServiceCommand(["restart"], { manager, stdout }), /Usage:/)
})

test("rejects incomplete or duplicate persistent credentials before writing a service", () => {
  const { home, manager } = fixture("linux")
  try {
    assert.throws(() => manager.install(["--username", "harness"]), /--password/)
    assert.throws(() => manager.install(["--username", "harness", "--password", "secret", "--password", "other"]), /at most once/)
    assert.equal(fs.existsSync(path.join(home, ".config", "systemd", "user", "harness-remote.service")), false)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test("Windows task lookup errors and foreign tasks fail closed", () => {
  for (const response of [new Error("Access denied"), "HR_TASK_FOUND\nReady\n<Task><Description>Other app</Description></Task>"]) {
    const { home, calls, manager } = fixture("win32", response)
    try {
      assert.throws(() => manager.install(), /Access denied|Could not verify|not owned by Harness Remote/)
      assert.throws(() => manager.status(), /Access denied|Could not verify|not owned by Harness Remote/)
      assert.equal(calls.some((call) => call[0] === "schtasks.exe" && call[1] === "/Create"), false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
})

test("the persistent runtime loads its copied ESM launcher and dependencies independently of npx", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-remote-runtime-"))
  let active = false
  const manager = createUserServiceManager({
    platform: "linux",
    home,
    command(file, args) {
      if (file === "loginctl" && args[0] === "show-user") return "no"
      if (file === "loginctl") return ""
      if (file === "systemctl" && args.includes("enable")) active = true
      if (file === "systemctl" && args.includes("disable")) active = false
      if (file === "systemctl" && args.includes("is-active") && !active) throw new Error("inactive")
      return ""
    }
  })
  try {
    manager.install(["--backend", "codex"])
    const copiedLauncher = path.join(home, ".local", "share", "harness-remote", "runtime", "bridge", "src", "launcher.js")
    const copiedModule = await import(pathToFileURL(copiedLauncher).href)
    assert.match(copiedModule.launcherUsage(), /service <install\|uninstall\|status>/)
    assert.equal(typeof createRequire(copiedLauncher)("qrcode-terminal"), "object")
    assert.equal(manager.uninstall(), true)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
