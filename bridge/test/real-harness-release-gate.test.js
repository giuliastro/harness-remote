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

test("orchestrates every primary and persists credential-free release evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hr-real-gate-"))
  const soakPath = path.join(root, "fake-soak.mjs")
  const reportPath = path.join(root, "report.json")
  fs.writeFileSync(soakPath, "process.exit(0)\n", "utf8")
  const previousURL = process.env.HR_URL
  process.env.HR_URL = "http://user:secret@127.0.0.1:4097"

  try {
    const report = await runGate({ harnesses: ["codex", "claude"], mode: "release", reportPath, soakPath })
    assert.equal(report.verdict, "verified")
    assert.equal(report.releaseEligible, true)
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
