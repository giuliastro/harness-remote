import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const conversation = readFileSync(new URL("./components/work-thread-conversation.tsx", import.meta.url), "utf8")

const i18n = readFileSync(new URL('./i18n.ts', import.meta.url), 'utf8')

test("the conversation signature is not recomputed on every keystroke", () => {
  // `taskConversationSignature` JSON.stringifies every Run. Rendered unconditionally it ran once per
  // character typed in the composer, which is exactly the long-conversation typing lag it caused.
  assert.match(conversation, /const conversationSignature = useMemo\(\(\) => taskConversationSignature\(task\), \[task\]\)/)
  assert.doesNotMatch(conversation, /^\s*const conversationSignature = taskConversationSignature\(task\)\s*$/m)
})

test("the composer draft is persisted on a debounce, not on every keystroke", () => {
  assert.match(conversation, /const DRAFT_PERSIST_DEBOUNCE_MS = \d+/)
  assert.match(conversation, /window\.setTimeout\(\(\) => persistDraft\(draftStorageKey, draftRef\.current\), DRAFT_PERSIST_DEBOUNCE_MS\)/)
  // Leaving the conversation must still flush whatever the debounce has not written yet.
  assert.match(conversation, /useEffect\(\(\) => \(\) => persistDraft\(draftStorageKey, draftRef\.current\)/)
  assert.doesNotMatch(conversation, /if \(draft\) localStorage\.setItem\(draftStorageKey, draft\)/)
})

test("a private-mode storage failure cannot break typing", () => {
  const persist = conversation.match(/const persistDraft = useCallback[\s\S]*?\n  \}, \[\]\)/)?.[0] || ""
  assert.match(persist, /try \{/)
  assert.match(persist, /\} catch \{/)
})

test("the working clock only ticks while a Run is actually running", () => {
  const hook = conversation.match(/function useElapsedSeconds[\s\S]*?\n\}/)?.[0] || ""
  assert.match(hook, /if \(!running\) \{/)
  assert.match(hook, /window\.setInterval\(tick, 1_000\)/)
})

const picker = readFileSync(new URL("./components/model-picker.tsx", import.meta.url), "utf8")
const workspace = readFileSync(new URL("./components/conversation-workspace.tsx", import.meta.url), "utf8")

test("an empty model catalog is a resolved state, not a dead disabled control", () => {
  // Discovery is explicitly not a prerequisite: the conversation runs on the harness-native default.
  assert.match(picker, /const empty = !loading && models\.length === 0/)
  assert.match(picker, /empty\s*\n\s*\? "Harness default"/)
  assert.match(picker, /Chosen by the coding agent/)
  assert.doesNotMatch(picker, /disabled=\{disabled \|\| loading \|\| models\.length === 0\}/)
})

test("a model catalog failure never renders as a blocking modal error", () => {
  assert.match(workspace, /const \[modelError, setModelError\] = useState<string \| null>\(null\)/)
  assert.match(workspace, /setModelError\(errorText\(reason\)\)/)
  assert.match(workspace, /tdw-field-note/)
  // The red role="alert" block stays reserved for a real Start failure.
  const startCatch = workspace.match(/\} catch \(reason\) \{\s*setError\(errorText\(reason\)\)/)
  assert.ok(startCatch, "Start failures must still surface as the modal error")
})

test("the conversation toolbar and the New Conversation modal say the same thing", () => {
  // The conversation's half of this pair moved into the dictionary; the modal's has not been
  // translated yet, so assert each where it now lives rather than dropping the pairing.
  assert.match(conversation, /t\("sf\.modelCatalogUnavailable"\)/)
  assert.match(i18n, /'sf\.modelCatalogUnavailable': 'Model catalog unavailable\. Continue uses the harness default\.'/)
  assert.match(workspace, /Model catalog unavailable\. The conversation starts on the harness default\./)
  assert.match(conversation, /unavailableHint=\{modelError \|\| undefined\}/)
})
