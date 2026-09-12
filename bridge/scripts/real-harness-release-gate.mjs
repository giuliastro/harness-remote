#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { verifyRealHarnessSessionDiscovery } from "./real-harness-session-discovery.mjs"

export const SUPPORTED_HARNESSES = ["opencode", "codex", "claude", "omp", "pi"]

const REQUIRED_SOAK_COVERAGE = [
  "sessionCreation",
  "multiTurnStreaming",
  "modelSelection",
  "crossHarnessIsolation",
  "transcriptFidelity",
  "stopAndResume",
  "resourceBounds"
]

function optionValue(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

export function parseHarnessList(value = SUPPORTED_HARNESSES.join(",")) {
  const requested = value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean)
  const harnesses = [...new Set(requested)]
  if (harnesses.length < 2) throw new Error("Real-harness release validation requires at least two harnesses so isolation can be exercised.")
  const unsupported = harnesses.filter((harness) => !SUPPORTED_HARNESSES.includes(harness))
  if (unsupported.length) throw new Error(`Unsupported harness(es): ${unsupported.join(", ")}. Supported: ${SUPPORTED_HARNESSES.join(", ")}.`)
  return harnesses
}

export function buildHarnessPlan(harnesses) {
  if (!Array.isArray(harnesses) || harnesses.length < 2) throw new Error("At least two harnesses are required.")
  return harnesses.map((primary, index) => ({
    primary,
    secondary: harnesses[(index + 1) % harnesses.length]
  }))
}

export function resolveGateMode(value = "release") {
  if (value !== "release" && value !== "control-plane") {
    throw new Error("--mode must be 'release' or 'control-plane'.")
  }
  return value
}

export function releaseEligibility({ mode, echoMarkers }) {
  if (mode === "control-plane") {
    return {
      releaseEligible: false,
      evidence: "control-plane-only",
      note: "Native harness errors may count as delivered; this run cannot verify real inference."
    }
  }
  return {
    releaseEligible: true,
    evidence: echoMarkers ? "echo-marker" : "turn-arrival",
    note: echoMarkers
      ? "Per-turn routing is proven with echoed markers."
      : "Per-turn routing is judged by ordered turn arrival; report records the weaker evidence explicitly."
  }
}

function safeURL(value) {
  try {
    const parsed = new URL(value)
    parsed.username = ""
    parsed.password = ""
    return parsed.toString().replace(/\/$/, "")
  } catch {
    return "invalid-url"
  }
}

function authorization(user = process.env.HR_USER ?? "", pass = process.env.HR_PASS ?? "") {
  return `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`
}

function preflightAgent(agentID, agents) {
  const agent = agents.find((candidate) => candidate?.id === agentID)
  return {
    id: agentID,
    registered: Boolean(agent),
    backend: agent?.backend ?? null,
    transport: agent?.transport ?? null,
    state: agent?.state ?? null,
    modelCatalog: agent?.modelCatalog
      ? {
          configured: true,
          source: agent.modelCatalog.source ?? null,
          cachedModels: agent.modelCatalog.cachedModels ?? 0,
          phase: agent.modelCatalog.phase ?? null
        }
      : { configured: false, source: null, cachedModels: 0, phase: null }
  }
}

