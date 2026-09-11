import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const workspace = readFileSync(new URL("./components/standalone-universal-workspace.tsx", import.meta.url), "utf8")
const lineageCss = readFileSync(new URL("./session-handoff-routing.css", import.meta.url), "utf8")

test("open Native Session keeps machine Project harness and native id visible", () => {
  assert.match(workspace, /selected\.agentLabel/, "the owning harness label must remain visible")
  assert.match(workspace, /selected\.nativeAgent/, "native agent or mode stays visible when the harness reports it")
  assert.match(workspace, /selectedMachine\?\.name/, "the selected machine identity must remain visible")
  assert.match(workspace, /selectedProject/, "the Project identity must remain visible")
  assert.match(
    workspace,
    /<code title=\{selected\.sessionID\}>\{selected\.sessionID\}<\/code>/,
    "the harness-owned native Session id must remain directly inspectable"
  )
})

test("lineage lookup and navigation use the full native identity tuple", () => {
  assert.match(
    workspace,
    /api\.listNativeSessionLinks\(selectedRuntime\.machine\.config, selected\.ref\)/,
    "lineage must be queried by the selected NativeSessionRef, not by a synthetic conversation id"
  )
  assert.match(workspace, /link\.target\.machineID === selected\.machineID/)
  assert.match(workspace, /link\.target\.agentID === selected\.agentID/)
  assert.match(workspace, /link\.target\.sessionID === selected\.sessionID/)
  assert.match(workspace, /candidate\.snapshot\?\.machine\.id === ref\.machineID/)
  assert.match(workspace, /candidate\.id === ref\.agentID/)
  assert.match(workspace, /candidate\.session\.id === ref\.sessionID/)
  assert.match(workspace, /selectedLinks\.map\(\(link\) =>/)
  assert.match(workspace, /linkedDestination\(link\)/)
})

test("lineage remains optional read-only enrichment", () => {
  assert.match(
    workspace,
    /Lineage is optional enrichment\./,
    "a lineage read failure must not make the Native Session unusable"
  )
  assert.match(workspace, /setSelectedLinks\(\[\]\)/)
  assert.doesNotMatch(
    workspace,
    /registerNativeSessionLink\([^)]*selectedLinks/,
    "rendering lineage must never manufacture or rewrite links"
  )
})

test("identity and previous next lineage remain legible on narrow mobile panes", () => {
  assert.match(lineageCss, /\.hr-native-session-eyebrow\s*\{[\s\S]*flex-wrap:\s*wrap/)
  assert.match(lineageCss, /\.hr-native-workspace-session-header code\s*\{[\s\S]*font-variant-numeric:\s*tabular-nums/)
  assert.match(lineageCss, /\.hr-session-lineage-links\s*\{[\s\S]*grid-template-columns:\s*repeat\(auto-fit/)
  assert.match(lineageCss, /\.hr-session-lineage-link\s*\{[\s\S]*border-left:\s*3px solid var\(--td3-blue-border\)/)
  assert.match(lineageCss, /@media \(max-width: 780px\)[\s\S]*\.hr-session-lineage-links \{ grid-template-columns: 1fr; \}/)
})
