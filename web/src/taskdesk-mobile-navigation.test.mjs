import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const standalone = readFileSync(new URL("./components/standalone-universal-workspace.tsx", import.meta.url), "utf8")
const home = readFileSync(new URL("./components/native-session-home.tsx", import.meta.url), "utf8")
const mobile = readFileSync(new URL("./taskdesk-mobile-navigation.css", import.meta.url), "utf8")
const controlPlane = readFileSync(new URL("./conversation-control-plane-overrides.css", import.meta.url), "utf8")
const sessionFirstNavigation = readFileSync(new URL("./session-first-navigation.css", import.meta.url), "utf8")
const mobilePolish = readFileSync(new URL("./conversation-control-plane-mobile-polish.css", import.meta.url), "utf8")
const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8")
const machineClient = readFileSync(new URL("./machineClient.ts", import.meta.url), "utf8")
const taskClient = readFileSync(new URL("./taskClient.ts", import.meta.url), "utf8")

test("mobile opens a native Session explicitly and can return to the Session list", () => {
  assert.match(standalone, /const \[mobileDetailOpen, setMobileDetailOpen\] = useState\(false\)/)
  assert.match(standalone, /function openSession\(target: NativeSessionSurfaceTarget\)[\s\S]*?setSelected\(target\)[\s\S]*?setMobileDetailOpen\(true\)/)
  assert.match(standalone, /hr-native-workspace-detail\$\{mobileDetailOpen \? " mobile-open" : ""\}/)
  assert.match(standalone, /className="tdw-mobile-back" onClick=\{\(\) => setMobileDetailOpen\(false\)\}/)
  assert.match(standalone, /import "\.\.\/taskdesk-mobile-navigation\.css"/)
  assert.match(mobile, /@media \(max-width: 780px\)/)
  assert.match(mobile, /\.tdw-mobile-back \{[\s\S]*?display: flex/)
})

test("mobile Session rail keeps native Project grouping and explicit filters", () => {
  assert.match(home, /function projectGroups\(/)
  assert.match(home, /type SessionFilter = "all" \| "working" \| "attention"/)
  assert.match(home, /selectedKey\?: string/)
  assert.match(home, /COLLAPSED_PROJECT_SESSION_COUNT = 5/)
  assert.match(home, /sessionTreeRows/)
})

test("mobile project and action controls remain touch and keyboard friendly", () => {
  assert.match(mobile, /@media \(max-width: 780px\)/)
  assert.match(mobile, /overflow-x: auto/)
  assert.match(mobile, /touch-action: manipulation/)
  assert.match(mobile, /\.tdw-thread-search input \{[\s\S]*?font-size: 16px/)
  assert.match(mobile, /\.tdw-modal select,[\s\S]*?font-size: 16px/)
  assert.match(mobile, /\.tdw-modal \{[\s\S]*?max-height: 94dvh/)
  assert.match(mobile, /\.tdw-modal-body \{[\s\S]*?overflow-y: auto !important/)
  assert.match(mobile, /\.tdw-model-popover \{[\s\S]*?position: fixed !important[\s\S]*?bottom: max\(10px, env\(safe-area-inset-bottom\)\)/)
})

test("mobile has exactly Sessions Machines and Settings durable destinations", () => {
  assert.match(standalone, /<nav className="hr-mobile-nav" aria-label=\{t\("sf\.mainNavigation"\)\}>/)
  assert.match(standalone, /const mobileSection = managerOpen \? "machines" : settingsOpen \? "settings" : "sessions"/)
  assert.match(standalone, /t\("nav\.sessions"\)/)
  assert.match(standalone, /t\("sf\.machines"\)/)
  assert.match(standalone, /t\("nav\.settings"\)/)
  assert.doesNotMatch(standalone, />Conversations<\/span>/)
  assert.doesNotMatch(standalone, /primarySection/)
  assert.match(standalone, /function MobileSettingsPage/)
  assert.match(standalone, /settings\.themeSystem/)
  assert.match(standalone, /settings\.themeLight/)
  assert.match(standalone, /settings\.themeDark/)
  assert.match(standalone, /languageOptions\.map/)
  assert.match(sessionFirstNavigation, /\.hr-mobile-nav \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/)
  assert.match(main, /import "\.\/session-first-navigation\.css"/)
  assert.ok(main.indexOf('import "./session-first-navigation.css"') > main.indexOf('import "./conversation-control-plane-overrides.css"'), "Session-first navigation override must load after HR3 control-plane styles")
})

test("mobile Machines is a phone page and detected agents cannot overflow horizontally", () => {
  assert.match(controlPlane, /\.uw-manager-backdrop \{[\s\S]*?inset: 0 0 var\(--hr-mobile-nav-height\) 0 !important/)
  assert.match(controlPlane, /\.uw-machine-manager \{[\s\S]*?width: 100% !important[\s\S]*?max-width: 100% !important/)
  assert.match(controlPlane, /\.uw-machine-manager-body \{[\s\S]*?overflow-x: hidden !important/)
  assert.match(controlPlane, /\.uw-machine-harness-list \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) !important/)
  assert.match(controlPlane, /\.uw-machine-harness \{[\s\S]*?max-width: 100%/)
  assert.match(controlPlane, /\.uw-machine-editor-grid input \{[\s\S]*?font-size: 16px/)
})

test("mobile selected Session owns the dynamic viewport without duplicated navigation", () => {
  assert.match(mobile, /height: 100dvh/)
  assert.match(standalone, /hr-native-workspace-detail\$\{mobileDetailOpen \? " mobile-open" : ""\}/)
  assert.match(standalone, /className="tdw-mobile-back"/)
  assert.match(standalone, /<NativeSessionObserver key=\{selected\.key\} target=\{selected\}/)
  assert.doesNotMatch(standalone, /<UniversalWorkspace/)
  assert.doesNotMatch(standalone, /tdw-advanced-host/)
  assert.doesNotMatch(standalone, /tdw-classic-host/)
})

test("mobile composer keeps Send or Stop inside the text field on the right", () => {
  assert.match(controlPlane, /\.tdw-work-thread-conversation \.uw-composer-shell \{[\s\S]*?position: relative/)
  assert.match(controlPlane, /\.tdw-work-thread-conversation \.uw-composer-shell textarea \{[\s\S]*?padding: 12px 58px 12px 13px !important/)
  assert.match(controlPlane, /\.tdw-work-thread-conversation \.uw-composer-footer \{[\s\S]*?position: absolute[\s\S]*?right: 8px[\s\S]*?bottom: 8px/)
  assert.match(controlPlane, /\.tdw-work-thread-conversation \.uw-composer-footer \.uw-button \{[\s\S]*?width: 42px/)
})

test("mobile square action icons are geometrically centered", () => {
  assert.match(mobilePolish, /\.hr-new-conversation,[\s\S]*?\.uw-composer-footer \.uw-button/)
  assert.match(mobilePolish, /align-items: center !important/)
  assert.match(mobilePolish, /justify-content: center !important/)
  assert.match(mobilePolish, /gap: 0 !important/)
  assert.match(mobilePolish, /\.hr-new-conversation svg,[\s\S]*?display: block/)
  assert.match(mobilePolish, /\.uw-button-primary:not\(:has\(svg\)\)::after[\s\S]*?-webkit-mask:/)
})

test("short mobile transport drops keep last-known machine and Session control-plane data", () => {
  assert.match(machineClient, /DISCOVERY_STALE_GRACE_MS = 45_000/)
  assert.match(machineClient, /recentCachedSnapshot\(config\)/)
  assert.match(taskClient, /LIST_STALE_GRACE_MS = 45_000/)
  assert.match(taskClient, /projectListCache/)
  assert.match(taskClient, /taskListCache/)
  assert.match(taskClient, /const cached = readRecent\(projectListCache, key\)/)
  assert.match(taskClient, /const cached = readRecent\(taskListCache, key\)/)
})

test("Android back unwinds Session-first mobile UI before app exit", () => {
  assert.match(standalone, /CapacitorApp\.addListener\("backButton"/)
  assert.match(standalone, /if \(settingsOpen\)[\s\S]*?setSettingsOpen\(false\)/)
  assert.match(standalone, /if \(managerOpen\)[\s\S]*?setManagerOpen\(false\)/)
  assert.ok(standalone.indexOf("if (settingsOpen)") < standalone.indexOf("if (managerOpen)"), "Settings should unwind before Machines")
  assert.match(standalone, /\.tdw-model-picker\.open \.tdw-model-trigger/)
  assert.match(standalone, /modelPickerTrigger\.click\(\)/)
  assert.ok(standalone.indexOf("modelPickerTrigger") < standalone.indexOf("modalClose"), "model picker must close before its parent modal")
  assert.match(standalone, /\.tdw-modal-backdrop \.tdw-modal header button/)
  assert.match(standalone, /\.tdw-mobile-back/)
  assert.match(standalone, /mobileBack\.getClientRects\(\)\.length > 0/)
  assert.doesNotMatch(standalone, /primarySection/)
  assert.ok(standalone.indexOf("mobileBack") < standalone.indexOf("CapacitorApp.exitApp()"), "Session detail must unwind before Android exits")
  assert.match(standalone, /CapacitorApp\.exitApp\(\)/)
  assert.doesNotMatch(standalone, /tdw-advanced-host/)
  assert.doesNotMatch(standalone, /tdw-classic-host/)
})
