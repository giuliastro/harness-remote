import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const workspace = readFileSync(new URL("./components/conversation-workspace.tsx", import.meta.url), "utf8")
const standalone = readFileSync(new URL("./components/standalone-universal-workspace.tsx", import.meta.url), "utf8")
const mobile = readFileSync(new URL("./taskdesk-mobile-navigation.css", import.meta.url), "utf8")
const controlPlane = readFileSync(new URL("./conversation-control-plane-overrides.css", import.meta.url), "utf8")
const mobilePolish = readFileSync(new URL("./conversation-control-plane-mobile-polish.css", import.meta.url), "utf8")
const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8")
const workspaceNavigation = readFileSync(new URL("./taskdesk-workspace-navigation.css", import.meta.url), "utf8")
const machineClient = readFileSync(new URL("./machineClient.ts", import.meta.url), "utf8")
const taskClient = readFileSync(new URL("./taskClient.ts", import.meta.url), "utf8")

test("mobile opens a Conversation explicitly and can return to the list without clearing selection", () => {
  assert.match(workspace, /const \[mobileDetailOpen, setMobileDetailOpen\] = useState\(false\)/)
  assert.match(workspace, /setSelectedConversationKey\(record\.key\); setConversationDrawerOpen\(false\); setMobileDetailOpen\(true\)/)
  assert.match(workspace, /tdw-main\$\{mobileDetailOpen \? " mobile-open" : ""\}/)
  assert.match(workspace, /className="tdw-mobile-back" onClick=\{\(\) => setMobileDetailOpen\(false\)\}/)
  assert.match(workspace, /import "\.\.\/taskdesk-mobile-navigation\.css"/)
  assert.match(mobile, /@media \(max-width: 780px\)/)
  assert.match(mobile, /\.tdw-main \{[\s\S]*?display: none !important/)
  assert.match(mobile, /\.tdw-main\.mobile-open \{[\s\S]*?display: flex !important/)
})

test("mobile keeps Projects as a swipeable filter rail", () => {
  assert.match(mobile, /@media \(max-width: 780px\)/)
  assert.match(mobile, /\.tdw-project-column \{[\s\S]*?display: flex !important/)
  assert.match(mobile, /flex-direction: row !important/)
  assert.match(mobile, /overflow-x: auto/)
  assert.match(workspaceNavigation, /@media \(max-width: 780px\)/)
  assert.match(workspaceNavigation, /\.tdw-project-section \.tdw-project-list \{ display: flex/)
  assert.doesNotMatch(mobile, /\.tdw-project-column \{\s*display: none !important/)
})

test("mobile project selection remains visible after responsive row styling", () => {
  assert.match(main, /import "\.\/conversation-control-plane-mobile-polish\.css"/)
  assert.match(mobilePolish, /\.tdw-project-list \.tdw-project-row\.active/)
  assert.match(mobilePolish, /border-color: var\(--td3-blue-border\) !important/)
  assert.match(mobilePolish, /background: var\(--td3-blue-soft\) !important/)
})

test("mobile has explicit Conversations Machines and Settings destinations", () => {
  assert.match(standalone, /<nav className="hr-mobile-nav" aria-label="Main navigation">/)
  assert.match(standalone, />Conversations<\/span>/)
  assert.match(standalone, />Machines<\/span>/)
  assert.match(standalone, />Settings<\/span>/)
  assert.match(standalone, /function MobileSettingsPage/)
  assert.match(standalone, /const mobileSection = managerOpen \? "machines" : mobileSettingsOpen \? "settings" : "conversations"/)
  assert.match(controlPlane, /\.hr-mobile-nav \{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/)
  assert.match(controlPlane, /:has\(\.tdw-main\.mobile-open\) \.hr-mobile-nav[\s\S]*?display: none/)
})

test("mobile Machines is a phone page and detected agents cannot overflow horizontally", () => {
  assert.match(controlPlane, /\.uw-manager-backdrop \{[\s\S]*?inset: 0 0 var\(--hr-mobile-nav-height\) 0 !important/)
  assert.match(controlPlane, /\.uw-machine-manager \{[\s\S]*?width: 100% !important[\s\S]*?max-width: 100% !important/)
  assert.match(controlPlane, /\.uw-machine-manager-body \{[\s\S]*?overflow-x: hidden !important/)
  assert.match(controlPlane, /\.uw-machine-harness-list \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) !important/)
  assert.match(controlPlane, /\.uw-machine-harness \{[\s\S]*?max-width: 100%/)
  assert.match(controlPlane, /\.uw-machine-editor-grid input \{[\s\S]*?font-size: 16px/)
})

test("mobile Conversation detail uses the full dynamic viewport and avoids duplicated chrome", () => {
  assert.match(mobile, /height: 100dvh/)
  assert.match(mobile, /:has\(\.tdw-main\.mobile-open\) \.tdw-topbar \{[\s\S]*?display: none/)
  assert.match(mobile, /:has\(\.tdw-main\.mobile-open\) \.tdw-main\.mobile-open \{[\s\S]*?inset: 0/)
  assert.match(mobile, /\.tdw-thread-heading p \{[\s\S]*?display: none/)
  assert.match(mobile, /\.tdw-conversation-state \{[\s\S]*?display: none !important/)
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

test("mobile controls are touch and keyboard friendly", () => {
  assert.match(mobile, /\.tdw-thread-search input \{[\s\S]*?font-size: 16px/)
  assert.match(mobile, /\.tdw-modal select,[\s\S]*?font-size: 16px/)
  assert.match(mobile, /\.tdw-modal \{[\s\S]*?max-height: 94dvh/)
  assert.match(mobile, /\.tdw-modal-body \{[\s\S]*?overflow-y: auto !important/)
  assert.match(mobile, /\.tdw-model-popover \{[\s\S]*?position: fixed !important[\s\S]*?bottom: max\(10px, env\(safe-area-inset-bottom\)\)/)
  assert.match(mobile, /\.tdw-work-thread-conversation \.uw-composer-shell \{[\s\S]*?safe-area-inset-bottom/)
  assert.match(mobile, /touch-action: manipulation/)
})

test("short mobile transport drops keep last-known machine projects and conversations", () => {
  assert.match(machineClient, /DISCOVERY_STALE_GRACE_MS = 45_000/)
  assert.match(machineClient, /recentCachedSnapshot\(config\)/)
  assert.match(taskClient, /LIST_STALE_GRACE_MS = 45_000/)
  assert.match(taskClient, /projectListCache/)
  assert.match(taskClient, /taskListCache/)
  assert.match(taskClient, /const cached = readRecent\(projectListCache, key\)/)
  assert.match(taskClient, /const cached = readRecent\(taskListCache, key\)/)
})

test("Android back unwinds mobile pages and conversation UI before app exit", () => {
  assert.match(standalone, /CapacitorApp\.addListener\("backButton"/)
  assert.match(standalone, /if \(mobileSettingsOpen\)[\s\S]*?setMobileSettingsOpen\(false\)/)
  assert.match(standalone, /if \(managerOpen\)[\s\S]*?setManagerOpen\(false\)/)
  assert.ok(standalone.indexOf("if (mobileSettingsOpen)") < standalone.indexOf("if (managerOpen)"), "Settings should unwind before Machines")
  assert.match(standalone, /\.tdw-model-picker\.open \.tdw-model-trigger/)
  assert.match(standalone, /modelPickerTrigger\.click\(\)/)
  assert.ok(standalone.indexOf("modelPickerTrigger") < standalone.indexOf("modalClose"), "model picker must close before its parent modal")
  assert.match(standalone, /\.tdw-modal-backdrop \.tdw-modal header button/)
  assert.match(standalone, /\.tdw-task-drawer-scrim/)
  assert.match(standalone, /drawerScrim\.click\(\)/)
  assert.match(standalone, /\.tdw-mobile-back/)
  assert.match(standalone, /mobileBack\.getClientRects\(\)\.length > 0/)
  assert.match(standalone, /CapacitorApp\.exitApp\(\)/)
  assert.doesNotMatch(standalone, /tdw-more-menu/)
  assert.doesNotMatch(standalone, /tdw-advanced-host/)
  assert.doesNotMatch(standalone, /tdw-classic-host/)
})