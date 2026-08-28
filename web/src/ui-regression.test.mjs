import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8')
const main = read('./main.tsx')
const shell = read('./components/standalone-universal-workspace.tsx')
const home = read('./components/native-session-home.tsx')
const observer = read('./components/native-session-observer.tsx')
const chat = read('./components/work-thread-conversation.tsx')
const shared = read('./components/taskdesk-conversation.tsx')
const messageContent = read('./components/taskdesk-message-content.tsx')
const api = read('./api.ts')

assert.match(api, /const body = await response\.text\(\)/, 'failed HTTP responses must consume their body only once')
assert.match(api, /typeof value\.error === "string" \? value\.error : undefined/, 'bridge error JSON must be unwrapped')
assert.equal(api.includes('const text = await response.text()'), false, 'error handling must not read the response body twice')

assert.match(main, /<StandaloneUniversalWorkspace/, 'the product must boot directly into Session-first')
assert.match(shell, /<NativeSessionHome/, 'the Session rail must be native discovery')
assert.match(shell, /<NativeSessionObserver/, 'the detail pane must open the native Session surface')
assert.match(home, /hr-native-machine-group/, 'Session navigation must preserve machine grouping')
assert.match(home, /hr-native-project-group/, 'Session navigation must preserve Project grouping')
assert.match(home, /hr-native-session-row/, 'Session navigation must render native Session rows')

assert.match(observer, /<WorkThreadConversation/, 'native Session detail must reuse the mature v3 controller')
assert.match(chat, /<TaskDeskConversation/, 'the mature controller must own the shared transcript/composer')
assert.match(chat, /buildConversationTimeline/, 'the mature timeline projection must remain in one place')
assert.match(chat, /controller\.loadMessagePage/, 'the mature controller must own bounded transcript paging through its explicit I/O boundary')
assert.match(chat, /startTaskDeskSessionLiveRefresh/, 'the mature controller must own live refresh')
assert.match(chat, /controller\.continueConversation/, 'the native adapter must continue through the proven controller boundary')
assert.match(chat, /controller\.stopConversation/, 'Stop must keep the proven controller boundary')

assert.match(shared, /const ConversationTranscript = memo/, 'composer typing must not rerender the full transcript')
assert.match(shared, /NEAR_BOTTOM_PX = 96/, 'the shared transcript must keep explicit near-bottom behavior')
assert.match(shared, /JumpToTopIcon/, 'long Sessions keep jump-to-top')
assert.match(shared, /JumpToBottomIcon/, 'long Sessions keep jump-to-bottom')
assert.match(shared, /onLoadOlder/, 'the renderer must expose older-history loading')
assert.match(messageContent, /messageErrorText/, 'native turn errors must remain visible')
assert.match(messageContent, /hasTerminalAssistantText/, 'assistant terminal state must stay native-message driven')

console.log('Session-first UI regression tests passed')
