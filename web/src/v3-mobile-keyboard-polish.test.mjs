import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (name) => readFileSync(path.join(here, name), "utf8").replace(/\r\n/g, "\n")

const MOBILE_SHEETS = [
  "taskdesk-mobile-navigation.css",
  "conversation-control-plane-overrides.css",
  "conversation-control-plane-mobile-polish.css",
  "v3-mobile-regression-fixes.css",
  "v3-mobile-landscape-grid-fix.css",
  "v3-mobile-workspace-switcher-polish.css",
  "v3-mobile-a11y-fix.css",
  "v3-mobile-product-parity.css",
  "session-first-navigation.css",
  "session-first-workbench.css"
]

const parity = read("v3-mobile-product-parity.css")
const workbench = read("session-first-workbench.css")
const standalone = read("components/standalone-universal-workspace.tsx")
const conversation = read("components/taskdesk-conversation.tsx")
const machineClient = read("machineClient.ts")

function preludes(css) {
  return [...css.matchAll(/@media([^{]+)\{/g)].map((match) => match[1].trim())
}

test("the soft keyboard cannot select landscape-only styling without a width guard", () => {
  const offenders = []
  for (const sheet of MOBILE_SHEETS) {
    for (const prelude of preludes(read(sheet))) {
      const clauses = prelude.split(",")
      if (clauses.some((clause) => clause.includes("max-width"))) continue
      for (const clause of clauses) {
        if (!clause.includes("pointer: coarse") || !clause.includes("max-height")) continue
        if (clause.includes("min-width") || clause.includes("max-width")) continue
        offenders.push(`${sheet}: @media${prelude}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `landscape styling selected without a width guard:\n${offenders.join("\n")}`)
})

test("the Session-first landscape block still targets wide short touch devices", () => {
  assert.match(workbench, /@media \(pointer: coarse\) and \(min-width: 600px\) and \(max-height: 640px\)/)
  assert.match(workbench, /\.hr-native-workspace-session-header \{[\s\S]*?min-height: 50px/)
  assert.match(workbench, /\.hr-native-session-observer \.uw-transcript \{[\s\S]*?padding-block: 6px 8px !important/)
})

test("native Session composer remains stable and readable when the phone keyboard is open", () => {
  assert.match(workbench, /\.hr-native-session-observer \.uw-composer-shell \{[\s\S]*?env\(safe-area-inset-bottom\)/)
  assert.match(workbench, /\.hr-native-session-observer \.uw-composer-shell textarea \{[\s\S]*?max-height: min\(132px, 28dvh\) !important/)
  assert.match(workbench, /\.hr-native-session-observer \.uw-composer-shell textarea \{[\s\S]*?font-size: 16px !important/)
  assert.match(workbench, /padding: 9px 56px 9px 11px !important/)
})

test("native Session transcript typography is scoped to the Session observer", () => {
  assert.match(workbench, /\.hr-native-session-observer \.uw-markdown \{[\s\S]*?font-size: 14px !important/)
  assert.match(workbench, /\.hr-native-session-observer \.uw-message \{[\s\S]*?grid-template-columns: 28px minmax\(0, 1fr\) !important/)
  assert.match(workbench, /\.hr-native-session-observer \.uw-transcript \{[\s\S]*?padding: 10px 8px 14px !important/)
})

test("a detected harness reads consistently in the mobile machine list", () => {
  assert.match(machineClient, /export function machineAgentStateLabel\(state: string, t: Translator = createTranslator\("en"\)\): string \{/)
  assert.match(machineClient, /if \(state === "configured"\) return t\("machine\.agentReady"\)/)
  assert.match(machineClient, /if \(state === "available"\) return t\("machine\.agentRunning"\)/)
  assert.match(standalone, /import \{ discoverMachine, listMachineProjects, machineAgentStateLabel \} from "\.\.\/machineClient"/)
  assert.match(standalone, /\{machineAgentStateLabel\(agent\.state, t\)\}/)
  assert.match(standalone, /<i className=\{agent\.state\} aria-hidden="true" \/>/)
})

test("a phone can explicitly refresh its machines and Sessions", () => {
  assert.match(standalone, /className="tdw-icon-button hr-refresh-button"/)
  assert.match(standalone, /aria-busy=\{toolbarRefreshing \|\| undefined\}/)
  assert.match(standalone, /setRevision\(\(value\) => value \+ 1\)/)
  assert.match(parity, /\.hr-control-plane \.tdw-top-actions > \.hr-refresh-button \{[^}]*display: flex !important;/)
  const rule = parity.match(/\.hr-control-plane \.tdw-top-actions > \.hr-refresh-button \{[^}]*\}/)?.[0] || ""
  const size = Number(rule.match(/min-height:\s*(\d+)px/)?.[1] || 0)
  assert.ok(size >= 40, `refresh is only ${size}px tall`)
})

test("the Session composer tells the soft keyboard what its action key does", () => {
  assert.match(conversation, /enterKeyHint=\{touchFirst \? "enter" : "send"\}/)
  assert.match(conversation, /touchFirst \? "Enter adds a line\. Tap Send to send\."/)
})

test("mobile keyboard guards do not depend on the retired Conversation workspace", () => {
  assert.equal(existsSync(path.join(here, "components/conversation-workspace.tsx")), false)
  assert.equal(existsSync(path.join(here, "components/conversation-detail.tsx")), false)
})
