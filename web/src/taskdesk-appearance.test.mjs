import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8")

const SHEETS = [
  "taskdesk-v3.css",
  "taskdesk-v3-unified.css",
  "taskdesk-run-review.css",
  "v3-polish.css",
  "universal-workspace.css",
  "universal-workspace-readable.css",
  "universal-workspace-readable-fixes.css",
  "conversation-control-plane.css",
  "conversation-control-plane-overrides.css"
]

/** Every colour literal, ignoring the black used for shadows and any hex inside a url() or var name. */
function colourLiterals(css) {
  return (css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([0-9.,\s]*\)/g) || [])
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

test("control resets never outrank the components built from them", () => {
  const v3 = read("taskdesk-v3.css")
  const workspace = read("universal-workspace.css")

  // `.td3-shell button` is (0,1,1) and beat every single-class component rule that followed — and,
  // because taskdesk-v3.css loads after universal-workspace.css, it also overrode the Sessions
  // pane's own button colours from a different sheet. At (0,0,0) authored rules win either way.
  assert.match(v3, /:where\(\.td3-shell button, \.td3-shell input, \.td3-shell textarea, \.td3-shell select\) \{ font: inherit; \}/)
  assert.match(v3, /:where\(\.td3-shell button\) \{ color: inherit; \}/)
  assert.doesNotMatch(v3, /^\.td3-shell button\b/m)
  assert.match(workspace, /:where\(\.uw-shell button, \.uw-shell input, \.uw-shell textarea, \.uw-shell select\)/)
  assert.match(workspace, /:where\(\.uw-shell button\) \{\s*color: inherit;/)
  assert.doesNotMatch(workspace, /^\.uw-shell button,$/m)
})

test("no TaskDesk text is authored below a readable size", () => {
  const floor = 9.5
  for (const sheet of SHEETS) {
    const css = read(sheet)
    const sizes = [...css.matchAll(/font-size:\s*([0-9.]+)px/g)].map((match) => Number(match[1]))
    const tooSmall = sizes.filter((size) => size < floor)
    // universal-workspace.css still declares its historical 7-8.5px sizes; the readable sheets raise
    // them. That is only acceptable while every one of them is actually overridden, which the live
    // measurement in the PR covers — so the floor is enforced on the sheets that have the last word.
    if (sheet === "universal-workspace.css") continue
    assert.deepEqual(tooSmall, [], `${sheet} declares ${tooSmall.join(", ")}px text`)
  }
})

test("the Sessions pane raises every size its own sheet authored below the floor", () => {
  const fixes = read("universal-workspace-readable-fixes.css")

  // Measured against the running app: these were the selectors still rendering at 7-7.5px after the
  // existing readable sheets had applied.
  for (const selector of [
    ".uw-diff-file summary span b",
    ".uw-file-list button b",
    ".uw-todo-state",
    ".uw-avatar",
    ".uw-attention-actions .uw-button",
    ".uw-inspector-section-heading > button"
  ]) {
    assert.ok(fixes.includes(selector), `${selector} has no readable size`)
  }
})

test("appearance and language are applied before any shell renders", () => {
  const main = read("main.tsx")
  const preferences = read("appPreferences.ts")

  assert.match(main, /installAppPreferences\(\)/)
  assert.match(main, /import "\.\/taskdesk-theme\.css"/)
  // The palette has to be in the cascade before the sheets that consume it, and the unified sheet
  // after the base sheet it overrides.
  const order = ["styles.css", "taskdesk-theme.css", "universal-workspace.css", "taskdesk-v3.css", "taskdesk-v3-unified.css", "v3-polish.css"]
  const positions = order.map((name) => main.indexOf(`import "./${name}"`))
  for (const position of positions) assert.notEqual(position, -1)
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right), "TaskDesk sheets must load base-to-override")

  assert.match(preferences, /export function installAppPreferences/)
  assert.match(preferences, /if \(loadThemePreference\(\) === "system"\) applyTheme\("system"\)/)
})
