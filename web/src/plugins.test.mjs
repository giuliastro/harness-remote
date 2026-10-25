import assert from "node:assert/strict"
import {
  activePlugins,
  formatPluginValue,
  formatResetAt,
  normalizePlugin,
  normalizePluginSnapshot,
  preferredPluginMachine,
  pluginIsActive
} from "./plugins.ts"

function plugin(overrides = {}) {
  return {
    id: "token-harness",
    name: "Token Harness",
    version: "1.0.0",
    description: "Allowance",
    icon: "token-harness",
    builtIn: true,
    surfaces: ["backend", "frontend"],
    capabilities: ["dashboard"],
    permissions: ["run-local"],
    runtime: { kind: "node" },
    enabled: true,
    ready: true,
    state: "active",
    dependency: {
      state: "external",
      name: "token-harness",
      version: "0.1.34",
      path: "/usr/local/bin/token-harness",
      manager: "npm",
      compatible: true,
      supportsObserve: true,
      detail: "Detected on this machine · v0.1.34"
    },
    actions: {
      install: { available: false },
      update: { available: false },
      uninstall: { available: false }
    },
    contributions: {
      home: {
        title: "Token Harness",
        subtitle: "Last 7 days",
        harnesses: [
          { harnessId: "claude", label: "Claude Code", state: "observed", remainingPercent: 82 },
          { harnessId: "codex", label: "Codex", state: "observed", remainingPercent: 41 }
        ],
        meters: [{
          id: "codex:weekly",
          harnessLabel: "Codex",
          label: "Weekly",
          scope: "weekly",
          state: "observed",
          remainingPercent: 41,
          usedPercent: 59,
          resetsAt: "2026-10-31T12:00:00.000Z",
          tone: "warn"
        }],
        stats: [{ id: "exact", label: "Exact local saved", value: 599930, unit: "tokens", format: "number" }],
        chart: { points: [{ label: "10-24", value: 100 }, { label: "10-25", value: 200 }] }
      }
    },
    settings: { sections: [] },
    diagnostics: [],
    checkedAt: "2026-10-25T12:00:00.000Z",
    ...overrides
  }
}

const normalized = normalizePlugin(plugin())
assert.ok(normalized)
assert.equal(normalized.contributions.home.meters[0].remainingPercent, 41)
assert.equal(normalized.contributions.home.harnesses.find((item) => item.harnessId === "codex").remainingPercent, 41)
assert.equal(normalized.contributions.home.stats[0].value, 599930)
assert.equal(pluginIsActive(normalized), true)

assert.equal(pluginIsActive(normalizePlugin(plugin({ enabled: false, state: "disabled" }))), false)
assert.equal(pluginIsActive(normalizePlugin(plugin({ ready: false, state: "available" }))), false)
assert.deepEqual(activePlugins(normalizePluginSnapshot({ plugins: [plugin()] })).map((item) => item.id), ["token-harness"])
assert.deepEqual(activePlugins(normalizePluginSnapshot({ plugins: [plugin({ state: "disabled", enabled: false })] })), [])
assert.equal(normalizePluginSnapshot({ plugins: "nope" }), null)
assert.equal(normalizePlugin({ id: 1 }), null)

assert.equal(formatPluginValue({ id: "a", label: "Saved", value: 599930, unit: "tokens", format: "number" }, "en"), "599.9K tokens")
assert.equal(formatPluginValue({ id: "b", label: "Saved", value: 160217, unit: "characters", format: "number" }, "en"), "160.2K chars")
assert.equal(formatPluginValue({ id: "c", label: "Coverage", value: 61, format: "percent" }, "en"), "61%")
assert.equal(formatPluginValue({ id: "d", label: "None", value: "No evidence", format: "text" }, "en"), "No evidence")

const now = Date.parse("2026-10-25T12:00:00.000Z")
assert.equal(formatResetAt("2026-10-25T14:00:00.000Z", "en", now), "2h")
assert.equal(formatResetAt("2026-10-25T11:00:00.000Z", "en", now), "reset due")
assert.equal(formatResetAt(null, "en", now), null)

const machines = [
  { id: "remote", name: "Remote", config: { backend: "opencode", host: "10.0.0.2", port: 4097, username: "", password: "" } },
  { id: "desktop-local-runtime", name: "This computer", config: { backend: "opencode", host: "127.0.0.1", port: 4097, username: "", password: "" } }
]
assert.equal(preferredPluginMachine(machines, undefined, (machine) => machine.id === "desktop-local-runtime").id, "desktop-local-runtime")
assert.equal(preferredPluginMachine(machines, machines[0], (machine) => machine.id === "desktop-local-runtime").id, "remote")
assert.equal(preferredPluginMachine([], undefined, () => false), undefined)

console.log("plugin model tests passed")
