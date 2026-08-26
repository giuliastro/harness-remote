import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8")
const workspace = read("./components/standalone-universal-workspace.tsx")
const home = read("./components/native-session-home.tsx")
const workbenchCss = read("./session-first-workbench.css")

test("the retired Conversation workspace stays absent", () => {
  assert.equal(existsSync(new URL("./components/conversation-workspace.tsx", import.meta.url)), false)
  assert.equal(existsSync(new URL("./components/conversation-detail.tsx", import.meta.url)), false)
  assert.doesNotMatch(workspace, /New Conversation/i)
  assert.doesNotMatch(workspace, /ConversationWorkspace/)
})

test("the Session rail width is bounded and persisted independently of the retired shell", () => {
  assert.match(workspace, /RAIL_WIDTH_STORAGE_KEY = "harness-remote\.sessionRailWidth\.v1"/)
  assert.match(workspace, /RAIL_WIDTH_MIN = 260/)
  assert.match(workspace, /RAIL_WIDTH_MAX = 620/)
  assert.match(workspace, /function clampRailWidth\(value: number\)/)
  assert.match(workspace, /localStorage\.setItem\(RAIL_WIDTH_STORAGE_KEY, String\(railWidth\)\)/)
  const load = workspace.match(/function loadRailWidth\(\): number \| null \{[\s\S]*?\n\}/)?.[0] || ""
  assert.match(load, /try \{/)
  assert.match(load, /catch \{/)
})

test("the Session rail separator is pointer and keyboard operable", () => {
  assert.match(workspace, /className="hr-rail-resizer"/)
  assert.match(workspace, /role="separator"/)
  assert.match(workspace, /aria-orientation="vertical"/)
  assert.match(workspace, /aria-valuemin=\{RAIL_WIDTH_MIN\}/)
  assert.match(workspace, /aria-valuemax=\{RAIL_WIDTH_MAX\}/)
  assert.match(workspace, /tabIndex=\{0\}/)
  assert.match(workspace, /onPointerDown=\{startRailDrag\}/)
  assert.match(workspace, /event\.key !== "ArrowLeft" && event\.key !== "ArrowRight"/)
  assert.match(workbenchCss, /\.hr-rail-resizer:focus-visible/)
  assert.match(workbenchCss, /\.hr-rail-resizer \{[\s\S]*?touch-action: none/)
})

test("opening a native Session updates selection and mobile detail explicitly", () => {
  assert.match(workspace, /function openSession\(target: NativeSessionSurfaceTarget\)/)
  assert.match(workspace, /setSelectedState\(undefined\)/)
  assert.match(workspace, /setSelected\(target\)/)
  assert.match(workspace, /setMobileDetailOpen\(true\)/)
  assert.match(workspace, /selectedKey=\{selected\?\.key\}/)
  assert.match(workspace, /<NativeSessionObserver key=\{selected\.key\} target=\{selected\}/)
})

test("Session list navigation groups real native Sessions by machine and Project", () => {
  assert.match(home, /const selectedActivityAnchor = activityAnchor\?\.key === selectedKey \? activityAnchor : null/)
  assert.match(home, /projectGroups\(records, selectedActivityAnchor\)/)
  assert.match(home, /collapsedMachines/)
  assert.match(home, /collapsedProjects/)
  assert.match(home, /sessionTreeRows\(group\.sessions\)/)
  assert.match(home, /onClick=\{\(\) => open\(item\)\}/)
})

test("new Session is created through the native Session path rather than a Conversation task", () => {
  assert.match(home, /createNativeSessionTarget/)
  assert.match(home, /setCreateOpen\(true\)/)
  assert.match(home, /selectedCreateProject/)
  assert.match(home, /selectedCreateAgent/)
  assert.doesNotMatch(home, /taskClient\.createTask/)
  assert.doesNotMatch(home, /New Conversation/i)
})

test("removing the last machine does not leave Refresh disabled forever", () => {
  const guard = workspace.match(/if \(machines\.length === 0\) \{[\s\S]*?\n    \}/)?.[0] || ""
  assert.match(guard, /setRuntimes\(\[\]\)/)
  assert.match(guard, /setLoaded\(true\)/)
  assert.match(guard, /setRefreshing\(false\)/)
})
