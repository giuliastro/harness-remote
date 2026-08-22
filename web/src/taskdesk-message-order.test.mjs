import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { assistantTerminalTextForPrompt } from "./message-content.ts"

function message(id, role, parts) {
  return {
    info: { id, role, sessionID: "s", time: { created: Date.now() } },
    parts: parts.map((part, index) => ({ id: `${id}:${index}`, messageID: id, ...part }))
  }
}

const claudeStyleReply = message("assistant-1", "assistant", [
  { type: "reasoning", text: "I should inspect the files first." },
  { type: "text", text: "I found the likely cause. I will verify it." },
  { type: "tool", tool: "bash", state: { status: "completed", title: "Run tests", input: { command: "npm test" }, output: "ok" } },
  { type: "reasoning", text: "The tests confirm the fix." },
  { type: "text", text: "Fixed the UI glitch and opened PR #276." }
])

test("terminal result keeps only text after the last reasoning/tool activity", () => {
  assert.equal(
    assistantTerminalTextForPrompt([
      message("user-1", "user", [{ type: "text", text: "Fix the TaskDesk UI" }]),
      claudeStyleReply
    ], "Fix the TaskDesk UI"),
    "Fixed the UI glitch and opened PR #276."
  )
})

test("latest terminal result never crosses the latest user turn", () => {
  const transcript = [
    message("user-1", "user", [{ type: "text", text: "First request" }]),
    message("assistant-old", "assistant", [{ type: "text", text: "Old answer" }]),
    message("user-2", "user", [{ type: "text", text: "Current request" }]),
    message("assistant-current", "assistant", [{ type: "text", text: "Current answer" }])
  ]
  assert.equal(assistantTerminalTextForPrompt(transcript, "Current request"), "Current answer")
})

test("tool activity in a later assistant envelope blocks earlier narration", () => {
  const transcript = [
    message("user", "user", [{ type: "text", text: "Do work" }]),
    message("assistant-narration", "assistant", [{ type: "text", text: "I am checking now" }]),
    message("assistant-tool", "assistant", [{ type: "tool", tool: "bash", state: { status: "completed" } }])
  ]
  assert.equal(assistantTerminalTextForPrompt(transcript, "Do work"), "")
})

test("final text in a later assistant envelope wins after tool activity", () => {
  const transcript = [
    message("user", "user", [{ type: "text", text: "Do work" }]),
    message("assistant-narration", "assistant", [{ type: "text", text: "I am checking now" }]),
    message("assistant-tool", "assistant", [{ type: "tool", tool: "bash", state: { status: "completed" } }]),
    message("assistant-final", "assistant", [{ type: "text", text: "Done and verified" }])
  ]
  assert.equal(assistantTerminalTextForPrompt(transcript, "Do work"), "Done and verified")
})

test("Task summary stays attached to its Run prompt after the Session is continued manually", () => {
  const transcript = [
    message("task-user", "user", [{ type: "text", text: "Fix the TaskDesk UI" }]),
    claudeStyleReply,
    message("manual-user", "user", [{ type: "text", text: "Now refactor something else" }]),
    message("manual-assistant", "assistant", [{ type: "text", text: "The unrelated refactor is complete." }])
  ]

  assert.equal(
    assistantTerminalTextForPrompt(transcript, "Fix the TaskDesk UI"),
    "Fixed the UI glitch and opened PR #276."
  )
})

test("TaskDesk renderer keeps Activity collapsed by default while retaining technical content", () => {
  const renderer = readFileSync(new URL("./components/taskdesk-message-content.tsx", import.meta.url), "utf8")
  assert.match(renderer, /visibleParts = message\.parts\.filter/)
  assert.match(renderer, /groupConversationParts\(visibleParts,/)
  assert.match(renderer, /forceActivity: liveAssistant/)
  assert.match(renderer, /forceRunning: liveAssistant/)
  assert.match(renderer, /group\.kind === "content"/)
  assert.match(renderer, /uw-activity-group/)
  assert.match(renderer, /ActivityPart/)
  assert.match(renderer, /part\.type === "reasoning" \|\| part\.type === "text"/)
  assert.match(renderer, /useState\(group\.status === "error"\)/)
  assert.match(renderer, /if \(group\.status === "error"\) setOpen\(true\)/)
  assert.match(renderer, /open=\{open\}/)
  assert.match(renderer, /\{open \? \(/)
  assert.match(renderer, /group\.parts\.map\(\(part\) => <ActivityPart/)
  assert.match(renderer, /"step-start", "step-finish", "snapshot", "patch"/)
})

test("Work Thread keeps live state in compact chat chrome and forbids detached waiting rows", () => {
  const conversation = readFileSync(new URL("./components/work-thread-conversation.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(conversation, /tdw-turn-working/)
  assert.doesNotMatch(conversation, /workingMessageID/)
  assert.match(conversation, /showWaitingIndicator=\{false\}/)
  assert.match(conversation, /ConversationStatePill/)
})

test("legacy unversioned persisted outcomes fall back to transcript reconstruction", () => {
  const client = readFileSync(new URL("./taskClient.ts", import.meta.url), "utf8")
  assert.match(client, /outcomeVersion\?: number/)
  assert.match(client, /run\.outcomeVersion !== 2/)
  assert.match(client, /\{ \.\.\.run, outcome: undefined \}/)
})
