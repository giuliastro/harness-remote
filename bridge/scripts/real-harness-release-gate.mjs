#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { verifyRealHarnessSessionDiscovery } from "./real-harness-session-discovery.mjs"

export const SUPPORTED_HARNESSES = ["opencode", "codex", "claude", "omp", "pi", "copilot", "opencode2", "mimo"]

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

function optionValues(args, name) {
  const values = []
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] === name) values.push(args[index + 1])
  }
  return values
}

export function parseHarnessList(value = SUPPORTED_HARNESSES.join(",")) {
  const requested = value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean)
  const harnesses = [...new Set(requested)]
  if (harnesses.length < 2) throw new Error("Real-harness release validation requires at least two harnesses so isolation can be exercised.")
  const unsupported = harnesses.filter((harness) => !SUPPORTED_HARNESSES.includes(harness))
  if (unsupported.length) throw new Error(`Unsupported harness(es): ${unsupported.join(", ")}. Supported: ${SUPPORTED_HARNESSES.join(", ")}.`)
  return harnesses
}

export function parseInferenceUnavailable(value = "", harnesses = SUPPORTED_HARNESSES) {
  const requested = value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean)
  const unavailable = [...new Set(requested)]
  const outsideGate = unavailable.filter((harness) => !harnesses.includes(harness))
  if (outsideGate.length) {
    throw new Error(`Inference-unavailable harness(es) must also be selected by --harnesses: ${outsideGate.join(", ")}.`)
  }
  return unavailable
}