export async function preflightDaemon({
  harnesses,
  urlRoot = process.env.HR_URL ?? "http://127.0.0.1:4097",
  user = process.env.HR_USER ?? "",
  pass = process.env.HR_PASS ?? "",
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000
}) {
  const root = urlRoot.replace(/\/$/, "")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${root}/v1/diagnostics`, {
      headers: { Accept: "application/json", Authorization: authorization(user, pass) },
      signal: controller.signal
    })
    const text = await response.text()
    let data
    try { data = text ? JSON.parse(text) : {} } catch { data = {} }

    if (!response.ok) {
      const detail = response.status === 401
        ? "Daemon rejected the supplied credentials."
        : `Diagnostics endpoint returned HTTP ${response.status}.`
      return { passed: false, status: response.status, error: detail, machineID: null, agents: [], missingHarnesses: [...harnesses], missingModelCatalogs: [] }
    }

    const agents = Array.isArray(data?.agents) ? data.agents : []
    const selected = harnesses.map((agentID) => preflightAgent(agentID, agents))
    const missingHarnesses = selected.filter((agent) => !agent.registered).map((agent) => agent.id)
    const missingModelCatalogs = selected.filter((agent) => agent.registered && !agent.modelCatalog.configured).map((agent) => agent.id)
    return {
      passed: missingHarnesses.length === 0 && missingModelCatalogs.length === 0,
      status: response.status,
      error: null,
      machineID: data?.machine?.id ?? null,
      agents: selected,
      missingHarnesses,
      missingModelCatalogs
    }
  } catch (error) {
    const message = error?.name === "AbortError"
      ? `Diagnostics preflight timed out after ${timeoutMs}ms.`
      : `Could not reach daemon diagnostics: ${error instanceof Error ? error.message : String(error)}`
    return { passed: false, status: 0, error: message, machineID: null, agents: [], missingHarnesses: [...harnesses], missingModelCatalogs: [] }
  } finally {
    clearTimeout(timer)
  }
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return process.env.GITHUB_SHA ?? null
  }
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-")
}

export function defaultReportPath(cwd = process.cwd(), date = new Date()) {
  return path.join(cwd, "artifacts", `real-harness-gate-${stamp(date)}.json`)
}

function hasPassed(checks, pattern) {
  return checks.some((check) => check.passed && pattern.test(check.message))
}

export function parseSoakEvidence(output = "") {
  const checks = []
  for (const line of String(output).split(/\r?\n/)) {
    const match = /^\s*(ok|FAIL)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    checks.push({ passed: match[1] === "ok", message: match[2] })
  }

  const coverage = {
    sessionCreation: hasPassed(checks, /two native Sessions created on/i),
    multiTurnStreaming: hasPassed(checks, /turn \d+ completed in \d+ms/i),
    modelSelection: hasPassed(checks, /turn \d+ accepted with model /i),
    crossHarnessIsolation:
      hasPassed(checks, /catalog unchanged (?:while switching away and back|after visiting)/i)
      && hasPassed(checks, /prompt accepted after harness switch and model change/i),
    transcriptFidelity: hasPassed(checks, /one user turn per accepted prompt, no duplicates/i),
    stopAndResume:
      hasPassed(checks, /Stop accepted for /i)
      && hasPassed(checks, /Session accepts a new prompt with a new model after Stop/i)
      && hasPassed(checks, /interrupted turn stays visible in the transcript/i),
    resourceBounds:
      hasPassed(checks, /adapter listeners did not grow unboundedly/i)
      && hasPassed(checks, /no unresolved native Session mutation left/i)
  }
  const missingCoverage = REQUIRED_SOAK_COVERAGE.filter((name) => !coverage[name])
  const failedChecks = checks.filter((check) => !check.passed)

  return {
    schemaVersion: 1,
    checks,
    summary: {
      total: checks.length,
      passed: checks.length - failedChecks.length,
      failed: failedChecks.length
    },
    coverage,
    missingCoverage,
    complete: checks.length > 0 && failedChecks.length === 0 && missingCoverage.length === 0,
    notExercised: [
      "daemon restart/reconnect",
      "physical mobile background/foreground"
    ]
  }
}

export function gateUsage() {
  return `Usage: npm run gate:real-harness -- [options]\n\nOptions:\n  --harnesses <list>  Comma-separated harnesses to verify (default: ${SUPPORTED_HARNESSES.join(",")})\n  --mode <mode>       release (default) or control-plane\n  --report <path>     JSON evidence report path (default: artifacts/real-harness-gate-<timestamp>.json)\n  --help              Show this help\n\nThe gate first checks /v1/diagnostics and stops early if the daemon is unreachable, credentials are rejected, a requested harness is not registered, or model discovery is not configured. It then creates one harmless probe Session per requested harness and requires that exact native id to be rediscovered through the Session index before inference-heavy soak legs begin. Each real-harness leg must also emit the complete scenario evidence contract (Session creation, multi-turn streaming, model selection, cross-harness isolation, transcript fidelity, Stop/recovery and bounded resources); a zero exit code without that evidence fails closed. Shared soak settings use HR_URL, HR_USER, HR_PASS, HR_DIR_A, HR_DIR_B, HR_CYCLES, HR_TURN_BUDGET_MS and HR_ECHO_MARKERS. Release mode always disables HR_ALLOW_TURN_ERRORS. Use --mode control-plane when inference is unavailable; that mode is recorded as not release-eligible.`
}

async function runSoak({ primary, secondary, mode, soakPath }) {
  const startedAt = new Date()
  const started = Date.now()
  const env = {
    ...process.env,
    HR_PRIMARY: primary,
    HR_SECONDARY: secondary,
    HR_ALLOW_TURN_ERRORS: mode === "control-plane" ? "1" : "0"
  }

  let stdout = ""
  let stderr = ""
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [soakPath], { env, stdio: ["inherit", "pipe", "pipe"] })
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString("utf8")
      stdout += text
      process.stdout.write(text)
    })
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8")
      stderr += text
      process.stderr.write(text)
    })
    child.once("error", (error) => resolve({ exitCode: 1, signal: null, error: error.message }))
    child.once("exit", (code, signal) => resolve({ exitCode: code ?? (signal ? 1 : 0), signal: signal ?? null, error: null }))
  })

  const evidence = parseSoakEvidence(`${stdout}\n${stderr}`)
  const evidenceError = evidence.complete
    ? null
    : evidence.summary.total === 0
      ? "Soak exited without machine-readable check evidence."
      : evidence.missingCoverage.length
        ? `Soak evidence is missing required coverage: ${evidence.missingCoverage.join(", ")}.`
        : `Soak evidence contains ${evidence.summary.failed} failed check(s).`

  return {
    primary,
    secondary,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - started,
    ...result,
    evidence,
    evidenceError,
    passed: result.exitCode === 0 && evidence.complete
  }
}

function persistReport(reportPath, report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  console.log(`\nEvidence report: ${reportPath}`)
  console.log(`Verdict: ${report.verdict}`)
}

export async function runGate({
  harnesses,
  mode,
  reportPath,
  soakPath = fileURLToPath(new URL("./session-first-soak.mjs", import.meta.url)),
  preflight = preflightDaemon,
  sessionDiscovery = verifyRealHarnessSessionDiscovery
}) {
  const echoMarkers = process.env.HR_ECHO_MARKERS !== "0"
  const eligibility = releaseEligibility({ mode, echoMarkers })
  const plan = buildHarnessPlan(harnesses)
  const runs = []

  console.log(`Harness Remote real-harness gate: mode=${mode}`)
  console.log(`Harnesses: ${harnesses.join(", ")}`)
  console.log(`Evidence: ${eligibility.evidence}`)
  console.log(eligibility.note)

  console.log("\n== daemon preflight ==")
  const preflightResult = await preflight({ harnesses })
  if (preflightResult.passed) {
    for (const agent of preflightResult.agents) {
      console.log(`  ok   ${agent.id}: registered, model discovery=${agent.modelCatalog.source ?? "configured"}`)
    }
  } else {
    console.error(`  FAIL ${preflightResult.error ?? "Daemon preflight failed."}`)
    if (preflightResult.missingHarnesses?.length) console.error(`       missing harnesses: ${preflightResult.missingHarnesses.join(", ")}`)
    if (preflightResult.missingModelCatalogs?.length) console.error(`       model discovery unavailable: ${preflightResult.missingModelCatalogs.join(", ")}`)
  }

  let discoveryResult = {
    schemaVersion: 1,
    passed: false,
    skipped: true,
    results: []
  }
  if (preflightResult.passed) {
    console.log("\n== native Session create + rediscovery ==")
    discoveryResult = await sessionDiscovery({ harnesses })
    for (const result of discoveryResult.results ?? []) {
      if (result.passed) {
        console.log(`  ok   ${result.agentID}: created Session rediscovered in ${result.pages} page(s)`)
      } else {
        console.error(`  FAIL ${result.agentID}: ${result.error ?? "native Session rediscovery failed"}`)
      }
    }
  }

  if (preflightResult.passed && discoveryResult.passed) {
    for (const pair of plan) {
      console.log(`\n========================================`)
      console.log(`Primary ${pair.primary} / secondary ${pair.secondary}`)
      console.log(`========================================`)
      const result = await runSoak({ ...pair, mode, soakPath })
      runs.push(result)
      if (!result.passed) {
        console.error(`Gate leg failed for ${pair.primary} (exit ${result.exitCode}${result.signal ? `, signal ${result.signal}` : ""}).`)
        if (result.evidenceError) console.error(`Evidence failure: ${result.evidenceError}`)
      }
    }
  }

  const allPassed = preflightResult.passed
    && discoveryResult.passed
    && runs.length === plan.length
    && runs.every((run) => run.passed)
  const verdict = !allPassed ? "failed" : eligibility.releaseEligible ? "verified" : "control-plane-only"
  const runByPrimary = new Map(runs.map((run) => [run.primary, run]))
  const discoveryByHarness = new Map((discoveryResult.results ?? []).map((result) => [result.agentID, result]))
  const coverageMatrix = Object.fromEntries(plan.map(({ primary, secondary }) => {
    const run = runByPrimary.get(primary)
    const discovery = discoveryByHarness.get(primary)
    const sessionDiscovery = discovery?.passed ?? false
    const coverage = {
      sessionDiscovery,
      ...(run?.evidence?.coverage ?? {})
    }
    const missingCoverage = [
      ...(sessionDiscovery ? [] : ["sessionDiscovery"]),
      ...(run?.evidence?.missingCoverage ?? (run ? [] : REQUIRED_SOAK_COVERAGE))
    ]
    return [primary, {
      secondary,
      complete: sessionDiscovery && (run?.evidence?.complete ?? false),
      coverage,
      missingCoverage,
      notExercised: run?.evidence?.notExercised ?? [
        "daemon restart/reconnect",
        "physical mobile background/foreground"
      ]
    }]
  }))
  const report = {
    schemaVersion: 4,
    kind: "harness-remote-real-harness-gate",
    generatedAt: new Date().toISOString(),
    source: { commit: gitCommit() },
    runtime: { platform: process.platform, arch: process.arch, node: process.version },
    endpoint: safeURL(process.env.HR_URL ?? "http://127.0.0.1:4097"),
    mode,
    releaseEligible: eligibility.releaseEligible,
    routingEvidence: eligibility.evidence,
    harnesses,
    settings: {
      cycles: Number(process.env.HR_CYCLES ?? "5"),
      turnBudgetMs: Number(process.env.HR_TURN_BUDGET_MS ?? "120000"),
      echoMarkers,
      allowTurnErrors: mode === "control-plane"
    },
    preflight: preflightResult,
    sessionDiscovery: discoveryResult,
    coverageMatrix,
    runs,
    verdict
  }

  persistReport(reportPath, report)
  return report
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes("--help")) {
    console.log(gateUsage())
    return
  }
  const known = new Set(["--harnesses", "--mode", "--report"])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!known.has(arg)) throw new Error(`Unknown option '${arg}'. Use --help for usage.`)
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${arg} requires a value.`)
    index += 1
  }

  const harnesses = parseHarnessList(optionValue(args, "--harnesses") ?? process.env.HR_GATE_HARNESSES)
  const mode = resolveGateMode(optionValue(args, "--mode") ?? process.env.HR_GATE_MODE ?? "release")
  const reportPath = path.resolve(optionValue(args, "--report") ?? process.env.HR_GATE_REPORT ?? defaultReportPath())
  const report = await runGate({ harnesses, mode, reportPath })
  if (report.verdict === "failed") process.exitCode = 1
  else if (report.verdict === "control-plane-only") process.exitCode = 2
}

const direct = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (direct) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
