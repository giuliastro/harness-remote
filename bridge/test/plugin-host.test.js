import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { PluginHost } from "../src/plugins/plugin-host.js"

const observeReport = {
  schemaVersion: 1,
  command: "observe",
  toolVersion: "0.1.34",
  status: "ok",
  exitCode: 0,
  data: {
    contractVersion: 1,
    observedAt: "2026-10-25T12:00:00.000Z",
    readOnly: true,
    metricsFreshness: "stored-only",
    quotas: {
      platform: { os: "linux", arch: "x64" },
      observedAt: "2026-10-25T12:00:00.000Z",
      harnesses: [
        {
          harnessId: "claude",
          state: "observed",
          planType: "Max",
          windows: [{
            harnessId: "claude",
            bucketId: "five-hour",
            scope: "five-hour",
            window: "primary",
            usedPercent: 18,
            remainingPercent: 82,
            resetsAt: "2026-10-25T17:00:00.000Z",
            observedAt: "2026-10-25T12:00:00.000Z",
            source: "native-cli",
            confidence: "authoritative"
          }],
          rateLimitReachedType: null,
          resetCreditsAvailable: null,
          diagnostics: []
        },
        {
          harnessId: "codex",
          state: "observed",
          planType: "Plus",
          windows: [{
            harnessId: "codex",
            bucketId: "five-hour",
            scope: "five-hour",
            window: "primary",
            usedPercent: 20,
            remainingPercent: 80,
            resetsAt: "2026-10-25T17:00:00.000Z",
            observedAt: "2026-10-25T12:00:00.000Z",
            source: "native-rpc",
            confidence: "reported"
          }, {
            harnessId: "codex",
            bucketId: "weekly",
            scope: "weekly",
            window: "primary",
            usedPercent: 70,
            remainingPercent: 30,
            resetsAt: "2026-10-31T12:00:00.000Z",
            observedAt: "2026-10-25T12:00:00.000Z",
            source: "native-rpc",
            confidence: "reported"
          }],
          rateLimitReachedType: null,
          resetCreditsAvailable: null,
          diagnostics: []
        }
      ]
    },
    agents: [
      { harnessId: "claude", name: "Claude Code", state: "configured", version: "2.1.288" },
      { harnessId: "codex", name: "Codex CLI", state: "detected", version: "0.160.0" }
    ],
    metrics: {
      windowStart: "2026-10-18",
      windowEnd: "2026-10-25",
      scope: "all-projects",
      classes: [
        { class: "exact-local", unit: "tokens", before: 200000, after: 76544, saved: 123456, note: null },
        { class: "estimated-local", unit: "characters", before: 2000, after: 1000, saved: 1000, note: null }
      ],
      providers: [
        { providerId: "rtk", saved: 123456, unit: "tokens", class: "exact-local", operations: 42, harnesses: ["codex"] }
      ],
      daily: [
        { date: "2026-10-23", class: "exact-local", saved: 50000, operations: 10 },
        { date: "2026-10-24", class: "exact-local", saved: 70000, operations: 20 },
        { date: "2026-10-25", class: "exact-local", saved: 3456, operations: 12 }
      ],
      coveragePercent: 61,
      firstRecordedAt: "2026-10-18T08:00:00.000Z",
      lastRecordedAt: "2026-10-25T11:00:00.000Z"
    }
  },
  diagnostics: []
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-plugin-host-"))
  const home = path.join(root, "home")
  const bin = path.join(root, "bin")
  const state = path.join(root, "state")
  const log = path.join(root, "cli.log")
  await mkdir(home, { recursive: true })
  await mkdir(bin, { recursive: true })
  const claudeSettings = {
    hooks: Object.fromEntries(["UserPromptSubmit", "SubagentStart", "SubagentStop"].map((event) => [
      event,
      [{ hooks: [{ type: "command", command: "token-harness", args: ["__internal-prompt-router", "claude", event.toLowerCase()], timeout: 10 }] }]
    ]))
  }
  await mkdir(path.join(home, ".claude"), { recursive: true })
  await writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify(claudeSettings), "utf8")
  const cli = path.join(bin, "token-harness")
  await writeFile(cli, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === "--version") {
  process.stdout.write((process.env.FAKE_VERSION || "0.1.34") + "\\n")
  process.exit(0)
}
if (args.length === 0 || args[0] === "ui") {
  if (process.env.FAKE_LOG) require("node:fs").appendFileSync(process.env.FAKE_LOG, "ui\\n")
  process.stdout.write("Token Harness is ready: http://127.0.0.1:45678/\\n")
  process.exit(0)
}
if (args[0] === "observe") {
  if (process.env.FAKE_LOG) require("node:fs").appendFileSync(process.env.FAKE_LOG, "observe\\n")
  process.stdout.write(process.env.FAKE_OBSERVE || "{}")
  process.exit(0)
}
if (args[0] === "plan" || args[0] === "apply") {
  if (process.env.FAKE_LOG) require("node:fs").appendFileSync(process.env.FAKE_LOG, args.join(" ") + "\\n")
  process.stdout.write(JSON.stringify({ schemaVersion: 1, command: args[0], toolVersion: "0.1.34", status: "ok", exitCode: 0, data: { planId: args[0] === "plan" ? "plan-1" : null }, diagnostics: [] }))
  process.exit(0)
}
if (args[0] === "budget" || args[0] === "savings") {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, command: args[0], toolVersion: "0.1.34", status: "ok", exitCode: 0, data: {}, diagnostics: [] }))
  process.exit(0)
}
process.stderr.write("unsupported fake command: " + args.join(" "))
process.exit(2)
`, "utf8")
  await chmod(cli, 0o755)
  if (process.platform === "win32") {
    // Windows cannot execute the extensionless POSIX shim, so expose the same Node fixture through
    // the .cmd spelling the plugin host already prefers on Windows.
    const command = path.join(bin, "token-harness.cmd")
    await writeFile(command, `@echo off\r\n"${process.execPath}" "%~dp0token-harness" %*\r\n`, "utf8")
    return { root, home, bin, state, log, cli: command }
  }
  return { root, home, bin, state, log, cli }
}

test("plugin host detects an external Token Harness, auto-enables it and exposes bounded contributions", async () => {
  const env = await fixture()
  const host = new PluginHost({
    stateDirectory: env.state,
    home: env.home,
    environment: {
      ...process.env,
      HOME: env.home,
      PATH: `${env.bin}${path.delimiter}${path.dirname(process.execPath)}`,
      FAKE_OBSERVE: JSON.stringify(observeReport)
    },
    statusCacheMs: 50
  })
  try {
    const snapshot = await host.list()
    const plugin = snapshot.plugins.find((item) => item.id === "token-harness")
    assert.ok(plugin)
    assert.equal(plugin.enabled, true)
    assert.equal(plugin.state, "active")
    assert.equal(plugin.dependency.state, "external")
    assert.equal(plugin.dependency.version, "0.1.34")
    assert.equal(plugin.dependency.supportsObserve, true)
    assert.equal(plugin.actions.custom.find((item) => item.id === "open").label, "Open Token Harness")
    assert.equal(plugin.contributions.home.harnesses.find((item) => item.harnessId === "codex").remainingPercent, 80)
    assert.equal(plugin.contributions.home.meters.length, 3)
    assert.equal(plugin.contributions.home.meters.find((item) => item.id === "codex:weekly:weekly:primary").remainingPercent, 30)
    const exact = plugin.contributions.home.stats.find((stat) => stat.id === "exact-saved")
    assert.equal(exact.value, 123456)
    const routing = plugin.settings.sections.find((section) => section.id === "routing")
    assert.equal(routing.fields.find((field) => field.id === "routing.claude").value, true)
    const stored = JSON.parse(await readFile(host.statePath, "utf8"))
    assert.equal(stored.plugins["token-harness"].enabled, true)
    const opened = await host.runAction("token-harness", "open")
    assert.match(opened.message, /ready/)
    assert.equal(opened.url, "http://127.0.0.1:45678/")
  } finally {
    await host.close()
    await rm(env.root, { recursive: true, force: true })
  }
})

test("Token Harness 0.1.32 uses budget and savings without claiming observe support", async () => {
  const env = await fixture()
  const host = new PluginHost({
    stateDirectory: env.state,
    home: env.home,
    environment: {
      ...process.env,
      HOME: env.home,
      PATH: `${env.bin}${path.delimiter}${path.dirname(process.execPath)}`,
      FAKE_VERSION: "0.1.32",
      FAKE_LOG: env.log
    }
  })
  try {
    const plugin = (await host.list()).plugins.find((item) => item.id === "token-harness")
    assert.equal(plugin?.dependency.version, "0.1.32")
    assert.equal(plugin?.dependency.supportsObserve, false)
    await assert.rejects(readFile(env.log, "utf8"), { code: "ENOENT" })
  } finally {
    await host.close()
    await rm(env.root, { recursive: true, force: true })
  }
})

test("plugin host persists settings, hides views while disabled and keeps an external install intact", async () => {
  const env = await fixture()
  const host = new PluginHost({
    stateDirectory: env.state,
    home: env.home,
    environment: {
      ...process.env,
      HOME: env.home,
      PATH: `${env.bin}${path.delimiter}${path.dirname(process.execPath)}`,
      FAKE_OBSERVE: JSON.stringify(observeReport),
      FAKE_LOG: env.log
    },
    statusCacheMs: 50
  })
  try {
    await host.list()
    const configured = await host.configure("token-harness", { window: "30d", "routing.claude": true })
    assert.equal(configured.ok, true)
    const log = await readFile(env.log, "utf8")
    assert.match(log, /plan --harness claude --provider none --agent-routing --json/)
    assert.match(log, /apply --plan plan-1 --yes --json/)
    const stored = JSON.parse(await readFile(host.statePath, "utf8"))
    assert.equal(stored.plugins["token-harness"].config.window, "30d")

    const disabled = await host.disable("token-harness")
    assert.equal(disabled.plugin.enabled, false)
    assert.equal(disabled.plugin.state, "disabled")
    assert.deepEqual(disabled.plugin.contributions, {})

    const enabled = await host.enable("token-harness")
    assert.equal(enabled.plugin.enabled, true)
    assert.equal(enabled.plugin.state, "active")

    const uninstalled = await host.uninstall("token-harness")
    assert.equal(uninstalled.plugin.enabled, false)
    assert.equal(uninstalled.message.includes("left untouched"), true)
    const after = await host.list({ refresh: true })
    assert.equal(after.plugins[0].dependency.state, "external")
  } finally {
    await host.close()
    await rm(env.root, { recursive: true, force: true })
  }
})

test("the host runs a Python plugin through the same JSON protocol", async (t) => {
  if (spawnSync("python3", ["--version"]).status !== 0) {
    t.skip("python3 is unavailable")
    return
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-plugin-python-"))
  const builtin = path.join(root, "builtin")
  const pluginDirectory = path.join(builtin, "python-example")
  const state = path.join(root, "state")
  await mkdir(pluginDirectory, { recursive: true })
  await writeFile(path.join(pluginDirectory, "harness-plugin.json"), JSON.stringify({
    schemaVersion: 1,
    id: "python-example",
    name: "Python Example",
    version: "1.0.0",
    description: "Python runtime fixture",
    runtime: { kind: "python", entry: "plugin.py" }
  }), "utf8")
  await writeFile(path.join(pluginDirectory, "plugin.py"), `import json
