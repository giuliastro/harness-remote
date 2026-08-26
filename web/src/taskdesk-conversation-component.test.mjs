import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const component = readFileSync(new URL("./components/taskdesk-conversation.tsx", import.meta.url), "utf8")
const nativeSessions = readFileSync(new URL("./components/universal-workspace.tsx", import.meta.url), "utf8")
const taskClient = readFileSync(new URL("./taskClient.ts", import.meta.url), "utf8")

test("shared conversation owns transcript ordering and the composer", () => {
  assert.match(component, /messages\.map\(\(message\) =>/)
  assert.match(component, /<TaskDeskMessageContent message=\{message\}/)
  assert.match(component, /value=\{draft\}/)
  assert.match(component, /onDraftChange\(event\.target\.value\)/)
  assert.match(component, /if \(event\.key !== "Enter"\) return/)
  assert.match(component, /if \(!event\.ctrlKey && !event\.metaKey\) return/)
  assert.match(component, /else if \(event\.shiftKey\)/)
  assert.match(component, /void onSend\(\)/)
})

test("native Sessions consume the shared conversation surface", () => {
  assert.match(nativeSessions, /import \{ TaskDeskConversation \} from "\.\/taskdesk-conversation"/)
  assert.match(nativeSessions, /<TaskDeskConversation/)
  assert.match(nativeSessions, /messages=\{detail\.messages\}/)
  assert.match(nativeSessions, /onLoadOlder=\{loadOlderMessages\}/)
  assert.match(nativeSessions, /draft=\{composer\}/)
  assert.match(nativeSessions, /onSend=\{sendPrompt\}/)
  assert.match(nativeSessions, /waiting=\{sessionWaiting\}/)
  assert.match(nativeSessions, /renderMessage=\{\(message\) =>/)
})

test("composer keystrokes do not walk or rerender the long transcript", () => {
  assert.match(component, /const MessageBubble = memo\(function MessageBubble/)
  assert.match(component, /const ConversationTranscript = memo\(function ConversationTranscript/)
  assert.match(component, /function transcriptPropsEqual/)
  assert.match(component, /previous\.messages === next\.messages/)
  assert.doesNotMatch(component.match(/function transcriptPropsEqual[\s\S]*?\n\}/)?.[0] || "", /draft/)
  assert.match(component, /<ConversationTranscript[\s\S]*?messages=\{messages\}/)
  assert.match(nativeSessions, /const MessageBubble = memo\(function MessageBubble/)
})

test("shared conversation owns paging and scroll preservation", () => {
  assert.match(component, /hasMore/)
  assert.match(component, /onLoadOlder/)
  // The checkpoint intentionally reveals prepended history from the top-relative position. An older
  // regression still required the superseded height-compensation algorithm even though the frozen
  // checkpoint's companion test explicitly forbids `previousHeight`.
  assert.match(component, /previousTop/)
  assert.match(component, /preservingOlderRef/)
  assert.match(component, /current\.scrollTop = Math\.max\(0, Math\.min\(previousTop/)
  assert.doesNotMatch(component, /previousHeight/)
  assert.match(component, /NEAR_BOTTOM_PX/)
  assert.match(component, /nearBottomRef/)
})

test("long conversations retain v2-style jump-to-top and jump-to-bottom affordances", () => {
  assert.match(component, /JUMP_AFFORDANCE_MIN_RANGE/)
  assert.match(component, /function jumpAffordancesFor/)
  assert.match(component, /JumpToTopIcon/)
  assert.match(component, /JumpToBottomIcon/)
  assert.match(component, /aria-label="Jump to top"/)
  assert.match(component, /aria-label="Jump to bottom"/)
  assert.match(component, /scrollTo\(\{ top: 0, behavior: "smooth" \}\)/)
  assert.match(component, /scrollTo\(\{ top: current\.scrollHeight, behavior: "smooth" \}\)/)
})

test("shared conversation owns working state presentation", () => {
  // The wait is one identity row - the agent's avatar and the line beside it - and never a second
  // avatar or a second name for the same turn.
  assert.match(component, /uw-message uw-message-agent uw-message-pending/)
  assert.match(component, /uw-message-working/)
  assert.doesNotMatch(component, /uw-session-typing/)
  assert.match(component, /waiting/)
  assert.match(component, /sending/)
  assert.match(component, /Loading conversation/)
})

test("conversation mutations reconcile ambiguous transport outcomes instead of blindly resending", () => {
  assert.match(taskClient, /clientRequestId/)
  assert.match(taskClient, /PENDING_CONTINUE_STORAGE_PREFIX/)
  assert.match(taskClient, /hasClientRequest\(latest, pending\.clientRequestId\)/)
  assert.match(taskClient, /\/v1\/work-threads\/\$\{encodeURIComponent\(taskId\)\}/)
  assert.match(taskClient, /if \(!isActiveTask\(latest\)\) return latest/)
})
