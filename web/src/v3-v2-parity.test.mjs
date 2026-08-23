/**
 * What 3.0 kept from the 2.x shell, and what it quietly dropped.
 *
 * `App.tsx` and its components (`session-composer`, `session-list`, `panels`, `shell`) are the 2.x
 * tree. Nothing in the running app imports them any more, so a capability that lived only there
 * disappeared from the product without any single change ever looking like a removal. This file is
 * the audit made executable: each restored capability gets a guard, so it cannot be lost a second
 * time by the same route.
 *
 * Still outstanding, deliberately not asserted here because asserting a gap would lock it in:
 * prompt image attachments. `attachments.ts` and the bridge path behind it are both intact — the
 * bridge validates `file` parts, forwards them as ACP image blocks and reports the capability from
 * the live handshake — but 3.0 routes conversation turns through the task pipeline
 * (`/v1/tasks/:id/continue`), which carries `prompt` as a bare string. Restoring it needs the run
 * options, the run store and all three transports in `task-launcher.js` to carry attachments, so it
 * is a feature change across client and bridge rather than a UI fix.
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
const conversationCss = read("taskdesk-conversation.css")
const mobileParity = read("v3-mobile-product-parity.css")
const clipboard = read("clipboard.ts")

test("a conversation can be copied out of, as it could in 2.x", () => {
  // 3.0 shipped with no copy affordance anywhere: `clipboard.ts` existed but only the retired shell
  // called it. For an agent that answers with commands and patches, this is the most common thing to
  // want from a reply.
  assert.match(content, /import \{ copyToClipboard \} from "\.\.\/clipboard"/)
  assert.match(content, /function CopyButton\(\{ text, label \}/)

  // All three places worth copying from: the whole message, a fenced code block, and tool output.
  assert.match(content, /<CopyButton text=\{text\} label="Copy message" \/>/)
  assert.match(content, /<CopyButton text=\{hastText\(node\)\} label="Copy code" \/>/)
  assert.match(content, /<CopyButton text=\{output\} label="Copy output" \/>/)
})

test("the copy carries the source text, not the rendered text", () => {
  // Reading React children back would yield elements by this point, and for tool output the on-screen
  // body is truncated — a stack trace clipped at 4000 characters is the useless half.
  assert.match(content, /function hastText\(node: unknown\): string/)
  assert.match(content, /if \(element\.type === "text"\) return element\.value \?\? ""/)
  const toolCopy = content.match(/<CopyButton text=\{output\}[^/]*\/>/)[0]
  assert.doesNotMatch(toolCopy, /slice/)
})

test("copy survives the plain-http LAN this app is also served over", () => {
  // `navigator.clipboard` is absent rather than refused on a non-secure origin, so reaching through
  // it throws before there is a promise to catch. The helper already handled this; the point of the
  // guard is that the new callers go through the helper instead of the API directly.
  assert.match(clipboard, /document\.execCommand\("copy"\)/)
  // Usage, not the word: the component's own comment names the API it deliberately avoids calling.
  assert.doesNotMatch(content, /navigator\.clipboard\??\.\s*writeText/)
})

test("the markdown renderer keeps one component table across renders", () => {
  // Rebuilding it per render would remount every code block on every streamed token.
  assert.match(content, /^const MARKDOWN_COMPONENTS: Components = \{/m)
  assert.match(content, /components=\{MARKDOWN_COMPONENTS\}/)
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