import sys
request = json.load(sys.stdin)
if request.get("method") != "status":
    print(json.dumps({"ok": False, "error": "unsupported method"}))
    raise SystemExit(0)
print(json.dumps({"ok": True, "result": {
    "ready": True,
    "dependency": {"state": "external", "name": "python-app", "version": "2.0.0", "compatible": True},
    "actions": {},
    "contributions": {},
    "settings": None,
    "diagnostics": []
}}))
`, "utf8")
  const host = new PluginHost({
    stateDirectory: state,
    builtinDirectory: builtin,
    environment: process.env,
    home: root,
    statusCacheMs: 50
  })
  try {
    const snapshot = await host.list()
    assert.equal(snapshot.plugins.length, 1)
    assert.equal(snapshot.plugins[0].id, "python-example")
    assert.equal(snapshot.plugins[0].runtime.kind, "python")
    assert.equal(snapshot.plugins[0].ready, true)
    assert.equal(snapshot.plugins[0].enabled, true)
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("a missing external application stays visible as installable without exposing plugin views", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-plugin-missing-"))
  const home = path.join(root, "home")
  const state = path.join(root, "state")
  await mkdir(home, { recursive: true })
  const host = new PluginHost({
    stateDirectory: state,
    home,
    environment: {
      ...process.env,
      HOME: home,
      PATH: "/usr/bin:/bin"
    },
    statusCacheMs: 50
  })
  try {
    const snapshot = await host.list()
    const plugin = snapshot.plugins.find((item) => item.id === "token-harness")
    assert.ok(plugin)
    assert.equal(plugin.ready, false)
    assert.equal(plugin.enabled, false)
    assert.equal(plugin.state, "available")
    assert.equal(plugin.dependency.state, "missing")
    assert.equal(plugin.actions.install.available, true)
    assert.deepEqual(plugin.contributions, {})
    assert.equal(plugin.settings, null)
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("user plugins run only after explicit enable and disabled plugins cannot run actions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-plugin-consent-"))
  const builtin = path.join(root, "builtin")
  const user = path.join(root, "user")
  const pluginDirectory = path.join(user, "untrusted")
  const calls = path.join(root, "calls.log")
  await mkdir(builtin, { recursive: true })
  await mkdir(pluginDirectory, { recursive: true })
  await writeFile(path.join(pluginDirectory, "harness-plugin.json"), JSON.stringify({
    schemaVersion: 1,
    id: "untrusted",
    name: "User plugin",
    version: "1.0.0",
    autoEnableWhenReady: true,
    runtime: { kind: "node", entry: "plugin.cjs", deactivateOnDisable: true }
  }))
  await writeFile(path.join(pluginDirectory, "plugin.cjs"), `
