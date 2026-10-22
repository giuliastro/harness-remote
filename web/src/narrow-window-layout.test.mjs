import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createTranslator } from "./i18n.ts"

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
const workspace = read("./components/standalone-universal-workspace.tsx")
const machineCss = read("./machine-card-layout.css")
const headerCss = read("./session-header-narrow.css")
const outcomeCss = read("./native-session-outcome.css")
const outcomePanel = read("./components/native-session-outcome-panel.tsx")
const controller = read("./components/work-thread-conversation.tsx")
const picker = read("./components/model-picker.tsx")
const controlsCss = read("./beautiful-ui-controls.css")
const main = read("./main.tsx")

const importIndex = (sheet) => {
  const index = main.indexOf(`import "./${sheet}"`)
  assert.notEqual(index, -1, `${sheet} is imported`)
  return index
}

test("a machine card leads with its identity, then facts, folders and actions", () => {
  const card = workspace.slice(workspace.indexOf('className="uw-machine-config-card"'), workspace.indexOf('className="uw-machine-config-actions"'))
  const header = card.indexOf('className="uw-machine-card-header"')
  const facts = card.indexOf('className="uw-machine-card-facts"')
  const agents = card.indexOf('className="uw-machine-harness-list"')
  const folders = card.indexOf("<MachineFolderSummary")
  assert.ok(header > -1 && header < facts && facts < agents && agents < folders, "header, facts, agents, then folders")
  // Name and connection state live together in the header.
  assert.match(card.slice(header, facts), /<strong>[\s\S]*uw-machine-connection-state/)
  // The address is a labelled fact instead of a bare line.
  assert.match(card.slice(facts, agents), /<dt>\{t\("pair\.address"\)\}<\/dt>[\s\S]*<dd><code>\{machine\.config\.host\}:\{machine\.config\.port\}<\/code><\/dd>/)
})

test("on a narrow window the machine actions move to a footer below the details", () => {
  assert.match(machineCss, /@media \(max-width: 780px\)[\s\S]*grid-template-areas: "details" "actions" !important/)
  assert.match(machineCss, /\.uw-machine-config-actions \{[^}]*border-top: 1px solid var\(--td3-border\)/)
  assert.match(machineCss, /\.uw-machine-folder-summary \{[^}]*border-top: 1px solid var\(--td3-border\)/)
  // The phone rules that put the actions first (now folded into v3-mobile.css) are overridden only
  // because this sheet loads later.
  assert.ok(importIndex("machine-card-layout.css") > importIndex("v3-mobile.css"))
})

test("the narrow Session header puts the back arrow and title on one row with a secondary line", () => {
  assert.match(headerCss, /^@media \(max-width: 780px\)/m)
  assert.match(headerCss, /grid-template-areas:\s*"title title"\s*"harness origin"/)
  // The title row has the back button's height, so the arrow and the title share a centre line.
  assert.match(headerCss, /\.hr-native-session-heading > \.hr-native-session-title \{[^}]*min-height: 38px;[^}]*align-items: center;/)
  assert.match(headerCss, /\.hr-native-session-heading > \.hr-native-session-eyebrow \{[^}]*grid-area: harness;/)
  assert.match(headerCss, /\.hr-native-session-heading > small:not\(\.hr-native-session-directory\) \{[^}]*grid-area: origin;/)
  assert.ok(importIndex("session-header-narrow.css") > importIndex("beautiful-ui-controls.css"))
})

test("the outcome is one collapsed summary row on a narrow window", () => {
  assert.match(outcomePanel, /const \[expanded, setExpanded\] = useState\(false\)/)
  assert.match(outcomePanel, /\{expanded \? \(/)
  assert.match(outcomeCss, /@media \(max-width: 780px\)[\s\S]*\.hr-native-outcome:not\(\.compact\) \{[^}]*margin: 6px 10px;/)
  assert.match(outcomeCss, /\.hr-native-outcome:not\(\.compact\) \.hr-native-outcome-toggle \{[^}]*grid-template-columns: auto minmax\(0, 1fr\) auto;/)
  assert.match(outcomeCss, /\.hr-native-outcome:not\(\.compact\) \.hr-native-outcome-body \{[^}]*max-height: min\(320px, 40vh\);[^}]*overflow: auto;/)
  // The project name leaves the summary row but stays reachable in the detail.
  assert.match(outcomePanel, /projectName && !compact \? <span className="hr-native-outcome-project">/)
  // The two-row phone layout is gone.
  assert.doesNotMatch(outcomeCss, /grid-row: 2;/)
})

test("waiting for the model catalog is a visible composer state, not a silently inert field", () => {
  assert.match(controller, /const modelWaitLabel = !modelBootstrapBlocked\s*\? undefined\s*: modelsLoading\s*\? t\("composer\.loadingModels"\)/)
  assert.match(controller, /composerBusyLabel=\{interactionEnabled \? modelWaitLabel : undefined\}/)
  assert.match(controller, /composerDisabled=\{!interactionEnabled \|\| modelBootstrapBlocked\}/)
  assert.match(controller, /const conversationStateLabel = modelWaitLabel \?\? waitingLabel/)
  assert.match(picker, /\? t\("composer\.loadingModels"\)/)
  assert.match(picker, /aria-busy=\{loading \|\| undefined\}/)
  assert.match(controlsCss, /\.uw-composer-shell\.busy textarea:disabled \{[^}]*opacity: \.55;/)
})

test("the model wait is translated in every language", () => {
  const keys = ["composer.loadingModels", "composer.waitingForModel", "composer.modelUnavailable"]
  const english = createTranslator("en")
  assert.equal(english("composer.loadingModels"), "Loading models…")
  for (const language of ["it", "zh-TW", "zh-CN", "pt-BR"]) {
    const translate = createTranslator(language)
    for (const key of keys) {
      const text = translate(key)
      assert.notEqual(text, key, `${language} has ${key}`)
      assert.notEqual(text, english(key), `${language} translates ${key}`)
    }
  }
  assert.equal(createTranslator("pt-BR")("composer.loadingModels"), "Carregando modelos…")
})

test("the Session working directory keeps its own line, clipped at the start", () => {
  assert.match(workspace, /<small className="hr-native-session-directory hr-path-tail" title=\{selected\.directory\}><bdi>\{selected\.directory\}<\/bdi><\/small>/)
  assert.match(headerCss, /"directory directory"/)
  assert.match(headerCss, /\.hr-native-session-heading > \.hr-native-session-directory \{[^}]*grid-area: directory;/)
  // Clipped at the start so the end of the path stays readable; the characters keep their order.
  assert.match(headerCss, /\.hr-path-tail \{[^}]*direction: rtl;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/)
  assert.match(headerCss, /\.hr-path-tail > bdi \{[^}]*direction: ltr;/)
})

test("the machine editor lays folders out as rows and keeps a consistent footer", () => {
  assert.match(workspace, /<li key=\{root\}><code className="hr-path-tail" title=\{root\}><bdi>\{root\}<\/bdi><\/code><button/)
  assert.match(workspace, /<div className="hr-project-roots-add">/)
  assert.match(workspace, /data-machine-test/)
  assert.match(machineCss, /\.hr-project-roots-list li \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/)
  assert.match(machineCss, /\.hr-project-roots-list \.uw-manager-button \{[^}]*width: 96px;/)
  assert.match(machineCss, /\.uw-machine-editor-actions \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\) !important;/)
  assert.match(machineCss, /\[data-machine-test\] \{[^}]*grid-column: 1 \/ -1 !important;/)
})
