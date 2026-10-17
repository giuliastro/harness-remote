/**
 * What 3.0 kept from the 2.x shell, and what it quietly dropped.
 *
 * `App.tsx` and its components (`session-composer`, `session-list`, `panels`, `shell`) are the 2.x
 * tree. Nothing in the running app imports them any more, so a capability that lived only there
 * disappeared from the product without any single change ever looking like a removal. This file is
 * the audit made executable: each restored capability gets a guard, so it cannot be lost a second
 * time by the same route.
 *
 * Prompt image attachments are restored on the active Session-first path. The live harness
 * capability gates the paperclip, the shared v3 composer prepares the same bounded images as 2.x,
 * and the native Session operation carries them through the daemon without routing them through the
 * retired Task launch pipeline.
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
/** Normalised: this checkout may be CRLF while the index is LF. */
const read = (name) => readFileSync(path.join(here, name), "utf8").replace(/\r\n/g, "\n")

const content = read("components/taskdesk-message-content.tsx")
const markdown = read("components/message-markdown.tsx")
const timeline = read("components/activity-timeline.tsx")
const conversationCss = read("taskdesk-conversation.css")
const mobileParity = read("v3-mobile-product-parity.css")
const clipboard = read("clipboard.ts")
const conversation = read("components/taskdesk-conversation.tsx")
const messageContent = read("components/taskdesk-message-content.tsx")
const workThread = read("components/work-thread-conversation.tsx")
const nativePrompt = read("native-session-prompt.ts")
const nativeObserver = read("components/native-session-observer.tsx")
const routeCapabilities = read("native-session-route-capabilities.ts")

test("a conversation can be copied out of, as it could in 2.x", () => {
  // 3.0 shipped with no copy affordance anywhere: `clipboard.ts` existed but only the retired shell
  // called it. For an agent that answers with commands and patches, this is the most common thing to
  // want from a reply.
  assert.match(markdown, /import \{ copyToClipboard \} from "\.\.\/clipboard"/)
  assert.match(markdown, /function CopyButton\(\{ text, label \}/)

  // All three places worth copying from: the whole message, a fenced code block, and tool output.
  assert.match(content, /<CopyButton text=\{text\} label="Copy message" \/>/)
  assert.match(markdown, /<CopyButton text=\{hastText\(node\)\} label="Copy code" \/>/)
  assert.match(timeline, /<CopyButton text=\{output\} label="Copy output" \/>/)
})

test("the copy carries the source text, not the rendered text", () => {
  // Reading React children back would yield elements by this point, and for tool output the on-screen
  // body is truncated — a stack trace clipped at 4000 characters is the useless half.
  assert.match(markdown, /function hastText\(node: unknown\): string/)
  assert.match(markdown, /if \(element\.type === "text"\) return element\.value \?\? ""/)
  const toolCopy = timeline.match(/<CopyButton text=\{output\}[^/]*\/>/)[0]
  assert.doesNotMatch(toolCopy, /slice/)
})

test("copy survives the plain-http LAN this app is also served over", () => {
  // `navigator.clipboard` is absent rather than refused on a non-secure origin, so reaching through
  // it throws before there is a promise to catch. The helper already handled this; the point of the
  // guard is that the new callers go through the helper instead of the API directly.
  assert.match(clipboard, /document\.execCommand\("copy"\)/)
  // Usage, not the word: the component's own comment names the API it deliberately avoids calling.
  assert.doesNotMatch(markdown, /navigator\.clipboard\??\.\s*writeText/)
})

test("the markdown renderer keeps one component table across renders", () => {
  // Rebuilding it per render would remount every code block on every streamed token.
  assert.match(markdown, /^export const MARKDOWN_COMPONENTS: Components = \{/m)
  assert.match(markdown, /components=\{MARKDOWN_COMPONENTS\}/)
})

test("copy is reachable with a thumb, not only a mouse", () => {
  const desktop = conversationCss.match(/\.tdw-work-thread-conversation \.uw-copy-button \{[^}]*\}/)
  assert.ok(desktop, "the copy button must be sized explicitly")
  assert.ok(Number(desktop[0].match(/min-height: (\d+)px/)[1]) >= 28)

  const touch = mobileParity.match(/\.uw-copy-button \{[^}]*\}/)
  assert.ok(touch, "mobile must raise the target")
  assert.ok(Number(touch[0].match(/min-height: (\d+)px/)[1]) >= 40, "a touch target below 40px is too small")
})

test("code blocks stay outside the reading measure", () => {
  // The copy button is positioned against a wrapper. That wrapper must not inherit the prose cap, or
  // restoring copy would silently narrow every code block in the transcript.
  assert.match(conversationCss, /\.tdw-work-thread-conversation \.uw-code-block \{[^}]*position: relative;/)
  const measured = conversationCss.match(/\.tdw-work-thread-conversation \.uw-markdown > p,[\s\S]*?\n\}/)[0]
  assert.doesNotMatch(measured, /uw-code-block|> pre|> table/)
})

test("Session-first restores capability-gated image attachments without reviving the 2.x shell", () => {
  assert.match(conversation, /fileToAttachment/)
  assert.match(conversation, /accept="image\/\*"/)
  assert.match(conversation, /attachmentsSupported \? \(/)
  assert.match(workThread, /attachments: promptAttachments/)
  assert.match(nativePrompt, /attachments: AttachmentPart\[\] = \[\]/)
  assert.match(nativePrompt, /attachmentKeys/)
  assert.match(nativeObserver, /api\.capabilities\(target\.config\)/)
  // Fetching the capability is not the same as delivering it. The composer reads
  // `attachments` off the agent it is about to send to, and that agent comes from the routed
  // machine list, whose entries are the daemon's static `profile.capabilities` table. Without
  // this merge the live ACP answer never reaches the gate and the paperclip stays hidden on
  // every harness, image-capable or not.
  assert.match(nativeObserver, /routeCurrentNativeSessionAgents\(available, target\.agentID, agent, attachmentsSupported\)/)
  assert.match(routeCapabilities, /capabilities: \{ \.\.\.candidate\.capabilities, attachments: attachmentsSupported \}/)
  assert.doesNotMatch(nativeObserver, /SessionComposer/)
})

test("v3 renders todowrite tool input as the structured checklist available in v2.11", () => {
  assert.match(timeline, /function parseTodos\(value: unknown\)/)
  assert.match(timeline, /item\.status === "completed" \? "✓" : item\.status === "in_progress" \? "◐" : "○"/)
  assert.match(timeline, /<TodoListView items=\{todos\} \/>/)
  assert.doesNotMatch(messageContent, /SessionComposer/)
})
