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

// The differentiator has to be visible in normal conversation chrome, not hidden in documentation.
assert.match(conversation, /<span>Continue with<\/span>/)
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
assert.match(overrides, /content: "Working"/)
assert.match(overrides, /prefers-reduced-motion/)

assert.match(readme, /normal public port is \*\*4097\*\*/)
assert.match(readme, /normally on loopback port \*\*4096\*\*/)
assert.match(readme, /one launcher per machine/)
assert.match(readme, /Project[\s\S]*Conversations[\s\S]*Native Session: OpenCode/)
assert.match(readme, /does \*\*not\*\* create a hidden Git worktree/)
assert.match(readme, /one Conversation that can continue through several native Sessions/)

console.log("v3 UX polish regressions passed")
