import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("TaskDesk pauses hidden work and uses live events with slow Sessions reconciliation", () => {
  const taskDesk = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")
  const workspace = readFileSync(new URL("./components/universal-workspace.tsx", import.meta.url), "utf8")

  assert.match(taskDesk, /const REFRESH_MS = 10_000/)
  assert.match(taskDesk, /const DETAIL_REFRESH_MS = 5_000/)
  assert.match(taskDesk, /if \(view === "sessions" \|\| view === "classic"\) return/)
  assert.match(taskDesk, /if \(view !== "tasks" \|\| !selected \|\| !detailOpen\)/)
  assert.match(taskDesk, /if \(pageIsVisible\(\)\) void refresh\(\)/)

  assert.match(workspace, /const REFRESH_INTERVAL_MS = 60_000/)
  assert.match(workspace, /const DETAIL_REFRESH_INTERVAL_MS = 30_000/)
  assert.match(workspace, /startTaskDeskSessionLiveRefresh\(\{/)
  assert.match(workspace, /const detailInFlight = useRef\(false\)/)
  assert.match(workspace, /if \(detailInFlight\.current && silent\) return/)
  assert.match(workspace, /if \(pageIsVisible\(\)\) void refreshAll\(true\)/)
})

test("Sessions list never fans out transcript reads for card previews", () => {
  const workspace = readFileSync(new URL("./components/universal-workspace.tsx", import.meta.url), "utf8")

  assert.doesNotMatch(workspace, /loadLatestMessage/)
  assert.doesNotMatch(workspace, /topSessions/)
  assert.doesNotMatch(workspace, /setPreviews/)
  assert.match(workspace, /session\.summary\?\.files/)
})

test("Task detail fetches only data required by the active review tab", () => {
  const source = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")

  assert.match(source, /const needsMessages = tab === "review" \|\| tab === "conversation"/)
  assert.match(source, /const needsDiff = tab === "review" \|\| tab === "diff"/)
  assert.match(source, /const needsTodos = tab === "review"/)
  assert.match(source, /const needsVcs = tab === "review"/)
  assert.match(source, /loadDetail\(selected, detailTab, false\)/)
  assert.match(source, /loadDetail\(selected, detailTab, true\)/)
})

test("ACP bridge has lightweight session indexing, cursor paging and cache diagnostics", () => {
  const source = readFileSync(new URL("../../bridge/src/server.js", import.meta.url), "utf8")
  const service = readFileSync(new URL("../../bridge/src/acp-service.js", import.meta.url), "utf8")

  assert.match(source, /const listVisibleSessionMetadata = async/)
  assert.match(source, /url\.pathname === "\/experimental\/session"[\s\S]*?listVisibleSessionMetadata/)
  assert.match(source, /url\.pathname === "\/session\/status"[\s\S]*?listVisibleSessionMetadata/)
  assert.match(source, /const MAX_MESSAGE_PAGE = 500/)
  assert.match(source, /service\.messagePage\(sessionID/)
  assert.match(source, /url\.searchParams\.get\("before"\)/)
  assert.match(source, /X-Next-Cursor/)
  assert.match(source, /X-Has-More/)
  assert.match(source, /url\.pathname === "\/v1\/diagnostics"/)
  assert.match(source, /service: service\.diagnostics\(\)/)
  assert.match(service, /#messages = new TranscriptCache/)
  assert.match(service, /async messagePage\(sessionID/)
})

test("TaskDesk responsive layout uses focused mobile pages and at most two persistent Session panes", () => {
  const polish = readFileSync(new URL("./v3-polish.css", import.meta.url), "utf8")
  const taskDesk = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")
  const workspace = readFileSync(new URL("./components/universal-workspace.tsx", import.meta.url), "utf8")

  assert.match(polish, /article:has\(> \.td3-agent-badge\)[\s\S]*?grid-template-columns: minmax\(152px, 178px\) minmax\(0, 1fr\)/)
  assert.match(polish, /\.td3-sessions-embedded \.uw-layout[\s\S]*?grid-template-columns: minmax\(300px, 360px\) minmax\(0, 1fr\)/)
  assert.match(polish, /\.td3-sessions-embedded \.uw-nav[\s\S]*?display: none !important/)
  assert.match(polish, /\.td3-sessions-embedded \.uw-inspector[\s\S]*?position: absolute/)
  assert.match(polish, /\.td3-tasks-layout-unified\.detail-open \.td3-task-list-pane[\s\S]*?display: none/)
  assert.match(polish, /\.td3-workspace:has\(\.td3-tasks-layout-unified\.detail-open\) > \.td3-topbar[\s\S]*?display: none/)
  assert.match(polish, /\.td3-sessions-embedded \.uw-main[\s\S]*?display: none/)
  assert.match(polish, /\.td3-sessions-embedded\.td3-mobile-session-detail \.uw-session-column[\s\S]*?display: none/)
  assert.match(polish, /\.td3-sessions-embedded\.td3-mobile-session-detail \.uw-main[\s\S]*?display: flex/)

  // The phone pane is React state on the shell, and the class that drives the CSS above is rendered
  // from it. Nothing observes or rewrites the tree to decide which pane is showing.
  assert.match(taskDesk, /const \[sessionPane, setSessionPane\] = useState<SessionPane>\("list"\)/)
  assert.match(taskDesk, /isMobile && sessionPane === "detail" \? " td3-mobile-session-detail" : ""/)
  assert.match(taskDesk, /mobilePane=\{isMobile \? sessionPane : undefined\}/)
  assert.match(taskDesk, /onOpenSessionDetail=\{\(\) => setSessionPane\("detail"\)\}/)
  assert.match(taskDesk, /onBackToSessionList=\{\(\) => setSessionPane\("list"\)\}/)
  assert.match(taskDesk, /if \(next === "sessions"\) setSessionPane\("list"\)/)
  assert.match(workspace, /mobilePane === "detail" && onBackToSessionList/)
  assert.match(workspace, /onOpenSessionDetail\?\.\(\)/)
})

test("TaskDesk keeps create actions reachable at every width and a manual Session choice stable", () => {
  const taskDesk = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")
  const workspace = readFileSync(new URL("./components/universal-workspace.tsx", import.meta.url), "utf8")
  const v3 = readFileSync(new URL("./taskdesk-v3.css", import.meta.url), "utf8")
  const unified = readFileSync(new URL("./taskdesk-v3-unified.css", import.meta.url), "utf8")

  // New Task and New Session are one persistent toolbar action chosen by the surface, so neither can
  // be removed by a breakpoint. `display:none` on the last topbar button is what used to delete New
  // Task below 1220px, and hiding `.uw-nav` deleted New Session everywhere but a phone.
  assert.match(taskDesk, /className="td3-topbar-actions"/)
  assert.match(taskDesk, /onClick=\{\(\) => setNewSessionRequest\(\(value\) => value \+ 1\)\}/)
  assert.match(taskDesk, /onClick=\{\(\) => setNewTaskOpen\(true\)\}/)
  assert.doesNotMatch(v3, /\.td3-topbar > \.td3-button:last-child \{ display:none; \}/)
  assert.match(unified, /\.td3-topbar-actions[\s\S]*?flex: 0 0 auto/)
  assert.match(unified, /\.td3-topbar-primary > \.td3-button-label[\s\S]*?clip-path: inset\(50%\)/)
  assert.match(workspace, /if \(!newSessionRequest \|\| newSessionRequest === appliedNewSessionRequest\.current\) return/)
  assert.match(workspace, /appliedNewSessionRequest\.current = newSessionRequest/)

  // Every phone destination is rendered, so nothing falls off the end of the bottom bar.
  assert.match(taskDesk, /const mobilePrimary: TaskDeskView\[\] = \["tasks", "sessions", "needs", "projects"\]/)
  assert.match(taskDesk, /const overflowNav = isMobile \? navItems\.filter\(\(item\) => !mobilePrimary\.includes\(item\.view\)\) : \[\]/)
  assert.match(taskDesk, /\{moreOpen \? <MoreSheet/)
  assert.doesNotMatch(v3, /nav button:nth-child\(n\+7\) \{ display:none; \}/)

  // A focus request is applied once. Re-applying it on every refresh is what overwrote a manual
  // Session choice for the rest of the session.
  assert.match(workspace, /const pendingFocus = focusSessionRequest && appliedFocusRequest\.current !== focusSessionRequest\.requestID/)
  assert.match(workspace, /appliedFocusRequest\.current = pendingFocus\?\.requestID \?\? null/)
})

test("TaskDesk never repairs its own rendered tree from a MutationObserver", () => {
  const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8")

  // `classList.remove` writes the class attribute even when the token is absent, so an observer
  // watching attributes on document.body re-entered its own callback without end. That froze the
  // renderer for good whenever the Sessions view was mounted above the phone breakpoint.
  assert.doesNotMatch(main, /installTaskDeskMobileNavigation/)
  assert.doesNotMatch(main, /installTaskDeskRunHistory/)
  assert.doesNotMatch(main, /taskdesk-mobile-navigation/)
  assert.doesNotMatch(main, /taskdesk-run-history/)

  for (const file of ["./components/taskdesk-v3-unified.tsx", "./components/universal-workspace.tsx", "./taskdesk-shell-navigation.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8")
    assert.doesNotMatch(source, /new MutationObserver/, `${file} must not observe the DOM it renders`)
  }
})

test("TaskDesk unwinds one back stack for Escape and Android back", () => {
  const navigation = readFileSync(new URL("./taskdesk-shell-navigation.ts", import.meta.url), "utf8")
  const taskDesk = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")

  assert.match(navigation, /export function useBackNavigation/)
  assert.match(navigation, /event\.key !== "Escape"/)
  assert.match(navigation, /isAndroidPlatform\(Capacitor\.getPlatform\(\)\)/)
  assert.match(navigation, /CapacitorApp\.addListener\("backButton"/)
  assert.match(navigation, /CapacitorApp\.exitApp\(\)/)
  // Registered once and read through a ref, so the handler can never act on a stale view.
  assert.match(navigation, /const stepsRef = useRef\(steps\)/)
  assert.match(navigation, /stepsRef\.current = steps/)

  const stack = taskDesk.match(/useBackNavigation\(\[[\s\S]*?\]\)/)
  assert.ok(stack, "the shell must declare its dismissal order")
  const order = [...stack[0].matchAll(/set(RunReview|MoreOpen|SettingsOpen|ContinueOpen|NewTaskOpen|SessionPane)|closeTaskDetail|goToView\("tasks"\)/g)].map((match) => match[0])
  assert.deepEqual(order, [
    "setRunReview",
    "setMoreOpen",
    "setSettingsOpen",
    "setContinueOpen",
    "setNewTaskOpen",
    "setSessionPane",
    "closeTaskDetail",
    'goToView("tasks")'
  ])
})

test("An open Task detail survives a poll and a machine that stops answering", () => {
  const source = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")

  // A running Task moves updatedAt on every poll. Treating that as a reason to reload from scratch
  // replaced the tab the user was reading with a spinner every few seconds.
  const detailEffect = source.match(/useEffect\(\(\) => \{\s*detailGeneration\.current \+= 1[\s\S]*?\}, \[([^\]]*)\]\)/)
  assert.ok(detailEffect, "the detail effect must declare its dependencies")
  assert.doesNotMatch(detailEffect[1], /updatedAt/)
  assert.match(source, /void loadDetail\(selected, detailTab, true\)\s*\}, \[selectedUpdatedAt\]\)/)

  // An unreachable machine reports no Tasks for that cycle, which must not close the open one.
  assert.match(source, /const owner = next\.find\(\(runtime\) => current\.startsWith\(`\$\{runtime\.key\}\|`\)\)/)
  assert.match(source, /return owner && owner\.state !== "online" \? current : null/)
})

test("Attention replies report failure instead of dropping it", () => {
  const source = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")

  assert.match(source, /function PermissionAttentionCard/)
  assert.match(source, /async function reply\(decision: "once" \| "always" \| "reject"\)/)
  assert.match(source, /if \(sending\) return/)
  assert.match(source, /onError\(errorText\(reason\)\)/)
  assert.match(source, /attentionError \? <div className="td3-page-error td3-inline-error" role="alert">/)
  // The old markup fired the request from an inline handler with no catch and no busy state.
  assert.doesNotMatch(source, /void api\.replyPermission\([^)]*\)\.then\(\(\) => refresh\(\)\)/)
})

test("Every TaskDesk string resolves in all four supported languages", async () => {
  const { taskDeskDictionary, createTaskDeskTranslator } = await import("./taskdesk-i18n.ts")
  const languages = ["en", "it", "zh-TW", "zh-CN"]
  const keys = Object.keys(taskDeskDictionary)

  assert.ok(keys.length > 100, "the TaskDesk shell should be fully translated")
  for (const key of keys) {
    for (const language of languages) {
      const value = taskDeskDictionary[key][language]
      assert.equal(typeof value, "string", `${key} is missing ${language}`)
      assert.ok(value.trim().length > 0, `${key} is empty in ${language}`)
    }
  }

  // Placeholders must survive translation, or a count renders as literal text.
  for (const key of keys) {
    const expected = [...taskDeskDictionary[key].en.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const language of languages) {
      const actual = [...taskDeskDictionary[key][language].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
      assert.deepEqual(actual, expected, `${key} placeholders differ in ${language}`)
    }
  }

  assert.equal(createTaskDeskTranslator("it")("action.newTask"), "Nuovo Task")
  assert.equal(createTaskDeskTranslator("zh-TW")("nav.sessions"), "工作階段")
  assert.equal(createTaskDeskTranslator("zh-CN")("nav.sessions"), "会话")
  assert.equal(createTaskDeskTranslator("it")("machines.counts", { agents: 3, tasks: 5 }), "3 agenti · 5 Task")
})

test("Appearance and language are one preference shared with Classic", () => {
  const preferences = readFileSync(new URL("./appPreferences.ts", import.meta.url), "utf8")
  const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8")
  const taskDesk = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")

  assert.match(preferences, /export const LANGUAGE_STORAGE_KEY = "opencode\.remote\.language"/)
  assert.match(preferences, /export const THEME_STORAGE_KEY = "opencode\.remote\.theme"/)
  assert.match(preferences, /document\.documentElement\.dataset\.theme = resolved/)
  assert.match(preferences, /document\.documentElement\.style\.colorScheme = resolved/)
  assert.match(preferences, /return prefersDark\(\) \? "dark" : "light"/)

  // Classic applied the theme from inside its own tree, so TaskDesk — which boots first — never
  // applied one at all. Bootstrapping it here is what makes the saved preference take effect.
  assert.match(main, /installAppPreferences\(\)/)
  assert.match(taskDesk, /function SettingsModal/)
  assert.match(taskDesk, /persistThemePreference\(next\)/)
  assert.match(taskDesk, /persistLanguage\(next\)/)
  assert.match(taskDesk, /window\.addEventListener\(APP_PREFERENCES_CHANGED_EVENT, sync\)/)
})