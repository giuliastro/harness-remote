import assert from "node:assert/strict"
import test from "node:test"
import { stripAmbientContext } from "../src/ambient-context.js"

const browser = '<in-app-browser-context source="ambient-ui-state">\nURL: http://localhost:5173\n</in-app-browser-context>'

test("keeps only the request the Codex desktop app wrapped in its browser context", () => {
  assert.equal(
    stripAmbientContext(`\n${browser}\n\n## My request:\ndi nuovo, non fare nulla ma pensa per 10 secondi poi rispondimi "ok"\n`),
    'di nuovo, non fare nulla ma pensa per 10 secondi poi rispondimi "ok"'
  )
})

test("strips every leading ambient block, whatever its context tag", () => {
  const editor = '<open-files-context source="ambient-ui-state">\nsrc/app.js\n</open-files-context>'
  assert.equal(stripAmbientContext(`${browser}\n${editor}\n\n## My request:\nfix it\n\nplease`), "fix it\n\nplease")
  assert.equal(stripAmbientContext(`${browser}\nno heading here`), "no heading here")
})

test("leaves a message without ambient blocks exactly as written", () => {
  for (const text of [
    "a plain request",
    "## My request:\nwritten by hand",
    `quoting one: ${browser}\n\n## My request:\nwhy is this here?`,
    '<in-app-browser-context source="something-else">x</in-app-browser-context>\n## My request:\ny',
    "  indented\n"
  ]) assert.equal(stripAmbientContext(text), text)
})

test("leaves a malformed or unclosed ambient block as it is", () => {
  const unclosed = '<in-app-browser-context source="ambient-ui-state">\nURL\n\n## My request:\nhello'
  assert.equal(stripAmbientContext(unclosed), unclosed)
  const mismatched = '<in-app-browser-context source="ambient-ui-state">URL</other-context>\n## My request:\nhello'
  assert.equal(stripAmbientContext(mismatched), mismatched)
  const secondUnclosed = `${browser}\n<open-files-context source="ambient-ui-state">\n## My request:\nhello`
  assert.equal(stripAmbientContext(secondUnclosed), secondUnclosed)
  const onlyContext = `${browser}\n\n## My request:\n`
  assert.equal(stripAmbientContext(onlyContext), onlyContext)
})
