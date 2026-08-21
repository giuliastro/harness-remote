import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const mobileCss = readFileSync(new URL("./taskdesk-mobile-ux.css", import.meta.url), "utf8")
const surfaceCss = readFileSync(new URL("./taskdesk-mobile-surfaces.css", import.meta.url), "utf8")
const continueCss = readFileSync(new URL("./taskdesk-continue.css", import.meta.url), "utf8")
const continueSource = readFileSync(new URL("./components/taskdesk-intelligent-continue.tsx", import.meta.url), "utf8")
const workspaceSource = readFileSync(new URL("./components/universal-workspace.tsx", import.meta.url), "utf8")
const unifiedSource = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")
const machineSource = readFileSync(new URL("./components/standalone-universal-workspace.tsx", import.meta.url), "utf8")
const mainSource = readFileSync(new URL("./main.tsx", import.meta.url), "utf8")

test("mobile Session conversation prioritizes transcript and composer over desktop metadata", () => {
  assert.match(mainSource, /import "\.\/taskdesk-mobile-ux\.css"/)
  assert.match(mainSource, /import "\.\/taskdesk-mobile-surfaces\.css"/)
  assert.match(mobileCss, /td3-mobile-session-detail \.uw-context-strip[\s\S]*display:\s*none/)
  assert.match(mobileCss, /\.uw-session-actions > \.uw-button:last-child/)
  assert.match(mobileCss, /:has\(\.uw-composer-shell textarea:focus\)[\s\S]*\.uw-session-header/)
  assert.match(mobileCss, /:has\(\.uw-composer-shell textarea:focus\)[\s\S]*\.uw-detail-tabs/)
  assert.match(mobileCss, /\.uw-composer-shell textarea[\s\S]*font-size:\s*16px/)
  assert.match(surfaceCss, /td3-mobile-session-detail \.uw-composer-footer[\s\S]*justify-content:\s*flex-end/)
  assert.match(surfaceCss, /td3-mobile-session-detail \.uw-composer-footer \.uw-button[\s\S]*min-height:\s*40px/)
})

