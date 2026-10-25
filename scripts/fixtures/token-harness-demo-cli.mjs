#!/usr/bin/env node
/**
 * Deterministic Token Harness stand-in for the plugin UI review script.
 *
 * It implements the public surfaces the Token Harness plugin consumes, including plan/apply, against
 * an isolated HOME. It never reads the real user's Claude/Codex configuration and never touches the
 * real Token Harness state root.
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"

const args = process.argv.slice(2)
const home = process.env.HOME || os.homedir()
const stateDirectory = process.env.HARNESS_REMOTE_DEMO_STATE || path.join(home, ".token-harness-demo")
const cliLog = path.join(stateDirectory, "cli.log")
const planFile = path.join(stateDirectory, "last-plan.json")
const routingEvents = ["UserPromptSubmit", "SubagentStart", "SubagentStop"]

function json(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function envelope(command, data) {
  return {
    schemaVersion: 1,
    command,
    toolVersion: "0.1.34",
    status: "ok",
    exitCode: 0,
    data,
    diagnostics: []
  }
}

function routingPath(harness) {
  return harness === "claude"
    ? path.join(home, ".claude", "settings.json")
    : path.join(home, ".codex", "hooks.json")
}

function hookEntry(harness, event) {
  return harness === "claude"
    ? {
      hooks: [{
        type: "command",
        command: "token-harness",
        args: ["__internal-prompt-router", "claude", event.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()],
        timeout: 10
      }]
    }
    : {
      hooks: [{
        type: "command",
        command: `token-harness __internal-prompt-router codex ${event.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`,
        commandWindows: `token-harness __internal-prompt-router codex ${event.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`,
        timeout: 10
      }]
    }
}

function hasMarker(value) {
  if (typeof value === "string") return value.includes("__internal-prompt-router")
  if (Array.isArray(value)) return value.some(hasMarker)
  if (!value || typeof value !== "object") return false
  return Object.values(value).some(hasMarker)
}

async function setRouting(harness, enabled) {
  const file = routingPath(harness)
  let document = {}
  try { document = JSON.parse(await readFile(file, "utf8")) } catch { document = {} }
  const hooks = document.hooks && typeof document.hooks === "object" && !Array.isArray(document.hooks) ? document.hooks : {}
  for (const event of routingEvents) {
    const current = Array.isArray(hooks[event]) ? hooks[event] : []
    const retained = current.filter((entry) => !hasMarker(entry))
    hooks[event] = enabled ? [...retained, hookEntry(harness, event)] : retained
  }
  document.hooks = hooks
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, "utf8")
}

function observeData() {
  return {
    contractVersion: 1,
    observedAt: new Date().toISOString(),
    readOnly: true,
    metricsFreshness: "stored-only",
    quotas: {
      platform: { os: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux", arch: process.arch, nodeVersion: process.version },
      observedAt: new Date().toISOString(),
      harnesses: [
        {
          harnessId: "claude",
          state: "observed",
          planType: "Max",
          windows: [{
            harnessId: "claude",
            bucketId: "five-hour",
            bucketName: "5-hour",
            scope: "five-hour",
            window: "primary",
            usedPercent: 18,
            remainingPercent: 82,
            resetsAt: new Date(Date.now() + 2.4 * 60 * 60 * 1000).toISOString(),
            observedAt: new Date().toISOString(),
            source: "native-cli",
            confidence: "authoritative"
          }],
          rateLimitReachedType: null,
          resetCreditsAvailable: 2,
          diagnostics: []
        },
        {
          harnessId: "codex",
          state: "observed",
          planType: "Plus",
          windows: [{
            harnessId: "codex",
            bucketId: "weekly",
            bucketName: "Weekly",
            scope: "weekly",
            window: "primary",
            usedPercent: 70,
            remainingPercent: 30,
            resetsAt: new Date(Date.now() + 4.6 * 24 * 60 * 60 * 1000).toISOString(),
            observedAt: new Date().toISOString(),
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
      { harnessId: "codex", name: "Codex CLI", state: "configured", version: "0.160.0" },
      { harnessId: "opencode", name: "OpenCode", state: "detected", version: "2.1.4" }
    ],
    metrics: {
      windowStart: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      windowEnd: new Date().toISOString().slice(0, 10),
      scope: "all-projects",
      classes: [
        { class: "exact-local", unit: "tokens", before: 704583, after: 104653, saved: 599930, note: null },
        { class: "estimated-local", unit: "characters", before: 358472, after: 198255, saved: 160217, note: "Estimated from recorded output" }
      ],
      providers: [
        { providerId: "rtk", saved: 599930, unit: "tokens", class: "exact-local", operations: 144, harnesses: ["codex"], managedByTokenHarness: true, before: 662530, after: 62600 }
      ],
      daily: [
        { date: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10), class: "exact-local", saved: 42419, operations: 17 },
        { date: new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10), class: "exact-local", saved: 52837, operations: 31 },
        { date: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10), class: "exact-local", saved: 9124, operations: 8 },
        { date: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10), class: "exact-local", saved: 128373, operations: 42 },
        { date: new Date(Date.now() - 86400000).toISOString().slice(0, 10), class: "exact-local", saved: 40230, operations: 45 },
        { date: new Date().toISOString().slice(0, 10), class: "exact-local", saved: 1790, operations: 11 }
      ],
      coveragePercent: 61,
      firstRecordedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
      lastRecordedAt: new Date().toISOString()
    }
  }
}

async function main() {
  await mkdir(stateDirectory, { recursive: true })
  if (args[0] === "--version") {
    process.stdout.write("0.1.34\n")
    return
  }
  if (args.length === 0 || args[0] === "ui") {
    await appendFile(cliLog, `ui ${args.join(" ")}\n`, "utf8")
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Token Harness demo</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:10vh auto;padding:0 24px;color:#172033;background:#f6f8fc}main{padding:32px;border:1px solid #dce4f2;border-radius:20px;background:#fff;box-shadow:0 14px 40px rgba(20,40,80,.08)}h1{margin:0 0 8px;font-size:30px;letter-spacing:-.03em}p{color:#5f6b80}.tag{display:inline-block;padding:4px 9px;border-radius:999px;background:#e9effe;color:#2f66f5;font-size:12px;font-weight:700}code{background:#eef1f7;padding:2px 5px;border-radius:5px}</style></head>
<body><main><span class="tag">DEMO FIXTURE</span><h1>Token Harness</h1><p>This page is provided by the Harness Remote plugin demo. It proves the plugin can start Token Harness and hand its dashboard URL to the desktop app.</p><p>Run the test with <code>--real</code> to open the real Token Harness dashboard and manage optimizers there.</p></main></body></html>`)
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : null
      if (port) process.stdout.write(`Token Harness is ready: http://127.0.0.1:${port}/\n`)
      setTimeout(() => process.exit(0), 120_000)
    })
    return
  }
  if (args[0] === "observe") {
    json(envelope("observe", observeData()))
    return
  }
  if (args[0] === "budget") {
    const data = observeData()
    json(envelope("budget", data.quotas))
    return
  }
  if (args[0] === "savings") {
    json(envelope("savings", {
      period: args.includes("--since") ? args[args.indexOf("--since") + 1] : "7d",
      scope: "All locally recorded projects",
      rows: [{
        providerId: "rtk",
        provider: "RTK",
        measurement: "Measured local output",
        unit: "tokens",
        saved: 599930,
        before: 662530,
        after: 62600,
        operations: 144,
        harnesses: ["codex"],
        agents: ["Codex"]
      }],
      firstRecordedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
      lastRecordedAt: new Date().toISOString()
    }))
    return
  }
  if (args[0] === "plan") {
    const harness = args.includes("--harness") ? args[args.indexOf("--harness") + 1] : "claude"
    const enabled = args.includes("--agent-routing")
    await appendFile(cliLog, `${args.join(" ")}\n`, "utf8")
    await writeFile(planFile, JSON.stringify({ harness, enabled }), "utf8")
    json(envelope("plan", {
      planId: "demo-plan-1",
      actions: [{ id: `native-prompt-routing:${harness}:${enabled ? "enable" : "disable"}` }],
      conflicts: []
    }))
    return
  }
  if (args[0] === "apply") {
    await appendFile(cliLog, `${args.join(" ")}\n`, "utf8")
    let plan = null
    try { plan = JSON.parse(await readFile(planFile, "utf8")) } catch { plan = null }
    if (!plan) {
      process.stderr.write("No demo plan prepared\n")
      process.exitCode = 2
      return
    }
    await setRouting(plan.harness, plan.enabled)
    json(envelope("apply", { planId: args[args.indexOf("--plan") + 1] ?? "demo-plan-1" }))
    return
  }
  process.stderr.write(`Unsupported demo command: ${args.join(" ")}\n`)
  process.exitCode = 2
}

await main()
