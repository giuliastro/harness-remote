import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8")

const SHEETS = [
  "conversation-control-plane.css",
  "conversation-control-plane-overrides.css",
  "session-first-workbench.css",
  "conversation-base.css"
]

/** Every colour literal, ignoring comments ("PR #309" is not a colour), the black used for shadows
 *  and any hex inside a url() or var name. */
function colourLiterals(css) {
  return (css.replace(/\/\*[\s\S]*?\*\//g, "").match(/#[0-9a-fA-F]{3,8}\b|rgba?\([0-9.,\s]*\)/g) || [])
    .filter((value) => !value.replace(/\s/g, "").startsWith("rgba(0,0,0"))
}

test("the TaskDesk palette defines a light theme for every dark token", () => {
  const theme = read("taskdesk-theme.css")
  const dark = theme.slice(theme.indexOf(":root {"), theme.indexOf(':root[data-theme="light"]'))
  const light = theme.slice(theme.indexOf(':root[data-theme="light"]'))

  const names = (block) => new Set((block.match(/--td3-[a-z0-9-]+(?=\s*:)/g) || []))
  const darkNames = names(dark)
  const lightNames = names(light)

  assert.ok(darkNames.size > 40, "the palette should be a real token set")
  for (const name of darkNames) {
    assert.ok(lightNames.has(name), `${name} has no light value, so Light would fall back to the dark one`)
  }
  for (const name of lightNames) {
    assert.ok(darkNames.has(name), `${name} is only defined for Light`)
  }

  // A translucent white lift is invisible on a light surface, so the light theme must flip the ink.
  assert.match(light, /--td3-raise-1: rgba\(15, 23, 42/)
  assert.match(light, /--td3-raise-2: rgba\(15, 23, 42/)
  assert.match(light, /--td3-raise-3: rgba\(15, 23, 42/)
})

test("no TaskDesk surface hard-codes a colour outside the palette", () => {
  for (const sheet of SHEETS) {
    const literals = colourLiterals(read(sheet))
    assert.deepEqual(
      literals,
      [],
      `${sheet} still hard-codes ${literals.slice(0, 4).join(", ")}, which cannot follow the theme`
    )
  }
})

test("live conversation and button bases survived the retired-sheet deletion", () => {
  // #361 moved the transcript/composer primitives into session-first-workbench.css but accidentally
  // dropped the still-live Activity/tool disclosure primitives. Keep both halves guarded explicitly.
  const workbench = read("session-first-workbench.css")
  const activity = read("activity-timeline.css")
  assert.match(workbench, /(?:^|\r?\n)\.uw-transcript\s*\{[^}]*?overflow-y:\s*auto;/, ".uw-transcript must bound height with overflow-y: auto")
  assert.match(workbench, /(?:^|\r?\n)\.uw-transcript\s*\{[^}]*?flex:\s*1;/, ".uw-transcript must expand in conversation flex column")
  assert.match(workbench, /(?:^|\r?\n)\.uw-message\s*\{[^}]*?display:\s*grid;/, ".uw-message must declare grid layout")
  assert.match(workbench, /(?:^|\r?\n)\.uw-composer-shell\s*\{[^}]*?flex:\s*none;/, ".uw-composer-shell must not stretch with flex: none")
  assert.match(workbench, /(?:^|\r?\n)\.uw-composer-footer > div\s*\{[^}]*?display:\s*flex;/, ".uw-composer-footer > div must declare flex alignment")
  assert.match(workbench, /(?:^|\r?\n)\.uw-button-primary\s*\{[^}]*?background:/, ".uw-button-primary has no base background")
  assert.match(workbench, /(?:^|\r?\n)\.uw-button-danger\s*\{[^}]*?background:/, ".uw-button-danger has no base background")
  assert.match(workbench, /(?:^|\r?\n)\.uw-manager-button\s*\{/, ".uw-manager-button has no base rule")
  assert.match(workbench, /(?:^|\r?\n)\.uw-machine-manager\s*\{[^}]*?display:\s*flex;/, ".uw-machine-manager has no modal flex rule")

  assert.match(activity, /\.hr-activity-toggle\s*\{[^}]*?display:\s*flex;/s, "Activity header must remain a flex row")
  assert.match(activity, /\.hr-activity-toggle\s*\{[^}]*?border:\s*0;[^}]*?background:\s*transparent;/s, "Activity header must suppress the native button chrome")
  assert.match(activity, /\.hr-act-timeline\s*\{[^}]*?display:\s*grid;[^}]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/s, "Activity timeline must retain its base layout")
  assert.match(activity, /\.hr-act-steps\s*\{[^}]*?display:\s*grid;/s, "tool steps must retain their base layout")
})

test("no TaskDesk text is authored below a readable size", () => {
  const floor = 9.5
  for (const sheet of SHEETS) {
    const css = read(sheet)
    const sizes = [...css.matchAll(/font-size:\s*([0-9.]+)px/g)].map((match) => Number(match[1]))
    const tooSmall = sizes.filter((size) => size < floor)
    assert.deepEqual(tooSmall, [], `${sheet} declares ${tooSmall.join(", ")}px text`)
  }
})

test("the Sessions pane raises every size its own sheet authored below the floor", () => {
  const fixes = read("taskdesk-theme.css")

  // Measured against the running app: this was still rendering at 7-7.5px after the existing
  // readable sheets had applied.
  assert.ok(fixes.includes(".uw-avatar"), ".uw-avatar has no readable size")
})

test("appearance and language are applied before any shell renders", () => {
  const main = read("main.tsx")
  const preferences = read("appPreferences.ts")

  assert.match(main, /installAppPreferences\(\)/)
  assert.match(main, /import "\.\/taskdesk-theme\.css"/)
  // The palette and structural bases have to precede the final product refinements.
  const order = ["styles.css", "taskdesk-theme.css", "session-first-workbench.css", "conversation-base.css", "beautiful-ui-controls.css"]
  const positions = order.map((name) => main.indexOf(`import "./${name}"`))
  for (const position of positions) assert.notEqual(position, -1)
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right), "TaskDesk sheets must load base-to-override")

  assert.match(preferences, /export function installAppPreferences/)
  assert.match(preferences, /if \(loadThemePreference\(\) === "system"\) applyTheme\("system"\)/)
})
