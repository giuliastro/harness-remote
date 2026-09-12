import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  SUPPORTED_HARNESSES,
  buildHarnessPlan,
  defaultReportPath,
  parseHarnessList,
  parseSoakEvidence,
  preflightDaemon,
  releaseEligibility,
  resolveGateMode,
  runGate
} from "../scripts/real-harness-release-gate.mjs"

const COMPLETE_SOAK_OUTPUT = [
  "  ok   two native Sessions created on codex",
  "  ok   A turn 1 accepted with model model-a",
  "  ok   A turn 1 completed in 12ms",
  "  ok   cycle 1: claude catalog unchanged while switching away and back",
  "  ok   cycle 1: codex prompt accepted after harness switch and model change",
  "  ok   A: one user turn per accepted prompt, no duplicates (1/1)",
  "  ok   Stop accepted for codex (200)",
  "  ok   Session accepts a new prompt with a new model after Stop",
  "  ok   the interrupted turn stays visible in the transcript",
  "  ok   codex: adapter listeners did not grow unboundedly (4 -> 4)",
  "  ok   no unresolved native Session mutation left (0)"
].join("\n")

function passingSessionDiscovery(harnesses) {
  return {
    schemaVersion: 1,
    passed: true,
    results: harnesses.map((agentID) => ({
      agentID,
      passed: true,
      created: true,
      createStatus: 200,
      createdSessionID: `${agentID}-discovery-session`,
      discovered: true,
      listStatus: 200,
      pages: 1,
      error: null
    }))
  }
}

test("defaults the release gate to every supported harness", () => {
  assert.deepEqual(parseHarnessList(), SUPPORTED_HARNESSES)
})

test("normalizes and deduplicates an explicit harness list", () => {
  assert.deepEqual(parseHarnessList(" codex,CLAUDE,codex,opencode "), ["codex", "claude", "opencode"])
})

test("rejects unknown harnesses and one-harness pseudo gates", () => {
  assert.throws(() => parseHarnessList("codex,cursor"), /Unsupported harness/)
  assert.throws(() => parseHarnessList("codex"), /at least two harnesses/i)
})

test("rotates each harness through primary responsibility", () => {
  assert.deepEqual(buildHarnessPlan(["codex", "claude", "pi"]), [
    { primary: "codex", secondary: "claude" },
    { primary: "claude", secondary: "pi" },
    { primary: "pi", secondary: "codex" }
  ])
})

test("distinguishes release evidence from control-plane-only evidence", () => {
  assert.deepEqual(releaseEligibility({ mode: "release", echoMarkers: true }), {
    releaseEligible: true,
    evidence: "echo-marker",
    note: "Per-turn routing is proven with echoed markers."
  })
  assert.equal(releaseEligibility({ mode: "release", echoMarkers: false }).evidence, "turn-arrival")
  assert.deepEqual(releaseEligibility({ mode: "control-plane", echoMarkers: true }), {
    releaseEligible: false,
    evidence: "control-plane-only",
    note: "Native harness errors may count as delivered; this run cannot verify real inference."
  })
})

test("only accepts the two explicit gate modes", () => {
  assert.equal(resolveGateMode(), "release")
  assert.equal(resolveGateMode("control-plane"), "control-plane")
  assert.throws(() => resolveGateMode("quick"), /release.*control-plane/)
})

test("default report path stays outside source files and carries a timestamp", () => {
  const report = defaultReportPath("/work", new Date("2026-09-11T03:45:12.345Z"))
  assert.equal(report, path.join("/work", "artifacts", "real-harness-gate-2026-09-11T03-45-12-345Z.json"))
})

test("parses scenario-level soak evidence and exposes only the remaining real-boundary gaps", () => {
  const evidence = parseSoakEvidence(COMPLETE_SOAK_OUTPUT)
  assert.equal(evidence.complete, true)
  assert.equal(evidence.summary.failed, 0)
  assert.equal(evidence.coverage.sessionCreation, true)
  assert.equal(evidence.coverage.multiTurnStreaming, true)
  assert.equal(evidence.coverage.modelSelection, true)
  assert.equal(evidence.coverage.crossHarnessIsolation, true)
  assert.equal(evidence.coverage.transcriptFidelity, true)
  assert.equal(evidence.coverage.stopAndResume, true)
  assert.equal(evidence.coverage.resourceBounds, true)
  assert.deepEqual(evidence.missingCoverage, [])
  assert.equal(evidence.notExercised.includes("pre-existing native Session discovery"), false)
  assert.ok(evidence.notExercised.includes("daemon restart/reconnect"))
  assert.ok(evidence.notExercised.includes("physical mobile background/foreground"))
})

