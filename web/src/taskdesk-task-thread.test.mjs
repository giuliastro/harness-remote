import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const unifiedSource = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")
const threadSource = readFileSync(new URL("./components/taskdesk-task-thread.tsx", import.meta.url), "utf8")
const liveCss = readFileSync(new URL("./taskdesk-live-state.css", import.meta.url), "utf8")
const mainSource = readFileSync(new URL("./main.tsx", import.meta.url), "utf8")

test("Tasks open as durable work conversations instead of report-first inspectors", () => {
  assert.match(unifiedSource, /useState<DetailTab>\("conversation"\)/)
  assert.match(unifiedSource, /function openTask\(record: TaskRecord, tab: DetailTab = "conversation"\)/)
  assert.match(unifiedSource, /<TaskRunHistoryThread task=\{selected\.task\}/)
  assert.match(unifiedSource, /<TaskQuickContinue[\s\S]*onAdvanced=\{\(\) => setContinueOpen\(true\)\}/)
})

test("Task quick continue keeps chat-like iteration simple while advanced handoff stays available", () => {
  assert.match(threadSource, /taskClient\.continueTask\(config, task\.id, text\)/)
  assert.match(threadSource, /className="td3-task-composer"/)
  assert.match(threadSource, /className="td3-button td3-composer-settings"/)
  assert.match(threadSource, /className="td3-button primary td3-composer-send"/)
})

test("Result Summary is a primary expandable surface and prefers the native terminal answer", () => {
  assert.match(unifiedSource, /const terminalSummary = detailReady[\s\S]*assistantTerminalTextForPrompt/)
  assert.match(unifiedSource, /const summary = terminalSummary \|\| selected\?\.task\.run\?\.outcome \|\| ""/)
  assert.match(unifiedSource, /className="td3-result-open"/)
  assert.match(unifiedSource, /<ResultSummaryModal/)
  assert.match(threadSource, /className="td3-modal td3-result-modal"/)
  assert.match(liveCss, /\.td3-markdown,[\s\S]*overflow-wrap:\s*anywhere/)
  assert.match(liveCss, /\.td3-markdown pre[\s\S]*overflow-x:\s*auto/)
})

test("Working state uses restrained live animation across Tasks and native Sessions", () => {
  assert.match(mainSource, /import "\.\/taskdesk-live-state\.css"/)
  assert.match(liveCss, /\.td3-status-pill\.td3-status-active[\s\S]*animation:\s*td3-live-breathe/)
  assert.match(liveCss, /\.td3-run-live[\s\S]*animation:\s*td3-run-live-shift/)
  assert.match(liveCss, /\.uw-status-chip\.uw-status-working[\s\S]*animation:\s*td3-live-breathe/)
  assert.match(liveCss, /\.uw-session-accent\.uw-status-working[\s\S]*animation:\s*td3-session-accent-flow/)
  assert.match(liveCss, /@media \(prefers-reduced-motion: reduce\)/)
})
