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
  preflightDaemon,
  releaseEligibility,
  resolveGateMode,
  runGate
} from "../scripts/real-harness-release-gate.mjs"

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

test("orchestrates every primary and persists credential-free release evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hr-real-gate-"))
  const soakPath = path.join(root, "fake-soak.mjs")
  const reportPath = path.join(root, "report.json")
  fs.writeFileSync(soakPath, "process.exit(0)\n", "utf8")
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
      })
    })
    assert.equal(report.verdict, "verified")
    assert.equal(report.releaseEligible, true)
    assert.equal(report.schemaVersion, 2)
    assert.equal(report.preflight.passed, true)
    assert.deepEqual(report.runs.map(({ primary, secondary, passed }) => ({ primary, secondary, passed })), [
      { primary: "codex", secondary: "claude", passed: true },
      { primary: "claude", secondary: "codex", passed: true }
    ])

    const persisted = JSON.parse(fs.readFileSync(reportPath, "utf8"))
    assert.equal(persisted.endpoint, "http://127.0.0.1:4097")
    assert.equal(JSON.stringify(persisted).includes("secret"), false)
    assert.equal(JSON.stringify(persisted).includes("user:"), false)
  } finally {
    if (previousURL === undefined) delete process.env.HR_URL
    else process.env.HR_URL = previousURL
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("does not launch any soak leg when daemon preflight fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hr-real-gate-preflight-"))
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
      preflight: async () => ({
        passed: false,
        status: 200,
        error: null,
        machineID: "machine-1",
        agents: [],
        missingHarnesses: ["claude"],
        missingModelCatalogs: []
      })
    })
    assert.equal(report.verdict, "failed")
    assert.deepEqual(report.runs, [])
    assert.equal(fs.existsSync(markerPath), false)
    assert.equal(JSON.parse(fs.readFileSync(reportPath, "utf8")).preflight.missingHarnesses[0], "claude")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
