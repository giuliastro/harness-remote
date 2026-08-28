import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const chat = readFileSync(new URL("./components/work-thread-conversation.tsx", import.meta.url), "utf8")
const picker = readFileSync(new URL("./components/model-picker.tsx", import.meta.url), "utf8")
const observer = readFileSync(new URL("./components/native-session-observer.tsx", import.meta.url), "utf8")

test("the shared Session chat signature is not recomputed on every keystroke", () => {
  assert.match(chat, /const conversationSignature = useMemo\(\(\) => runtimeSignature\(conversation\), \[conversation\]\)/)
  assert.doesNotMatch(chat, /^\s*const conversationSignature = runtimeSignature\(conversation\)\s*$/m)
})

test("the Session composer draft is persisted on a debounce, not on every keystroke", () => {
  assert.match(chat, /const DRAFT_PERSIST_DEBOUNCE_MS = \d+/)
  assert.match(chat, /window\.setTimeout\(\(\) => persistDraft\(draftStorageKey, draftRef\.current\), DRAFT_PERSIST_DEBOUNCE_MS\)/)
  assert.match(chat, /useEffect\(\(\) => \(\) => persistDraft\(draftStorageKey, draftRef\.current\)/)
  assert.doesNotMatch(chat, /if \(draft\) localStorage\.setItem\(draftStorageKey, draft\)/)
})

test("a private-mode storage failure cannot break Session typing", () => {
  const persist = chat.match(/const persistDraft = useCallback[\s\S]*?\n  \}, \[\]\)/)?.[0] || ""
  assert.match(persist, /try \{/)
  assert.match(persist, /\} catch \{/)
})

test("the working clock only ticks while a native turn is running", () => {
  const hook = chat.match(/function useElapsedSeconds[\s\S]*?\n\}/)?.[0] || ""
  assert.match(hook, /if \(!running\) \{/)
  assert.match(hook, /window\.setInterval\(tick, 1_000\)/)
})

test("an empty model catalog is a resolved native Session state, not a dead disabled control", () => {
  assert.match(picker, /const empty = !loading && models\.length === 0/)
  assert.match(picker, /empty\s*\n\s*\? "Harness default"/)
  assert.match(picker, /Chosen by the coding agent/)
  assert.doesNotMatch(picker, /disabled=\{disabled \|\| loading \|\| models\.length === 0\}/)
  assert.match(observer, /deferModelFallback/)
})

test("a model catalog failure never blocks the native Session transcript", () => {
  assert.match(chat, /const \[modelError, setModelError\] = useState<string \| null>\(null\)/)
  assert.match(chat, /setModelError\(reason instanceof Error \? reason\.message : String\(reason\)\)/)
  assert.match(chat, /tdw-field-note/)
  assert.match(chat, /Model catalog unavailable\. Continue uses the harness default\./)
  assert.match(chat, /unavailableHint=\{modelError \|\| undefined\}/)
  assert.equal(existsSync(new URL("./components/conversation-workspace.tsx", import.meta.url)), false)
})
