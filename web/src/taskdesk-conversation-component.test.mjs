import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const component = readFileSync(new URL("./components/taskdesk-conversation.tsx", import.meta.url), "utf8")
const nativeSessions = readFileSync(new URL("./components/universal-workspace.tsx", import.meta.url), "utf8")

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
  assert.match(component, /previousHeight/)
  assert.match(component, /current\.scrollHeight - previousHeight/)
  assert.match(component, /NEAR_BOTTOM_PX/)
  assert.match(component, /nearBottomRef/)
})

test("shared conversation owns working state presentation", () => {
  assert.match(component, /uw-session-typing/)
  assert.match(component, /waiting/)
  assert.match(component, /sending/)
  assert.match(component, /Loading conversation/)
})