test("soak evidence fails closed on failed checks or silently missing scenarios", () => {
  const failed = parseSoakEvidence(`${COMPLETE_SOAK_OUTPUT}\n  FAIL no unresolved native Session mutation left (2)`)
  assert.equal(failed.complete, false)
  assert.equal(failed.summary.failed, 1)

  const incomplete = parseSoakEvidence("  ok   two native Sessions created on codex\n")
  assert.equal(incomplete.complete, false)
  assert.ok(incomplete.missingCoverage.includes("stopAndResume"))
  assert.ok(incomplete.missingCoverage.includes("resourceBounds"))
})

test("preflight accepts registered harnesses even when their model inventories may be identical", async () => {
  let authorization
  const fetchImpl = async (_url, options) => {
    authorization = options.headers.Authorization
    return new Response(JSON.stringify({
      machine: { id: "machine-1" },
      agents: [
        { id: "codex", backend: "codex", transport: "acp", state: "configured", modelCatalog: { source: "acp-config-options", cachedModels: 4, phase: "ready" } },
        { id: "claude", backend: "claude", transport: "acp", state: "configured", modelCatalog: { source: "acp-config-options", cachedModels: 4, phase: "ready" } }
      ]
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  }

  const result = await preflightDaemon({
    harnesses: ["codex", "claude"],
    user: "harness",
    pass: "secret",
    fetchImpl
  })

  assert.equal(result.passed, true)
  assert.equal(result.machineID, "machine-1")
  assert.deepEqual(result.missingHarnesses, [])
  assert.deepEqual(result.missingModelCatalogs, [])
  assert.equal(result.agents[0].modelCatalog.cachedModels, 4)
  assert.equal(result.agents[1].modelCatalog.cachedModels, 4)
  assert.match(authorization, /^Basic /)
  assert.equal(JSON.stringify(result).includes("secret"), false)
})

test("preflight reports missing harnesses and missing model discovery before the soak starts", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    machine: { id: "machine-2" },
    agents: [
      { id: "codex", backend: "codex", transport: "acp", state: "configured", modelCatalog: null }
    ]
  }), { status: 200, headers: { "Content-Type": "application/json" } })

  const result = await preflightDaemon({ harnesses: ["codex", "claude"], fetchImpl })
  assert.equal(result.passed, false)
  assert.deepEqual(result.missingHarnesses, ["claude"])
  assert.deepEqual(result.missingModelCatalogs, ["codex"])
})

test("preflight turns authentication failures into a concise gate failure", async () => {
  const result = await preflightDaemon({
    harnesses: ["codex", "claude"],
    fetchImpl: async () => new Response("nope", { status: 401 })
  })
  assert.equal(result.passed, false)
  assert.equal(result.status, 401)
  assert.match(result.error, /rejected.*credentials/i)
})

