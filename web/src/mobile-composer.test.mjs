import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createTranslator } from "./i18n.ts"

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
const css = read("./mobile-composer.css")
const main = read("./main.tsx")
const settings = read("./components/standalone-universal-workspace.tsx")

test("phone composer controls sit in a wrapping row below the draft", () => {
  assert.match(css, /@media \(max-width: 780px\)/)
  assert.match(css, /\.uw-composer-footer \{[\s\S]*?position: static !important;[\s\S]*?flex-wrap: wrap !important;/)
  assert.match(css, /\.uw-composer-footer > div \{[\s\S]*?flex-wrap: wrap !important;/)
  // The old overlay reserved 54px on the right for Send, but the footer also contains Ready,
  // paperclip and effort. The field now gets its full width back.
  assert.match(css, /\.uw-composer-shell textarea \{[\s\S]*?padding: 10px 12px 8px !important;/)
  assert.doesNotMatch(css, /padding:\s*10px 54px/)
  assert.match(css, /\.tdw-composer-status \{[\s\S]*?max-width: 46%;[\s\S]*?margin-right: auto;/)
  assert.match(css, /\.uw-button-primary,[\s\S]*?margin-left: auto;/)
})

test("the final composer sheet loads after the compact and mobile sheets", () => {
  const composerIndex = main.indexOf('import "./mobile-composer.css"')
  assert.notEqual(composerIndex, -1)
  for (const sheet of ["v3-mobile.css", "mobile-compact-chat.css", "compact-final-touch.css", "conversation-control-plane-overrides.css"]) {
    assert.ok(composerIndex > main.indexOf(`import "./${sheet}"`), `${sheet} loads before the final composer fixes`)
  }
})

test("Settings offers a real restore action for a hidden connection notification", () => {
  assert.match(settings, /restoreBackgroundAttentionNotification/)
  assert.match(settings, /showBackgroundNotification/)
  assert.match(settings, /settings\.backgroundShow/)
  assert.match(settings, /data-settings-background/)
})

test("the background connection copy exists in every supported language", () => {
  const keys = [
    "settings.backgroundTitle",
    "settings.backgroundShow",
    "settings.backgroundHint",
    "settings.backgroundRestored",
    "settings.backgroundUnavailable"
  ]
  const english = createTranslator("en")
  for (const language of ["en", "it", "zh-TW", "zh-CN", "pt-BR"]) {
    const translate = createTranslator(language)
    for (const key of keys) {
      const value = translate(key)
      assert.notEqual(value, key, `${language} has ${key}`)
      assert.ok(value.length > 0)
      if (language !== "en") assert.notEqual(value, english(key), `${language} translates ${key}`)
    }
  }
})
