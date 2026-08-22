import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("Session composer typing is isolated from the long transcript", () => {
  const workspace = readFileSync(new URL("./components/universal-workspace.tsx", import.meta.url), "utf8")
  const conversation = readFileSync(new URL("./components/taskdesk-conversation.tsx", import.meta.url), "utf8")

  assert.match(workspace, /const MessageBubble = memo\(function MessageBubble/)
  assert.match(workspace, /<TaskDeskConversation[\s\S]*?draft=\{composer\}[\s\S]*?onDraftChange=\{setComposer\}/)
  assert.match(conversation, /const ConversationTranscript = memo\(function ConversationTranscript/)
  assert.match(conversation, /function transcriptPropsEqual/)
  assert.match(conversation, /previous\.messages === next\.messages/)
  const comparator = conversation.match(/function transcriptPropsEqual[\s\S]*?\n\}/)?.[0] || ""
  assert.doesNotMatch(comparator, /draft/)
  assert.match(conversation, /<ConversationTranscript[\s\S]*?messages=\{messages\}/)
  assert.match(conversation, /value=\{draft\}[\s\S]*?onChange=\{\(event\) => onDraftChange\(event\.target\.value\)\}/)
})