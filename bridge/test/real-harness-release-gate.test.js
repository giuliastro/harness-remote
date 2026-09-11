import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import {
  SUPPORTED_HARNESSES,
  buildHarnessPlan,
  defaultReportPath,
  parseHarnessList,
  releaseEligibility,
  resolveGateMode
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
