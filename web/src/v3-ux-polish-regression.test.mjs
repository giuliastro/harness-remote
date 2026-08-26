import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (name) => fs.readFileSync(path.join(here, name), "utf8")
const readRoot = (name) => fs.readFileSync(path.join(here, "..", "..", name), "utf8")

const backendSetup = read("backendSetup.ts")
const profiles = read("serverProfiles.ts")
const main = read("main.tsx")
const workspace = read("components/conversation-workspace.tsx")
const detail = read("components/conversation-detail.tsx")
const conversation = read("components/work-thread-conversation.tsx")
const polish = read("conversation-control-plane.css")
const overrides = read("conversation-control-plane-overrides.css")
const mobileParity = read("v3-mobile-product-parity.css")
const readme = readRoot("README.md")

assert.match(backendSetup, /return 4097/)
assert.doesNotMatch(backendSetup, /opencode-ai serve/)
assert.match(backendSetup, /npx github:giuliastro\/harness-remote/)
assert.doesNotMatch(backendSetup, /--backend \$\{backend\}/)
assert.match(backendSetup, /return "harness"/)

// Legacy profile defaults remain readable for 2.x compatibility, while 3.0 no longer boots from them.
assert.match(profiles, /port: 4097/)
assert.match(profiles, /username: "harness"/)
assert.doesNotMatch(main, /loadServerProfiles/)
assert.match(main, /loadWorkspaceMachines/)
assert.match(main, /import "\.\/conversation-control-plane-overrides\.css"/)
assert.match(main, /import "\.\/v3-mobile-product-parity\.css"/)
assert.ok(main.indexOf("v3-mobile-product-parity.css") > main.indexOf("v3-mobile-a11y-fix.css"), "mobile parity overrides must load last")

// The first screen must communicate the product without exposing Task/Run plumbing.
assert.match(workspace, />Harness Remote 3\.0</)
assert.match(workspace, />Your projects\. Any coding agent\.</)
assert.match(workspace, />Native Sessions</)
assert.match(workspace, />Agent handoff</)
assert.match(workspace, />Local-first</)
assert.match(workspace, />New conversation</)
assert.doesNotMatch(workspace, />New task</i)
assert.doesNotMatch(workspace, /Advanced: Native Sessions/)
assert.doesNotMatch(workspace, /Classic Harness Remote/)
assert.match(overrides, /\.hr-control-plane \.hr-welcome \{/)
assert.match(overrides, /align-self: center/)
assert.match(overrides, /No coding machine is connected/)
assert.match(overrides, /Connecting to your machines/)

// Mobile remains a real app shell rather than deleting useful controls to make the screenshots fit.
assert.match(mobileParity, /:has\(\.tdw-main\.mobile-open\) \.hr-mobile-nav[\s\S]*display: grid !important/)
assert.match(mobileParity, /\.hr-mobile-settings-group label:nth-of-type\(2\)[\s\S]*display: grid !important/)
assert.match(mobileParity, /\.uw-machine-harness-list[\s\S]*display: flex !important/)
assert.match(mobileParity, /\.uw-transcript-jumps/)
// A soft keyboard can change viewport aspect ratio without rotating the phone. Narrow width, not
// CSS `orientation`, is the invariant that prevents the portrait modal from becoming two-column.
assert.match(mobileParity, /@media \(pointer: coarse\) and \(max-width: 599px\) and \(max-height: 640px\)/)
assert.match(mobileParity, /@media \(pointer: coarse\) and \(min-width: 600px\) and \(max-height: 640px\)/)
assert.match(mobileParity, /\.hr-new-conversation-modal \.tdw-modal-body[\s\S]*display: flex !important/)

// The differentiator has to be visible in normal conversation chrome, not hidden in documentation.
assert.match(conversation, /<span>\{t\("sf\.continueWith"\)\}<\/span>/)
assert.doesNotMatch(detail, /hr-header-state/)
assert.match(detail, />Sessions <span>\{sessions\.length\}<\/span>/)
assert.match(detail, /Native continuity/)
assert.match(detail, /Continued with/)
assert.match(detail, />Changes</)
assert.match(polish, /hr-session-chain/)
assert.match(polish, /Preparing your workspace/)
assert.match(polish, /@media \(max-width: 900px\)/)
assert.match(polish, /prefers-reduced-motion/)
assert.match(overrides, /tdw-conversation-event::before/)
assert.match(overrides, /uw-activity-group\.uw-tool-running/)
// "Working" is component copy now, not a CSS `content` pseudo-element.
assert.match(read("components/taskdesk-message-content.tsx"), /status === "running" \? "Working" : status/)
assert.match(overrides, /prefers-reduced-motion/)

// An existing Conversation may have Project-specific provider/model configuration. The integrated
// product/UI audit must not erase the capability audit's server-resolved Conversation scope, so the
// Work Thread scope stays the default. A native-Session surface overrides it with the daemon's real
// machine-scoped catalog identity instead of rewriting the shared taskClient for every consumer.
assert.match(conversation, /taskClient\.listAgentModels\(baseConfig, targetAgentID, modelScope \?\? \{ workThreadId: task\.id \}\)/)
// The effect must key on the scope's value, never a caller's object identity, or a fresh scope
// object per render would restart model discovery on every render.
// Assert the rule, not one snapshot of the list: the deps must key on the scope's serialized value
// and must never carry the caller's `modelScope` object itself. Pinning the exact array made every
// legitimate addition to the effect's own inputs look like a regression.
const modelCatalogDeps = /\}, \[targetAgentID, task\.id, task\.workspace\.path, baseConfig, modelScopeKey([^\]]*)\]\)/.exec(conversation)
assert.ok(modelCatalogDeps, "the model catalog effect must key on targetAgentID, task, workspace, config and modelScopeKey")
assert.doesNotMatch(modelCatalogDeps[1], /\bmodelScope\b/, "the deps must use modelScopeKey, never the caller's modelScope object")
assert.match(conversation, /const modelScopeKey = modelScope \?/)
assert.doesNotMatch(
  read("native-session-v3-adapter.ts"),
  /taskClient\.listAgentModels\s*=/,
  "the native Session adapter must not reassign the shared model catalog client"
)

assert.match(readme, /normal public port is \*\*4097\*\*/)
assert.match(readme, /normally on loopback port \*\*4096\*\*/)
assert.match(readme, /one launcher per machine/)
assert.match(readme, /Project[\s\S]*Conversation[\s\S]*Native Session: OpenCode/)
assert.match(readme, /does \*\*not\*\* create a hidden Git worktree/)
assert.match(readme, /one Conversation that can continue through several native Sessions/)

console.log("v3 UX polish regressions passed")