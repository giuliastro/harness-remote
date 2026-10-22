import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

// Re-run the UI regression gate against the current Session-first checkpoint before merging #309.
const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8")
const hook = read("./useDialogDismiss.ts")
const standalone = read("./components/standalone-universal-workspace.tsx")
const pairingDialog = read("./components/machine-pairing-dialog.tsx")
const actions = read("./components/native-session-actions.tsx")
const rename = read("./components/native-session-rename.tsx")

test("every Session-first dialog closes on Escape, traps Tab and restores focus", () => {
  assert.match(hook, /event\.key === "Escape"/)
  assert.match(hook, /event\.key !== "Tab"/)
  assert.match(hook, /if \(previouslyFocused\?\.isConnected\) previouslyFocused\.focus\(\)/)
})

test("an unrendered dialog branch cannot steal Escape from the rendered one", () => {
  assert.match(hook, /if \(!enabled \|\| !container\) return/)
  assert.match(hook, /\}, \[ref, autoFocus, enabled\]\)/)
  assert.match(actions, /useDialogDismiss\(deleteRef, close, \{ enabled: mode === "delete" \}\)/)
})

test("an open model popover inside a Session dialog owns Escape first", () => {
  assert.match(hook, /container\.querySelector\("\.tdw-model-picker\.open"\)/)
  assert.match(standalone, /\.tdw-model-picker\.open \.tdw-model-trigger/)
  assert.match(standalone, /modelPickerTrigger\.click\(\)/)
})

test("the active Session-first shell dialogs use the shared dismissal behaviour", () => {
  assert.match(standalone, /useDialogDismiss\(dialogRef, dismiss, \{ enabled: !pairingMachine \}\)/)
  assert.match(standalone, /useDialogDismiss\(pageRef, onClose, \{ autoFocus: false \}\)/)
  assert.match(pairingDialog, /useDialogDismiss\(dialogRef, onClose\)/)
  assert.match(actions, /useDialogDismiss\(deleteRef, close/)
  assert.equal(existsSync(new URL("./components/native-session-handoff-control.tsx", import.meta.url)), false)
})

test("no blocking native dialog is used for destructive Session-first actions", () => {
  const source = `${standalone}\n${actions}`.replace(/^\s*\/\/.*$/gm, "")
  assert.doesNotMatch(source, /window\.confirm/)
  assert.match(standalone, /confirmRemoveID/)
  assert.match(standalone, /uw-machine-confirm/)
  assert.match(actions, /mode === "delete"/)
  assert.match(actions, /hr-session-action-panel/)
})

test("native Session rename keeps phone and keyboard input accessible", () => {
  // Rename is an inline edit of the header's own heading rather than a dialog, so the dismissal hook
  // does not apply to it - but the keyboard contract a dialog gave it still has to hold: the field
  // takes focus by itself, Enter commits, Escape restores the previous name, and the harness limit
  // on a Session name is enforced at the input.
  assert.match(rename, /input\.focus\(\)/)
  assert.match(rename, /input\.select\(\)/)
  assert.match(rename, /event\.key === "Enter"/)
  assert.match(rename, /event\.key === "Escape"/)
  assert.match(rename, /void commit\(\)/)
  assert.match(rename, /cancelEdit\(\)/)
  assert.match(rename, /maxLength=\{200\}/)
  assert.match(rename, /aria-label=\{t\("sf\.sessionName"\)\}/)
  assert.equal(existsSync(new URL("./components/conversation-workspace.tsx", import.meta.url)), false)
})