test("orchestrates every primary and persists credential-free scenario evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hr-real-gate-"))
  const soakPath = path.join(root, "fake-soak.mjs")
  const reportPath = path.join(root, "report.json")
  fs.writeFileSync(soakPath, `console.log(${JSON.stringify(COMPLETE_SOAK_OUTPUT)})\n`, "utf8")
  const previousURL = process.env.HR_URL
  process.env.HR_URL = "http://user:secret@127.0.0.1:4097"

  try {
    const report = await runGate({
      harnesses: ["codex", "claude"],
      mode: "release",
      reportPath,
      soakPath,
      preflight: async ({ harnesses }) => ({
        passed: true,
        status: 200,
        error: null,
        machineID: "machine-1",
        agents: harnesses.map((id) => ({ id, registered: true, modelCatalog: { configured: true, source: "test", cachedModels: 2, phase: "ready" } })),
        missingHarnesses: [],
        missingModelCatalogs: []
      }),
      sessionDiscovery: async ({ harnesses }) => passingSessionDiscovery(harnesses)
    })
    assert.equal(report.verdict, "verified")
    assert.equal(report.releaseEligible, true)
    assert.equal(report.schemaVersion, 4)
    assert.equal(report.preflight.passed, true)
    assert.equal(report.sessionDiscovery.passed, true)
    assert.deepEqual(report.runs.map(({ primary, secondary, passed }) => ({ primary, secondary, passed })), [
      { primary: "codex", secondary: "claude", passed: true },
      { primary: "claude", secondary: "codex", passed: true }
    ])
    assert.equal(report.runs[0].evidence.complete, true)
    assert.equal(report.runs[0].evidence.coverage.stopAndResume, true)
    assert.equal(report.coverageMatrix.codex.coverage.sessionDiscovery, true)
    assert.equal(report.coverageMatrix.codex.coverage.resourceBounds, true)
    assert.equal(report.coverageMatrix.claude.coverage.crossHarnessIsolation, true)

    const persisted = JSON.parse(fs.readFileSync(reportPath, "utf8"))
    assert.equal(persisted.endpoint, "http://127.0.0.1:4097")
    assert.equal(persisted.coverageMatrix.codex.complete, true)
    assert.equal(JSON.stringify(persisted).includes("secret"), false)
    assert.equal(JSON.stringify(persisted).includes("user:"), false)
  } finally {
    if (previousURL === undefined) delete process.env.HR_URL
    else process.env.HR_URL = previousURL
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("a zero-exit soak without required scenario evidence fails the release gate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hr-real-gate-evidence-"))
  const soakPath = path.join(root, "fake-empty-soak.mjs")
  const reportPath = path.join(root, "report.json")
  fs.writeFileSync(soakPath, "console.log('ALL CHECKS PASSED')\n", "utf8")

  try {
    const report = await runGate({
      harnesses: ["codex", "claude"],
      mode: "release",
      reportPath,
      soakPath,
      preflight: async ({ harnesses }) => ({
        passed: true,
        status: 200,
        error: null,
        machineID: "machine-1",
        agents: harnesses.map((id) => ({ id, registered: true, modelCatalog: { configured: true, source: "test", cachedModels: 2, phase: "ready" } })),
        missingHarnesses: [],
        missingModelCatalogs: []
      }),
      sessionDiscovery: async ({ harnesses }) => passingSessionDiscovery(harnesses)
    })
    assert.equal(report.verdict, "failed")
    assert.equal(report.runs[0].exitCode, 0)
    assert.equal(report.runs[0].passed, false)
    assert.equal(report.runs[0].evidence.complete, false)
    assert.match(report.runs[0].evidenceError, /without machine-readable check evidence/i)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("does not launch soak legs when native Session rediscovery fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hr-real-gate-discovery-"))
  const soakPath = path.join(root, "must-not-run.mjs")
  const markerPath = path.join(root, "ran")
  const reportPath = path.join(root, "report.json")
  fs.writeFileSync(soakPath, `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')\n`, "utf8")

  try {
    const report = await runGate({
      harnesses: ["codex", "claude"],
      mode: "release",
      reportPath,
      soakPath,
      preflight: async ({ harnesses }) => ({
        passed: true,
        status: 200,
        error: null,
        machineID: "machine-1",
        agents: harnesses.map((id) => ({ id, registered: true, modelCatalog: { configured: true, source: "test", cachedModels: 2, phase: "ready" } })),
        missingHarnesses: [],
        missingModelCatalogs: []
      }),
      sessionDiscovery: async () => ({
        schemaVersion: 1,
        passed: false,
        results: [
          { agentID: "codex", passed: false, error: "Session missing from index", pages: 1 },
          { agentID: "claude", passed: true, pages: 1 }
        ]
      })
    })
    assert.equal(report.verdict, "failed")
    assert.equal(report.runs.length, 0)
    assert.equal(report.coverageMatrix.codex.coverage.sessionDiscovery, false)
    assert.ok(report.coverageMatrix.codex.missingCoverage.includes("sessionDiscovery"))
    assert.equal(fs.existsSync(markerPath), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("does not launch any discovery or soak leg when daemon preflight fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hr-real-gate-preflight-"))
  const soakPath = path.join(root, "must-not-run.mjs")
  const markerPath = path.join(root, "ran")
  const reportPath = path.join(root, "report.json")
  fs.writeFileSync(soakPath, `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')\n`, "utf8")
  let discoveryCalls = 0

  try {
    const report = await runGate({
      harnesses: ["codex", "claude"],
      mode: "release",
      reportPath,
      soakPath,
      preflight: async () => ({
        passed: false,
        status: 200,
        error: null,
        machineID: "machine-1",
        agents: [],
        missingHarnesses: ["claude"],
        missingModelCatalogs: []
      }),
      sessionDiscovery: async () => {
        discoveryCalls += 1
        return passingSessionDiscovery(["codex", "claude"])
      }
    })
    assert.equal(report.verdict, "failed")
    assert.deepEqual(report.runs, [])
    assert.equal(report.sessionDiscovery.skipped, true)
    assert.equal(discoveryCalls, 0)
    assert.equal(fs.existsSync(markerPath), false)
    assert.equal(JSON.parse(fs.readFileSync(reportPath, "utf8")).preflight.missingHarnesses[0], "claude")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
