import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (name) => readFileSync(path.join(here, name), "utf8").replace(/\r\n/g, "\n")

const main = read("main.tsx")
const workspace = read("components/standalone-universal-workspace.tsx")
const home = read("components/native-session-home-base.tsx")
const attentionHome = read("components/native-session-home-attention.tsx")
const workbench = read("session-first-workbench.css")
const navigation = read("session-first-navigation.css")

// Session-first overrides load after the older shared/mobile styles and therefore own the final shell.
assert.match(main, /import "\.\/v3-mobile-regression-fixes\.css"/)
assert.match(main, /import "\.\/v3-mobile-landscape-grid-fix\.css"/)
assert.match(main, /import "\.\/session-first-navigation\.css"/)
assert.match(main, /import "\.\/session-first-workbench\.css"/)
assert.ok(main.indexOf('import "./session-first-navigation.css"') > main.indexOf('import "./v3-mobile-product-parity.css"'))
assert.ok(main.indexOf('import "./session-first-workbench.css"') > main.indexOf('import "./session-first-navigation.css"'))

// The old Conversation product surface is gone. Mobile navigation operates on real native Sessions.
assert.equal(existsSync(path.join(here, "components/conversation-workspace.tsx")), false)
assert.equal(existsSync(path.join(here, "components/conversation-detail.tsx")), false)
assert.match(workspace, /const \[mobileDetailOpen, setMobileDetailOpen\] = useState\(false\)/)
assert.match(workspace, /function openSession\(target: NativeSessionSurfaceTarget\)/)
assert.match(workspace, /setSelected\(target\)/)
assert.match(workspace, /setMobileDetailOpen\(true\)/)
assert.match(workspace, /className=\{`hr-native-workspace-detail\$\{mobileDetailOpen \? " mobile-open" : ""\}`\}/)
assert.match(workspace, /className="tdw-mobile-back" onClick=\{\(\) => setMobileDetailOpen\(false\)\}/)

// Final mobile navigation has only the three Session-first destinations.
assert.match(navigation, /\.hr-mobile-nav \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/)
assert.match(workspace, /mobileSection === "sessions"/)
assert.match(workspace, /mobileSection === "machines"/)
assert.match(workspace, /mobileSection === "settings"/)
assert.doesNotMatch(workspace, /mobileSection === "conversations"/)

// Machine -> Project -> Session remains visible and usable at mobile widths.
assert.match(home, /hr-native-machine-group/)
assert.match(home, /hr-native-project-group/)
assert.match(home, /hr-native-session-row/)
assert.match(home, /toggleMachineCollapsed/)
assert.match(home, /toggleProjectCollapsed/)
assert.match(attentionHome, /hr-native-attention-inbox/, "global attention must stay visible on the same mobile Sessions surface")
assert.match(workbench, /@media \(max-width: 780px\)/)
assert.match(workbench, /\.hr-native-workspace-body \{[\s\S]*grid-template-columns: 1fr/)
assert.match(workbench, /\.hr-native-workspace-list \{[\s\S]*width: 100%/)
assert.match(workbench, /\.hr-native-workspace-detail\.mobile-open/)

// Machine management and model selection remain usable as full touch surfaces.
assert.match(workspace, /className="uw-machine-manager"/)
assert.match(workspace, /className="tdw-icon-button hr-refresh-button"/)
assert.match(workbench, /\.hr-native-session-observer \.uw-composer-shell textarea \{[\s\S]*font-size: 16px !important/)
assert.match(workbench, /\.hr-session-actions > \.tdw-icon-button \{ width: 44px; height: 44px; \}/)

console.log("v3 Session-first mobile regression guards: ok")
