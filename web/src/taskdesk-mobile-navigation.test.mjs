import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8")
const standalone = read("./components/standalone-universal-workspace.tsx")
const mobile = read("./taskdesk-mobile-navigation.css")
const controlPlane = read("./conversation-control-plane-overrides.css")
const sessionFirstNavigation = read("./session-first-navigation.css")
const sessionFirstWorkbench = read("./session-first-workbench.css")
const main = read("./main.tsx")
const machineClient = read("./machineClient.ts")

test("mobile opens a native Session explicitly and returns to the Session list without clearing selection", () => {
  assert.equal(existsSync(new URL("./components/conversation-workspace.tsx", import.meta.url)), false)
  assert.match(standalone, /const \[mobileDetailOpen, setMobileDetailOpen\] = useState\(false\)/)
  assert.match(standalone, /function openSession\(target: NativeSessionSurfaceTarget\)[\s\S]*?setSelected\(target\)[\s\S]*?setMobileDetailOpen\(true\)/)
  assert.match(standalone, /hr-native-workspace-detail\$\{mobileDetailOpen \? " mobile-open" : ""\}/)
  assert.match(standalone, /className="tdw-mobile-back" onClick=\{\(\) => setMobileDetailOpen\(false\)\}/)
  assert.match(sessionFirstWorkbench, /\.hr-native-workspace:has\(\.hr-native-workspace-detail\.mobile-open\) > \.tdw-topbar[\s\S]*?display: none !important/)
  assert.match(sessionFirstWorkbench, /\.hr-native-workspace-detail \{[\s\S]*?inset-block-start: 0 !important/)
})

test("mobile Session list keeps Machine -> Project -> Session navigation", () => {
  const home = read("./components/native-session-home-base.tsx")
  const attentionHome = read("./components/native-session-home-attention.tsx")
  assert.match(home, /hr-native-machine-group/)
  assert.match(home, /hr-native-project-group/)
  assert.match(home, /hr-native-session-row/)
  assert.match(home, /toggleMachineCollapsed/)
  assert.match(home, /toggleProjectCollapsed/)
  assert.match(attentionHome, /hr-native-attention-inbox/, "mobile rail must surface global pending attention above the native Session list")
  assert.match(sessionFirstWorkbench, /\.hr-native-home \{[\s\S]*?padding-inline: 8px/)
  assert.match(sessionFirstWorkbench, /\.hr-native-session-row \{[\s\S]*?min-height: 58px/)
  assert.match(sessionFirstWorkbench, /\.hr-native-session-search input \{[\s\S]*?font-size: 16px/)
})

test("mobile has exactly Sessions Machines and Settings destinations", () => {
  assert.match(standalone, /const mobileSection = managerOpen \? "machines" : settingsOpen \? "settings" : "sessions"/)
  assert.match(standalone, /<nav className="hr-mobile-nav" aria-label=\{t\("sf\.mainNavigation"\)\}>/)
  assert.match(standalone, /<span>\{t\("nav\.sessions"\)\}<\/span>/)
  assert.match(standalone, /<span>\{t\("sf\.machines"\)\}<\/span>/)
  assert.match(standalone, /<span>\{t\("nav\.settings"\)\}<\/span>/)
  assert.doesNotMatch(standalone, />Conversations<\/span>/)
  assert.doesNotMatch(standalone, /primarySection/)
  assert.match(standalone, /function MobileSettingsPage/)
  assert.match(standalone, /settings\.themeSystem/)
  assert.match(standalone, /settings\.themeLight/)
  assert.match(standalone, /settings\.themeDark/)
  assert.match(standalone, /languageOptions\.map/)
  assert.match(sessionFirstNavigation, /\.hr-mobile-nav \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/)
  assert.match(main, /import "\.\/session-first-navigation\.css"/)
  assert.ok(main.indexOf('import "./session-first-navigation.css"') > main.indexOf('import "./conversation-control-plane-overrides.css"'), "Session-first navigation override must load after shared HR3 chat styles")
})

test("mobile carries Session attention outside the hidden rail", () => {
  assert.match(standalone, /const \[attentionCount, setAttentionCount\] = useState\(0\)/)
  assert.match(standalone, /onAttentionCountChange=\{setAttentionCount\}/)
  assert.match(standalone, /hr-mobile-nav-badge/)
  assert.match(standalone, /attentionCount > 9 \? "9\+" : attentionCount/)
  assert.match(sessionFirstWorkbench, /\.hr-mobile-nav-badge \{/)
})

test("mobile Machines and Settings remain full phone surfaces", () => {
  assert.match(controlPlane, /\.uw-manager-backdrop \{[\s\S]*?inset: 0 0 var\(--hr-mobile-nav-height\) 0 !important/)
  assert.match(controlPlane, /\.uw-machine-manager \{[\s\S]*?width: 100% !important[\s\S]*?max-width: 100% !important/)
  assert.match(controlPlane, /\.uw-machine-manager-body \{[\s\S]*?overflow-x: hidden !important/)
  assert.match(sessionFirstWorkbench, /\.hr-session-settings-backdrop \{[\s\S]*?inset: 0 0 var\(--hr-mobile-nav-height\)/)
  assert.match(sessionFirstWorkbench, /\.hr-session-settings-page \{[\s\S]*?position: fixed !important[\s\S]*?width: 100%/)
  assert.match(sessionFirstWorkbench, /\.hr-session-settings-page \.hr-mobile-settings-group label:nth-of-type\(2\)/)
})

test("mobile native Session composer stays touch friendly and respects the safe area", () => {
  assert.match(sessionFirstWorkbench, /\.hr-native-session-observer \.uw-composer-shell \{[\s\S]*?env\(safe-area-inset-bottom\)/)
  assert.match(sessionFirstWorkbench, /\.hr-native-session-observer \.uw-composer-shell textarea \{[\s\S]*?font-size: 16px !important/)
  assert.match(sessionFirstWorkbench, /padding: 9px 56px 9px 11px !important/)
  assert.match(sessionFirstWorkbench, /\.hr-session-actions > \.tdw-icon-button \{ width: 44px; height: 44px; \}/)
  assert.match(sessionFirstWorkbench, /\.hr-session-action-field input \{ min-height: 44px; font-size: 16px; \}/)
})

test("short mobile transport drops keep last-known machine discovery without restoring Conversation UI", () => {
  assert.match(machineClient, /DISCOVERY_STALE_GRACE_MS = 45_000/)
  assert.match(machineClient, /recentCachedSnapshot\(config\)/)
  assert.equal(existsSync(new URL("./components/conversation-detail.tsx", import.meta.url)), false)
  assert.equal(existsSync(new URL("./components/conversation-workspace.tsx", import.meta.url)), false)
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
  assert.match(standalone, /sessionActionDismiss/)
  assert.match(standalone, /\.tdw-mobile-back/)
  assert.match(standalone, /mobileBack\.getClientRects\(\)\.length > 0/)
  assert.ok(standalone.indexOf("mobileBack") < standalone.indexOf("CapacitorApp.exitApp()"), "Session detail must unwind before Android exits")
  assert.match(standalone, /CapacitorApp\.exitApp\(\)/)
  assert.doesNotMatch(standalone, /tdw-advanced-host/)
  assert.doesNotMatch(standalone, /tdw-classic-host/)
})
