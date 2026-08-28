import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (name) => fs.readFileSync(path.join(here, name), "utf8")
const exists = (name) => fs.existsSync(path.join(here, name))

const backendSetup = read("backendSetup.ts")
const profiles = read("serverProfiles.ts")
const main = read("main.tsx")
const standalone = read("components/standalone-universal-workspace.tsx")
const home = read("components/native-session-home.tsx")
const observer = read("components/native-session-observer.tsx")
const chat = read("components/work-thread-conversation.tsx")
const overrides = read("conversation-control-plane-overrides.css")
const sessionWorkbench = read("session-first-workbench.css")
const mobileParity = read("v3-mobile-product-parity.css")

assert.match(backendSetup, /return 4097/)
assert.doesNotMatch(backendSetup, /opencode-ai serve/)
assert.match(backendSetup, /npx github:giuliastro\/harness-remote/)
assert.doesNotMatch(backendSetup, /--backend \$\{backend\}/)
assert.match(backendSetup, /return "harness"/)

// Legacy profile defaults remain readable for 2.x compatibility, while 3.0 boots from machines.
assert.match(profiles, /port: 4097/)
assert.match(profiles, /username: "harness"/)
assert.doesNotMatch(main, /loadServerProfiles/)
assert.match(main, /loadWorkspaceMachines/)
assert.match(main, /import "\.\/conversation-control-plane-overrides\.css"/)
assert.match(main, /import "\.\/v3-mobile-product-parity\.css"/)
assert.ok(main.indexOf("v3-mobile-product-parity.css") > main.indexOf("v3-mobile-a11y-fix.css"), "mobile parity overrides must load last")

// Session-first is the only product shell. The failed Conversation-first experiment stays deleted.
assert.equal(exists("components/conversation-workspace.tsx"), false)
assert.equal(exists("components/conversation-detail.tsx"), false)
assert.match(standalone, /<NativeSessionsWorkspace/)
assert.match(standalone, /<NativeSessionHome/)
assert.match(standalone, /<NativeSessionObserver/)
assert.match(standalone, /<NativeSessionActions/)
assert.match(standalone, /<NativeSessionHandoffControl/)
assert.doesNotMatch(standalone, /ConversationWorkspace/)
assert.doesNotMatch(standalone, /New conversation/i)
assert.doesNotMatch(standalone, />Conversations</)
assert.doesNotMatch(standalone, /TaskDeskWorkspace/)

// The navigation hierarchy remains Machine -> Project -> native Session.
assert.match(home, /hr-native-machine-group/)
assert.match(home, /hr-native-project-group/)
assert.match(home, /hr-native-session-row/)
assert.match(home, /sessionTreeRows/)
assert.match(home, /createNativeSessionTarget/)
assert.match(observer, /<WorkThreadConversation/)
assert.match(chat, /<TaskDeskConversation/)
assert.match(sessionWorkbench, /hr-native-workspace/)
assert.match(sessionWorkbench, /hr-native-workspace-list/)
assert.match(sessionWorkbench, /hr-native-workspace-detail/)

// Mobile remains a real app shell rather than deleting useful controls to make screenshots fit.
assert.match(mobileParity, /:has\(\.tdw-main\.mobile-open\) \.hr-mobile-nav[\s\S]*display: grid !important/)
assert.match(mobileParity, /\.hr-mobile-settings-group label:nth-of-type\(2\)[\s\S]*display: grid !important/)
assert.match(mobileParity, /\.uw-machine-harness-list[\s\S]*display: flex !important/)
assert.match(mobileParity, /\.uw-transcript-jumps/)
assert.match(mobileParity, /@media \(pointer: coarse\) and \(max-width: 599px\) and \(max-height: 640px\)/)
assert.match(mobileParity, /@media \(pointer: coarse\) and \(min-width: 600px\) and \(max-height: 640px\)/)

// Native Session chat keeps the mature shared renderer without resurrecting the removed product UI.
assert.match(chat, /<span>Continue with<\/span>/)
assert.match(chat, /buildConversationTimeline/)
assert.match(overrides, /tdw-conversation-event::before/)
assert.match(overrides, /uw-activity-group\.uw-tool-running/)
assert.match(read("components/taskdesk-message-content.tsx"), /status === "running" \? "Working" : status/)
assert.match(overrides, /prefers-reduced-motion/)

// Model discovery is machine-scoped for native Sessions and must not restart on object identity churn.
assert.match(chat, /taskClient\.listAgentModels\(baseConfig, targetAgentID, modelScope \?\? \{\}\)/)
assert.match(chat, /\[targetAgentID, task\.id, task\.workspace\.path, baseConfig, modelScopeKey, deferModelFallback\]/)
assert.match(chat, /const modelScopeKey = modelScope \?/)
assert.match(observer, /const NATIVE_SESSION_MODEL_SCOPE: AgentModelScope = \{\}/)
assert.match(observer, /deferModelFallback/)
assert.doesNotMatch(
  read("native-session-v3-adapter.ts"),
  /taskClient\.listAgentModels\s*=/,
  "the native Session adapter must not reassign the shared model catalog client"
)

console.log("v3 Session-first UX polish regressions passed")