test("mobile Sessions chrome keeps title and actions on one row and makes Session details functional", () => {
  assert.match(surfaceCss, /:has\(\.td3-sessions-embedded\) \.td3-topbar-unified[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto auto/)
  assert.match(surfaceCss, /:has\(\.td3-sessions-embedded\) \.td3-view-context small[\s\S]*display:\s*none/)
  assert.match(surfaceCss, /\.td3-sessions-embedded \.uw-inspector[\s\S]*display:\s*block/)
  assert.match(workspaceSource, /const \[inspectorOpen, setInspectorOpen\] = useState\(false\)/)
  assert.match(workspaceSource, /setInspectorOpen\(\(value\) => !value\)/)
})

test("Sessions consumes New Session and refresh requests once instead of replaying them after remount", () => {
  assert.match(workspaceSource, /appliedNewSessionRequest = useRef\(newSessionRequest \?\? 0\)/)
  assert.match(workspaceSource, /newSessionRequest === appliedNewSessionRequest\.current/)
  assert.match(workspaceSource, /appliedNewSessionRequest\.current = newSessionRequest/)
  assert.match(workspaceSource, /appliedRefreshRequest = useRef\(refreshRequest \?\? 0\)/)
  assert.match(workspaceSource, /refreshRequest === appliedRefreshRequest\.current/)
  assert.match(workspaceSource, /appliedRefreshRequest\.current = refreshRequest/)
})

test("Session refresh preserves last-known Sessions when an agent or machine times out", () => {
  assert.match(workspaceSource, /sessionsRef\.current\.filter\(\(item\) => item\.machineKey === machine\.key && item\.agent\.id === agent\.id\)/)
  assert.match(workspaceSource, /preservedOffline[\s\S]*sessionsRef\.current\.filter/)
  assert.match(workspaceSource, /Last known Sessions are kept/)
  assert.match(workspaceSource, /refreshRequest[\s\S]*refreshAll\(false\)/)
})

test("mobile Continue exposes Run settings explicitly while preserving the Task title", () => {
  assert.match(continueSource, /const taskHeading = record\.task\.prompt\.split/)
  assert.match(continueSource, /<h2>\{taskHeading\}<\/h2>/)
  assert.match(continueSource, /className=\{`td3-continue-settings\$\{settingsOpen \? " open" : ""\}`\}/)
  assert.match(continueSource, /className="td3-continue-settings-summary"/)
  assert.match(continueSource, /className="td3-continue-settings-toggle"/)
  assert.match(continueSource, /className="td3-continue-settings-body"/)
  assert.match(continueSource, /<details className="td3-continue-context" open>/)
  assert.match(continueSource, /className="td3-continue-wide td3-continue-prompt"/)
  assert.match(continueCss, /\.td3-intelligent-continue > header h2[\s\S]*-webkit-line-clamp:\s*2/)
  assert.match(continueCss, /\.td3-continue-settings-toggle[\s\S]*min-height:\s*36px/)
})

test("Task detail follows the current Run harness for Session, conversation and diff routing", () => {
  assert.match(unifiedSource, /function currentRunAgentID\(task: MachineTask\)/)
  assert.match(unifiedSource, /const agentID = currentRunAgentID\(record\.task\)/)
  assert.match(unifiedSource, /record\.runtime\.agents\.find\(\(candidate\) => candidate\.id === agentID\)/)
  assert.match(unifiedSource, /const config = configForAgent\(record\.runtime, agent\)/)
  assert.match(unifiedSource, /openNativeSession\(selected\.runtime, selectedSessionID, selectedRunAgentID\)/)
  assert.match(unifiedSource, /SessionFocusRequest = \{ sessionID: string; requestID: number; agentID\?: string \}/)
})

test("Task Diff never shows a non-zero badge with an unexplained empty panel", () => {
  assert.match(unifiedSource, /const workspaceChangedFiles =/)
  assert.match(unifiedSource, /detail\.diff\.length \? detail\.diff\.map/)
  assert.match(unifiedSource, /workspaceChangedFiles\.length \? workspaceChangedFiles\.map/)
  assert.match(unifiedSource, /detailChangeCount \? <div className="td3-empty-state"/)
})

test("machine editor separates connection testing from save and hides parent add action while editing", () => {
  assert.match(machineSource, /className="uw-machine-test-block"/)
  assert.match(machineSource, /className="uw-machine-editor-actions"[\s\S]*Cancel[\s\S]*Add machine/)
  assert.match(machineSource, /className=\{`uw-machine-manager\$\{draft \? " editing" : ""\}`\}/)
  assert.match(machineSource, /\{!draft \? \([\s\S]*uw-machine-manager-footer/)
  assert.match(machineSource, /uw-manager-done/)
  assert.match(mobileCss, /\.uw-machine-manager \.uw-manager-close[\s\S]*display:\s*none/)
})

test("mobile Task detail is a page with a true 2x2 action grid and no desktop metadata wall", () => {
  assert.match(mobileCss, /\.td3-task-detail-open \.td3-detail-meta[\s\S]*display:\s*none/)
  assert.match(mobileCss, /\.td3-task-detail-open \.td3-detail-close::before[\s\S]*content:\s*"←"/)
  assert.match(mobileCss, /\.td3-task-detail-open \.td3-detail-actions[\s\S]*position:\s*static/)
  assert.match(surfaceCss, /\.td3-task-detail-open \.td3-detail-actions[\s\S]*grid-template-columns:\s*repeat\(2/)
  assert.match(surfaceCss, /\.td3-task-detail-open \.td3-detail-actions-primary[\s\S]*display:\s*contents/)
  assert.match(surfaceCss, /\.td3-detail-actions > \.td3-button\.danger[\s\S]*grid-column:\s*auto/)
})

test("shared phone wizards use one full-screen dismissal hierarchy", () => {
  assert.match(mobileCss, /\.modal-card\.wizard[\s\S]*height:\s*100dvh/)
  assert.match(mobileCss, /\.wizard-header \.wizard-close[\s\S]*display:\s*none/)
  assert.match(mobileCss, /:has\(#new-session-title\) \.wizard-header \.btn-icon/)
  assert.match(mobileCss, /\.wizard-body[\s\S]*overflow-y:\s*auto/)
})

test("New Task and Run Review become keyboard-safe full-screen phone pages", () => {
  assert.match(surfaceCss, /:has\(> \.td3-new-task\)[\s\S]*:has\(> \.td3-run-review\)/)
  assert.match(surfaceCss, /\.td3-new-task,[\s\S]*\.td3-run-review[\s\S]*height:\s*100dvh/)
  assert.match(surfaceCss, /\.td3-new-task \.td3-form-grid[\s\S]*grid-template-columns:\s*1fr/)
  assert.match(surfaceCss, /\.td3-new-task :is\(select, textarea, input:not\(\[type="checkbox"\]\)\)[\s\S]*font-size:\s*16px/)
  assert.match(surfaceCss, /\.td3-run-review-meta[\s\S]*grid-template-columns:\s*repeat\(2/)
})

test("short Settings and More surfaces are phone bottom sheets with one dismissal hierarchy", () => {
  assert.match(surfaceCss, /:has\(> \.td3-settings-modal\)[\s\S]*:has\(> \.td3-more-sheet\)/)
  assert.match(surfaceCss, /place-items:\s*end stretch/)
  assert.match(surfaceCss, /\.td3-settings-modal > header > button[\s\S]*display:\s*none/)
  assert.doesNotMatch(surfaceCss, /\.td3-more-sheet > header > button[\s\S]*display:\s*none/)
})

test("simple information pages and Needs You reduce chrome and avoid action overflow on phones", () => {
  assert.match(surfaceCss, /\.td3-simple-page \.td3-page-heading small,[\s\S]*\.td3-simple-page \.td3-page-heading p[\s\S]*display:\s*none/)
  assert.match(surfaceCss, /\.td3-attention-card > footer[\s\S]*grid-template-columns:\s*repeat\(2/)
  assert.match(surfaceCss, /\.td3-attention-card > footer > \.td3-link-button:first-child[\s\S]*grid-column:\s*1 \/ -1/)
})
