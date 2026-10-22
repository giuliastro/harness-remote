import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./components/taskdesk-message-content.tsx", import.meta.url), "utf8")
const activityModel = readFileSync(new URL("./activity-model.ts", import.meta.url), "utf8")
const activityStyles = readFileSync(new URL("./activity-timeline.css", import.meta.url), "utf8")
const styles = readFileSync(new URL("./taskdesk-conversation.css", import.meta.url), "utf8")
const baseStyles = readFileSync(new URL("./conversation-base.css", import.meta.url), "utf8")

test("native provider and harness failures remain visible inside the persisted conversation", () => {
  assert.match(source, /function readableErrorValue/)
  assert.match(source, /message\.info\.error/)
  assert.match(source, /error\.data\?\.message/)
  assert.match(source, /readableErrorValue\(error\.message\)/)
  assert.match(source, /className="uw-message-turn-error" role="alert"/)
  assert.match(source, />Turn failed</)
  assert.match(styles, /\.uw-message-turn-error \{/)
  assert.match(styles, /var\(--td3-red-border\)/)
})

test("a native turn failure wins over a stale live-active bit before reload", () => {
  assert.match(source, /const reportedError = messageErrorText\(message\)/)
  assert.match(source, /const hasFinalText = hasTerminalAssistantText\(message\.parts, reportedError\)/)
  assert.match(source, /const liveTurnFailed = Boolean\(reportedError\) && !hasFinalText/)
  assert.match(source, /Boolean\(\(message as TaskDeskEnvelope\)\.taskdesk\?\.active\)[\s\S]*&& !liveTurnFailed/)
  assert.match(source, /const turnError = liveAssistant \|\| hasFinalText \? "" : reportedError/)
})

test("assistant wording can never classify a message as an error", () => {
  assert.match(source, /const error = message\.info\.error/)
  assert.match(source, /if \(!error\) return ""/)
  assert.doesNotMatch(source, /PROVIDER_FAILURE_TEXT/)
  assert.doesNotMatch(source, /inferredProviderErrorText/)
})

test("provider error text duplication is not mistaken for a model final answer", () => {
  assert.match(source, /function textMirrorsReportedError/)
  assert.match(source, /function normalizeErrorComparable/)
  assert.match(source, /if \(reportedError && textMirrorsReportedError\(part\.text, reportedError\)\) continue/)
  assert.match(source, /return !\(reportedError && part\.type === "text" && textMirrorsReportedError\(part\.text, reportedError\)\)/)
})

test("provider diagnostics are compacted only after a structured error exists", () => {
  assert.match(source, /function cleanReportedErrorText/)
  assert.match(source, /raw-http-request=\\S\+/)
  assert.match(source, /function collapseRepeatedErrorBody/)
  assert.match(source, /const error = message\.info\.error/)
  assert.match(source, /if \(!error\) return ""/)
  assert.match(source, /const mirroredText = message\.parts\.find/)
  assert.match(source, /return cleanReportedErrorText\(mirroredText \|\| raw\)/)
})

test("OpenCode protocol bookkeeping never leaks into the visible chat", () => {
  assert.match(activityModel, /INTERNAL_PROTOCOL_PARTS = new Set\(\["step-start", "step-finish", "snapshot", "patch"\]\)/)
  assert.match(source, /if \(isInternalProtocolPart\(part\)\) return false/)
})

test("a terminal assistant turn with only reasoning or tools is never silently presented as complete", () => {
  assert.match(source, /interruptedWithoutFinal/)
  assert.match(source, />Response interrupted</)
  assert.match(source, /stopped before producing a final answer/)
  assert.match(source, /assistantTurnCompleted\(message\)/)
})

test("a later real final answer suppresses a stale transport or intermediate structured turn error", () => {
  assert.match(source, /const hasFinalText = hasTerminalAssistantText\(message\.parts, reportedError\)/)
  assert.match(source, /if \(reportedError && textMirrorsReportedError\(part\.text, reportedError\)\) continue/)
  assert.match(source, /return true/)
  assert.match(source, /const liveTurnFailed = Boolean\(reportedError\) && !hasFinalText/)
  assert.match(source, /const turnError = liveAssistant \|\| hasFinalText \? "" : reportedError/)
})

test("Activity-to-answer rhythm and fallback protocol parts stay visually contained", () => {
  assert.match(activityStyles, /\.hr-activity \+ \.uw-message-content-group \{[\s\S]*?margin-top: 12px;/)
  assert.match(baseStyles, /\.uw-unsupported-part \{[\s\S]*?max-width: 100%;[\s\S]*?overflow-wrap: anywhere;/)
  assert.match(baseStyles, /\.tdw-work-thread-conversation \.uw-message-turn-error \{[\s\S]*?overflow-wrap: anywhere;/)
})
