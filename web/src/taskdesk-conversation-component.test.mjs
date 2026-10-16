import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const component = readFileSync(new URL("./components/taskdesk-conversation.tsx", import.meta.url), "utf8")
const controller = readFileSync(new URL("./components/work-thread-conversation.tsx", import.meta.url), "utf8")
const observer = readFileSync(new URL("./components/native-session-observer.tsx", import.meta.url), "utf8")
const taskClient = readFileSync(new URL("./taskClient.ts", import.meta.url), "utf8")
const liveRefresh = readFileSync(new URL("./taskdesk-session-live-refresh.ts", import.meta.url), "utf8")

test("shared conversation owns transcript ordering and the composer", () => {
  assert.match(component, /messages\.map\(\(message\) =>/)
  assert.match(component, /<TaskDeskMessageContent message=\{message\}/)
  assert.match(component, /value=\{draft\}/)
  assert.match(component, /onDraftChange\(event\.target\.value\)/)
  assert.match(component, /void onSend\(\)/)
})

test("native Sessions consume the shared conversation through the mature controller", () => {
  assert.match(observer, /<WorkThreadConversation/)
  assert.match(controller, /<TaskDeskConversation/)
  assert.match(controller, /const presentedTimeline = useMemo/)
  assert.match(controller, /messages=\{presentedTimeline\}/)
  assert.match(controller, /onLoadOlder=\{loadOlder\}/)
  assert.match(controller, /const visibleDraft = uncertainDeliverySettled/)
  assert.match(controller, /draft=\{visibleDraft\}/)
  assert.match(controller, /onSend=\{send\}/)
})

test("composer keystrokes do not walk or rerender the long transcript", () => {
  assert.match(component, /const ConversationTranscript = memo/)
  assert.match(component, /function transcriptPropsEqual/)
  assert.match(component, /previous\.messages === next\.messages/)
  assert.doesNotMatch(component.match(/function transcriptPropsEqual[\s\S]*?\n\}/)?.[0] || "", /draft/)
})

test("shared conversation owns paging and scroll preservation", () => {
  assert.match(component, /hasMore/)
  assert.match(component, /onLoadOlder/)
  assert.match(component, /previousTop/)
  assert.match(component, /Math\.min\(previousTop, current\.scrollHeight - current\.clientHeight\)/)
  assert.match(component, /NEAR_BOTTOM_PX/)
  assert.match(component, /nearBottomRef/)
})

test("a failed initial transcript read cannot masquerade as an empty conversation", () => {
  assert.match(controller, /const \[transcriptError, setTranscriptError\] = useState/)
  assert.match(controller, /catch \(reason\)[\s\S]*setTranscriptError\(firstFailure\)/)
  assert.match(controller, /transcriptError=\{transcriptError \|\| undefined\}/)
  assert.match(component, /className="uw-empty-panel uw-transcript-error" role="alert"/)
  assert.match(component, />Session history could not be loaded\.</)
  assert.match(component, /messages\.length === 0 && !waiting && !transcriptError/)
})

test("conversation mutations reconcile ambiguous outcomes instead of blindly resending", () => {
  assert.match(taskClient, /clientRequestId/)
  assert.match(taskClient, /PENDING_CONTINUE_STORAGE_PREFIX/)
  assert.match(taskClient, /hasClientRequest\(latest, pending\.clientRequestId\)/)
})


test("an early empty assistant envelope stays behind the shared getting-started indicator", () => {
  assert.match(controller, /assistantMessageHasSignal/)
  assert.match(controller, /if \(message\.info\.error\) return true/)
  assert.match(controller, /const \[replyPending, setReplyPending\] = useState\(false\)/)
  assert.match(controller, /setSending\(true\)[\s\S]*setReplyPending\(true\)/)
  assert.match(controller, /\(awaitingReplyTurnID && currentTurnHasAssistantSignal\)[\s\S]*setReplyPending\(false\)/)
  assert.match(controller, /const replyTurnID = awaitingReplyTurnID \|\| conversation\.currentTurn\?\.id \|\| null/)
  assert.match(controller, /const presentedTimeline = useMemo/)
  assert.match(controller, /message\.info\.role === "assistant"[\s\S]*!assistantMessageHasSignal\(message\)/)
  assert.match(controller, /const preparingReply = replyPending \|\| sending/)
  assert.match(controller, /sending=\{preparingReply\}/)
  assert.doesNotMatch(controller.match(/useEffect\(\(\) => \{[\s\S]*?if \(!awaitingReplyTurnID\) return[\s\S]*?\}, \[awaitingReplyTurnID[\s\S]*?\]\)/)?.[0] || "", /conversation\.currentTurn\?\.id !== awaitingReplyTurnID/)
  assert.match(controller, /liveTurnID = \(working \|\| replySettling\)[\s\S]*currentTurnHasAssistantSignal/)
  assert.match(component, /className="uw-message uw-message-agent uw-message-pending"/)
  assert.match(component, /className="bui-typing"/)
})