export function parseModelOverrides(values = [], harnesses = SUPPORTED_HARNESSES) {
  const overrides = {}
  for (const rawValue of values) {
    const raw = String(rawValue ?? "")
    const separator = raw.indexOf("=")
    if (separator <= 0 || separator === raw.length - 1) {
      throw new Error("--model must use <harness>=<model-id-or-provider/model>.")
    }
    const harness = raw.slice(0, separator).trim().toLowerCase()
    const selector = raw.slice(separator + 1).trim()
    if (!harness || !selector) throw new Error("--model must use <harness>=<model-id-or-provider/model>.")
    if (!harnesses.includes(harness)) {
      throw new Error(`Model override harness '${harness}' must also be selected by --harnesses.`)
    }
    overrides[harness] ??= []
    if (!overrides[harness].includes(selector)) overrides[harness].push(selector)
  }

  for (const [harness, selectors] of Object.entries(overrides)) {
    if (selectors.length < 2) {
      throw new Error(`Explicit release model selection for ${harness} requires at least two distinct --model entries so model switching is exercised.`)
    }
  }
  return overrides
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
  const modelsSupported = agent?.capabilities?.models === true
  const modelSelection = agent?.contract?.models?.selection
    ?? (modelsSupported ? "required" : "harness-default")
  return {
    id: agentID,
    registered: Boolean(agent),
    backend: agent?.backend ?? null,
    transport: agent?.transport ?? null,
    state: agent?.state ?? null,
    modelsSupported,
    modelSelection,
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
    const missingModelCatalogs = selected
      .filter((agent) => agent.registered && agent.modelsSupported && agent.modelSelection !== "harness-default" && !agent.modelCatalog.configured)
      .map((agent) => agent.id)
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
    modelSelection:
      hasPassed(checks, /turn \d+ accepted with model /i)
      || hasPassed(checks, /harness-default model policy verified/i),
    crossHarnessIsolation:
      (
        hasPassed(checks, /catalog unchanged (?:while switching away and back|after visiting)/i)
        || hasPassed(checks, /harness-default model policy unchanged (?:while switching away and back|after visiting)/i)
      )
      && hasPassed(checks, /prompt accepted after harness switch and model (?:change|policy check)/i),
    transcriptFidelity: hasPassed(checks, /one user turn per accepted prompt, no duplicates/i),
    stopAndResume:
      hasPassed(checks, /Stop accepted for /i)
      && hasPassed(checks, /Session accepts a new prompt with (?:a new model|harness-default model policy) after Stop/i)
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
  return `Usage: npm run gate:real-harness -- [options]\n\nOptions:\n  --harnesses <list>             Comma-separated harnesses to verify (default: ${SUPPORTED_HARNESSES.join(",")})\n  --model <harness>=<model>      Repeat to select at least two known-working models for one harness\n  --inference-unavailable <list> Selected harnesses with no usable inference on this machine\n  --mode <mode>                  release (default) or control-plane\n  --report <path>                JSON evidence report path (default: artifacts/real-harness-gate-<timestamp>.json)\n  --help                         Show this help\n\nThe gate first checks /v1/diagnostics and stops early if the daemon is unreachable, credentials are rejected, a requested harness is not registered, or model discovery is not configured. It then health-checks every requested installed harness through its agent-scoped /global/health route and requires a concrete reported version so the release evidence identifies the actual harness build under test. Only then does it create one harmless probe Session per harness and require that exact native id to be rediscovered through the bounded Session index before inference-heavy soak legs begin. Repeat --model for a harness to constrain its inference soak to known-working advertised model IDs; at least two distinct selectors are required so model switching remains exercised. Harnesses declared with --inference-unavailable still must pass preflight and native Session rediscovery, but their inference-heavy primary soak is skipped and the overall run is recorded as inference-unverified, never verified. Each attempted real-harness leg must also emit the complete scenario evidence contract (Session creation, multi-turn streaming, model selection, cross-harness isolation, transcript fidelity, Stop/recovery and bounded resources); a zero exit code without that evidence fails closed. Shared soak settings use HR_URL, HR_USER, HR_PASS, HR_DIR_A, HR_DIR_B, HR_CYCLES, HR_TURN_BUDGET_MS and HR_ECHO_MARKERS. Release mode always disables HR_ALLOW_TURN_ERRORS. Use --mode control-plane when inference is unavailable for the whole selected surface; that mode is recorded as not release-eligible.`
}

async function runSoak({ primary, secondary, mode, soakPath, modelSelectors = [] }) {
  const startedAt = new Date()
  const started = Date.now()
  const env = {
    ...process.env,
    HR_PRIMARY: primary,
    HR_SECONDARY: secondary,
    HR_PRIMARY_MODELS: JSON.stringify(modelSelectors),
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
    modelSelectors,
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
  inferenceUnavailable = [],
  modelOverrides = {},
  soakPath = fileURLToPath(new URL("./session-first-soak.mjs", import.meta.url)),
  preflight = preflightDaemon,
  sessionDiscovery = verifyRealHarnessSessionDiscovery
}) {
  const unknownUnavailable = inferenceUnavailable.filter((harness) => !harnesses.includes(harness))
  if (unknownUnavailable.length) {
    throw new Error(`Inference-unavailable harness(es) must also be selected by the gate: ${unknownUnavailable.join(", ")}.`)
  }
  const unknownModelHarnesses = Object.keys(modelOverrides).filter((harness) => !harnesses.includes(harness))
  if (unknownModelHarnesses.length) {
    throw new Error(`Model override harness(es) must also be selected by the gate: ${unknownModelHarnesses.join(", ")}.`)
  }
  const conflictingModelHarnesses = inferenceUnavailable.filter((harness) => modelOverrides[harness]?.length)
  if (conflictingModelHarnesses.length) {
    throw new Error(`Harness(es) cannot be both inference-unavailable and given explicit models: ${conflictingModelHarnesses.join(", ")}.`)
  }
  const shortModelSelections = Object.entries(modelOverrides).filter(([, selectors]) => new Set(selectors).size < 2).map(([harness]) => harness)
  if (shortModelSelections.length) {
    throw new Error(`Explicit release model selection requires at least two distinct models for: ${shortModelSelections.join(", ")}.`)
  }

  const unavailable = new Set(inferenceUnavailable)
  const echoMarkers = process.env.HR_ECHO_MARKERS !== "0"
  const eligibility = releaseEligibility({ mode, echoMarkers })
  const plan = buildHarnessPlan(harnesses)
  const attemptedPlan = plan.filter(({ primary }) => !unavailable.has(primary))
  const runs = []

  console.log(`Harness Remote real-harness gate: mode=${mode}`)
  console.log(`Harnesses: ${harnesses.join(", ")}`)
  if (unavailable.size) console.log(`Inference unavailable/unverified: ${[...unavailable].join(", ")}`)
  if (Object.keys(modelOverrides).length) {
    for (const [harness, selectors] of Object.entries(modelOverrides)) {
      console.log(`Explicit models for ${harness}: ${selectors.join(", ")}`)
    }
  }
  console.log(`Evidence: ${eligibility.evidence}`)
  console.log(eligibility.note)

  console.log("\n== daemon preflight ==")
  const preflightResult = await preflight({ harnesses })
  if (preflightResult.passed) {
    for (const agent of preflightResult.agents) {
      const modelEvidence = agent.modelsSupported && agent.modelSelection !== "harness-default"
        ? `model discovery=${agent.modelCatalog.source ?? "configured"}`
        : "model policy=harness-default"
      console.log(`  ok   ${agent.id}: registered, ${modelEvidence}`)
    }
  } else {
    console.error(`  FAIL ${preflightResult.error ?? "Daemon preflight failed."}`)
    if (preflightResult.missingHarnesses?.length) console.error(`       missing harnesses: ${preflightResult.missingHarnesses.join(", ")}`)
    if (preflightResult.missingModelCatalogs?.length) console.error(`       model discovery unavailable: ${preflightResult.missingModelCatalogs.join(", ")}`)
  }

  let discoveryResult = {
    schemaVersion: 2,
    passed: false,
    skipped: true,
    results: []
  }
  if (preflightResult.passed) {
    console.log("\n== installed harness health + build identity + native Session rediscovery ==")
    discoveryResult = await sessionDiscovery({ harnesses })
    for (const result of discoveryResult.results ?? []) {
      if (result.passed) {
        console.log(`  ok   ${result.agentID} ${result.version}: created Session rediscovered in ${result.pages} page(s)`)
      } else {
        console.error(`  FAIL ${result.agentID}${result.version ? ` ${result.version}` : ""}: ${result.error ?? "native Session rediscovery failed"}`)
      }
    }
  }

  if (preflightResult.passed && discoveryResult.passed) {
    for (const pair of plan) {
      console.log(`\n========================================`)
      console.log(`Primary ${pair.primary} / secondary ${pair.secondary}`)
      console.log(`========================================`)
      if (unavailable.has(pair.primary)) {
        console.log(`  skip inference for ${pair.primary}: declared unavailable on this machine; preflight and Session rediscovery remain required`)
        continue
      }
      const result = await runSoak({
        ...pair,
        mode,
        soakPath,
        modelSelectors: modelOverrides[pair.primary] ?? []
      })
      runs.push(result)
      if (!result.passed) {
        console.error(`Gate leg failed for ${pair.primary} (exit ${result.exitCode}${result.signal ? `, signal ${result.signal}` : ""}).`)
        if (result.evidenceError) console.error(`Evidence failure: ${result.evidenceError}`)
      }
    }
  }

  const attemptedPassed = preflightResult.passed
    && discoveryResult.passed
    && runs.length === attemptedPlan.length
    && runs.every((run) => run.passed)
  const hasUnverifiedInference = unavailable.size > 0
  const verdict = !attemptedPassed
    ? "failed"
    : mode === "control-plane"
      ? "control-plane-only"
      : hasUnverifiedInference
        ? "inference-unverified"
        : "verified"
  const releaseEligible = verdict === "verified"
  const runByPrimary = new Map(runs.map((run) => [run.primary, run]))
  const discoveryByHarness = new Map((discoveryResult.results ?? []).map((result) => [result.agentID, result]))
  const coverageMatrix = Object.fromEntries(plan.map(({ primary, secondary }) => {
    const run = runByPrimary.get(primary)
    const discovery = discoveryByHarness.get(primary)
    const sessionDiscovery = discovery?.passed ?? false
    const inferenceStatus = unavailable.has(primary)
      ? "unverified"
      : run?.passed
        ? mode === "control-plane" ? "control-plane-only" : "verified"
        : "failed"
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
      inferenceStatus,
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
    schemaVersion: 6,
    kind: "harness-remote-real-harness-gate",
    generatedAt: new Date().toISOString(),
    source: { commit: gitCommit() },
    runtime: { platform: process.platform, arch: process.arch, node: process.version },
    endpoint: safeURL(process.env.HR_URL ?? "http://127.0.0.1:4097"),
    mode,
    releaseEligible,
    routingEvidence: eligibility.evidence,
    harnesses,
    settings: {
      cycles: Number(process.env.HR_CYCLES ?? "5"),
      turnBudgetMs: Number(process.env.HR_TURN_BUDGET_MS ?? "120000"),
      echoMarkers,
      allowTurnErrors: mode === "control-plane",
      inferenceUnavailable: [...unavailable],
      modelOverrides
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
  const known = new Set(["--harnesses", "--model", "--inference-unavailable", "--mode", "--report"])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!known.has(arg)) throw new Error(`Unknown option '${arg}'. Use --help for usage.`)
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${arg} requires a value.`)
    index += 1
  }

  const harnesses = parseHarnessList(optionValue(args, "--harnesses") ?? process.env.HR_GATE_HARNESSES)
  const inferenceUnavailable = parseInferenceUnavailable(
    optionValue(args, "--inference-unavailable") ?? process.env.HR_GATE_INFERENCE_UNAVAILABLE ?? "",
    harnesses
  )
  const modelOverrides = parseModelOverrides(optionValues(args, "--model"), harnesses)
  const mode = resolveGateMode(optionValue(args, "--mode") ?? process.env.HR_GATE_MODE ?? "release")
  const reportPath = path.resolve(optionValue(args, "--report") ?? process.env.HR_GATE_REPORT ?? defaultReportPath())
  const report = await runGate({ harnesses, mode, reportPath, inferenceUnavailable, modelOverrides })
  if (report.verdict === "failed") process.exitCode = 1
  else if (report.verdict === "control-plane-only" || report.verdict === "inference-unverified") process.exitCode = 2
}

const direct = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (direct) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