const fs = require("node:fs")
fs.appendFileSync(${JSON.stringify(calls)}, "called\\n")
const request = JSON.parse(fs.readFileSync(0, "utf8"))
process.stdout.write(JSON.stringify({ ok: true, result: request.method === "status"
  ? { ready: true, actions: { custom: [{ id: "open", label: "Open" }] } }
  : { message: "opened" } }))
`)
  const host = new PluginHost({
    stateDirectory: path.join(root, "state"),
    builtinDirectory: builtin,
    userDirectory: user,
    home: root
  })
  try {
    const discovered = (await host.list()).plugins[0]
    assert.equal(discovered.enabled, false)
    assert.equal(discovered.ready, true)
    assert.deepEqual(discovered.storage, { bytes: 0, complete: true })
    await assert.rejects(readFile(calls, "utf8"), { code: "ENOENT" })
    await host.disable("untrusted")
    await assert.rejects(readFile(calls, "utf8"), { code: "ENOENT" })
    await assert.rejects(host.runAction("untrusted", "open"), { code: "plugin_disabled" })
    const managedData = path.join(root, "state", "plugins", "data", "untrusted")
    await mkdir(managedData, { recursive: true })
    await writeFile(path.join(managedData, "data.bin"), "1234567890")
    const enabled = await host.enable("untrusted")
    assert.equal(enabled.plugin.enabled, true)
    assert.equal(enabled.plugin.storage.bytes, 10)
    assert.match(await readFile(calls, "utf8"), /called/)
    await assert.rejects(host.runAction("untrusted", "other"), { code: "invalid_request" })
    assert.equal((await host.runAction("untrusted", "open")).message, "opened")
    await host.disable("untrusted")
    const before = await readFile(calls, "utf8")
    await host.list({ refresh: true })
    await assert.rejects(host.runAction("untrusted", "open"), { code: "plugin_disabled" })
    assert.equal(await readFile(calls, "utf8"), before)
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("disabling an opted-in plugin calls deactivate after persisting disabled state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-plugin-deactivate-"))
  const builtin = path.join(root, "builtin")
  const pluginDirectory = path.join(builtin, "long-running")
  const calls = path.join(root, "calls.log")
  await mkdir(pluginDirectory, { recursive: true })
  await writeFile(path.join(pluginDirectory, "harness-plugin.json"), JSON.stringify({
    schemaVersion: 1,
    id: "long-running",
    name: "Long running",
    version: "1.0.0",
    runtime: { kind: "node", entry: "plugin.cjs", deactivateOnDisable: true }
  }))
  await writeFile(path.join(pluginDirectory, "plugin.cjs"), `
const fs = require("node:fs")
const request = JSON.parse(fs.readFileSync(0, "utf8"))
fs.appendFileSync(${JSON.stringify(calls)}, request.method + "\\n")
process.stdout.write(JSON.stringify({ ok: true, result: request.method === "status" ? { ready: true } : {} }))
`)
  const host = new PluginHost({ stateDirectory: path.join(root, "state"), builtinDirectory: builtin, home: root })
  try {
    await host.list()
    const disabled = await host.disable("long-running")
    assert.equal(disabled.plugin.enabled, false)
    assert.match(await readFile(calls, "utf8"), /status\ndeactivate\nstatus/)
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})