test("machine reconnect pauses mutations and resumes reconciliation in place", () => {
  assert.match(controller, /interactionEnabled = true/)
  assert.match(controller, /if \(!interactionEnabled\) \{[\s\S]*setModelsLoading\(false\)/)
  assert.match(controller, /sendInFlightRef\.current[\s\S]*\|\| !interactionEnabled[\s\S]*\|\| modelBootstrapBlocked/)
  assert.match(controller, /sendDisabled=\{!interactionEnabled \|\| working/)
  assert.match(controller, /if \(!wasEnabled && interactionEnabled\) \{[\s\S]*void reconcile\(\)/)
  assert.match(controller, /onConnectionIssueRef\.current\?\.\(\)/)
})


test("transcript-proven ambiguous delivery settles the restored draft without a duplicate Send", () => {
  assert.match(controller, /uncertainDelivery/)
  assert.match(controller, /const uncertainDeliverySettled = Boolean/)
  assert.match(controller, /conversation\.currentTurn\.id !== uncertainDelivery\.priorTurnID/)
  assert.match(controller, /conversation\.currentTurn\.prompt\?\.trim\(\) === uncertainDelivery\.text/)
  assert.match(controller, /const visibleDraft = uncertainDeliverySettled/)
  assert.match(controller, /draft=\{visibleDraft\}/)
  assert.match(controller, /current\.trim\(\) !== recovered\.text/)
  assert.match(controller, /setUncertainDelivery\(null\)/)
})

test("accepted native replies keep settling after an early idle edge", () => {
  assert.match(controller, /REPLY_SETTLE_RECONCILE_MS = 1_500/)
  assert.match(controller, /REPLY_SETTLE_IDLE_GRACE_MS = 20_000/)
  assert.match(controller, /setAwaitingReplyTurnID\(next\.currentTurn\?\.id \?\? null\)/)
  assert.match(controller, /const replySettling = Boolean/)
  assert.match(controller, /replySettling \? REPLY_SETTLE_RECONCILE_MS/)
  assert.match(controller, /waiting=\{working \|\| replySettling\}/)
})

test("selected ACP lifecycle edges always re-read the mounted transcript", () => {
  assert.match(liveRefresh, /event\.type === "session\.updated"[\s\S]*selectedEvent[\s\S]*throttle\("message", 120, onMessage\)[\s\S]*settleAfterLifecycle\(\)/)
})

test("a live turn keeps its tail halfway up the transcript, after a Send or on opening", () => {
  assert.match(component, /const LIVE_TAIL_POSITION = 0\.5/)
  assert.match(component, /function sizeLiveRoom\(transcript: HTMLElement, spacer: HTMLElement\)/)
  assert.match(component, /className="uw-transcript-reply-room" ref=\{spacerRef\}/)
  // Sending and an already-working Session both open the room; the user scrolling up still wins.
  assert.match(component, /liveRoomRef\.current \|\| !\(sending \|\| waiting\)\) return\s+openLiveRoom\(transcript\)\s+\}, \[loading, ready, sending, waiting\]\)/)
  assert.match(component, /if \(event\.deltaY < 0\) nearBottomRef\.current = false/)
  assert.doesNotMatch(component, /sizeSendAnchor|pinnedRef/)
})

test("a wide Session pane shows the outcome as a toolbar chip, a phone keeps its own row", () => {
  assert.match(controller, /toolbarAccessory\?: ReactNode/)
  assert.match(controller, /\{toolbarAccessory\}\s+<ConversationStatePill/)
  assert.match(observer, /\{compactLayout \? outcomePanel : null\}/)
  assert.match(observer, /toolbarAccessory=\{compactLayout \? undefined : outcomePanel\}/)
})
