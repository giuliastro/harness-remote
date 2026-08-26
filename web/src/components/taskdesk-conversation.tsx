import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { ATTACHMENT_MAX_COUNT, fileToAttachment, type AttachmentPart } from "../attachments"
import type { MessageEnvelope } from "../types"
import { ChatIcon, CloseIcon, JumpToBottomIcon, JumpToTopIcon, LoadingIcon, PaperclipIcon, StopCircleIcon } from "../Icons"
import { useTranslator } from "../useTranslator"
import "../taskdesk-conversation.css"
import "../taskdesk-conversation-fixes.css"
import { TaskDeskMessageContent } from "./taskdesk-message-content"

/** How much of the viewport shows newly loaded older content, the rest being where you were. */
const OLDER_JUNCTION_OVERLAP = 0.85

const NEAR_BOTTOM_PX = 96
const COMPOSER_MAX_HEIGHT_PX = 180
const JUMP_AFFORDANCE_MAX_THRESHOLD = 320
const JUMP_AFFORDANCE_MIN_RANGE = 240

type Props = {
  messages: MessageEnvelope[]
  agentLabel: string
  agentBackend?: string
  loading?: boolean
  waiting?: boolean
  ready?: boolean
  hasMore?: boolean
  loadingOlder?: boolean
  onLoadOlder?: () => Promise<void> | void
  draft: string
  onDraftChange: (value: string) => void
  onSend: () => Promise<void> | void
  sending?: boolean
  sendDisabled?: boolean
  onStop?: () => Promise<void> | void
  stopping?: boolean
  /** Images staged for the next prompt. Absent means this surface does not offer attachments. */
  attachments?: AttachmentPart[]
  onAttachmentsChange?: (attachments: AttachmentPart[]) => void
  attachmentsSupported?: boolean
  workingLabel?: string
  showWaitingIndicator?: boolean
  placeholder?: string
  emptyText?: string
  directory?: string
  footerHint?: string
  renderMessage?: (message: MessageEnvelope) => ReactNode
}

type TranscriptProps = Pick<Props,
  "messages" | "agentLabel" | "agentBackend" | "loading" | "waiting" | "ready" | "hasMore" |
  "loadingOlder" | "onLoadOlder" | "sending" | "workingLabel" | "showWaitingIndicator" | "emptyText" | "renderMessage"
>

type JumpAffordances = { top: boolean; bottom: boolean }

function formatClock(timestamp: number): string {
  if (!timestamp) return ""
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(timestamp)
}

function hasTouchFirstPointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true
}

function jumpAffordancesFor(element: HTMLElement): JumpAffordances {
  const fromTop = Math.max(0, element.scrollTop)
  const fromBottom = Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight)
  const range = fromTop + fromBottom
  if (range < JUMP_AFFORDANCE_MIN_RANGE) return { top: false, bottom: false }
  const threshold = Math.min(JUMP_AFFORDANCE_MAX_THRESHOLD, range * 0.25)
  return { top: fromTop > threshold, bottom: fromBottom > threshold }
}

const MessageBubble = memo(function MessageBubble({ message, agentLabel }: { message: MessageEnvelope; agentLabel: string }) {
  const isUser = message.info.role === "user"
  return (
    <article className={`uw-message ${isUser ? "uw-message-user" : "uw-message-agent"}`}>
      <div className={`uw-avatar ${isUser ? "uw-avatar-user" : "uw-avatar-agent"}`} aria-hidden="true">
        {isUser ? "You" : agentLabel.slice(0, 2).toUpperCase()}
      </div>
      <div className="uw-message-body">
        <header>
          <strong>{isUser ? "You" : agentLabel}</strong>
          <time>{formatClock(message.info.time.created)}</time>
        </header>
        <TaskDeskMessageContent message={message} />
      </div>
    </article>
  )
})

const ThinkingIndicator = memo(function ThinkingIndicator({ agentLabel, workingLabel }: { agentLabel: string; workingLabel?: string }) {
  const t = useTranslator()
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const started = Date.now()
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1_000)), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className="uw-session-typing" role="status" aria-live="polite" aria-label={t("sf.waitingResponse", { agent: agentLabel })}>
      <span className="uw-thinking-orb" aria-hidden="true"><i /><i /><i /></span>
      <span className="uw-thinking-copy">
        <strong>{workingLabel || t("sf.agentIsWorking", { agent: agentLabel })}</strong>
        <small>{elapsed < 2 ? "Starting…" : `${elapsed}s`}</small>
      </span>
    </div>
  )
})

function transcriptPropsEqual(previous: TranscriptProps, next: TranscriptProps): boolean {
  return previous.messages === next.messages
    && previous.agentLabel === next.agentLabel
    && previous.agentBackend === next.agentBackend
    && previous.loading === next.loading
    && previous.waiting === next.waiting
    && previous.ready === next.ready
    && previous.hasMore === next.hasMore
    && previous.loadingOlder === next.loadingOlder
    && previous.sending === next.sending
    && previous.workingLabel === next.workingLabel
    && previous.showWaitingIndicator === next.showWaitingIndicator
    && previous.emptyText === next.emptyText
}

/**
 * The transcript is deliberately memoized separately from the composer. Parent-owned draft state
 * changes on every keystroke, but a long conversation must not even walk its message array unless
 * transcript data or transcript state changed. Callback identities are intentionally ignored by the
 * comparator: a render that matters to the transcript also changes messages, agent identity or one
 * of the explicit transcript state props.
 */
const ConversationTranscript = memo(function ConversationTranscript({
  messages,
  agentLabel,
  loading = false,
  waiting = false,
  ready = true,
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
  sending = false,
  workingLabel,
  showWaitingIndicator = true,
  emptyText = "This conversation has no messages yet.",
  renderMessage
}: TranscriptProps) {
  const t = useTranslator()
  const transcriptRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const preservingOlderRef = useRef(false)
  const loadOlderRef = useRef(onLoadOlder)
  const followFrameRef = useRef<number | undefined>(undefined)
  const scrollFrameRef = useRef<number | undefined>(undefined)
  const previousSendingRef = useRef(false)
  /** Set while an older page is in flight, read by the layout effect that repositions the view. */
  const pendingOlderRef = useRef<{ previousHeight: number; previousTop: number } | null>(null)
  const [jumpAffordances, setJumpAffordances] = useState<JumpAffordances>({ top: false, bottom: false })
  loadOlderRef.current = onLoadOlder

  function refreshJumpAffordances(element: HTMLElement) {
    const next = jumpAffordancesFor(element)
    setJumpAffordances((current) => current.top === next.top && current.bottom === next.bottom ? current : next)
  }

  useEffect(() => () => {
    if (followFrameRef.current !== undefined) window.cancelAnimationFrame(followFrameRef.current)
    if (scrollFrameRef.current !== undefined) window.cancelAnimationFrame(scrollFrameRef.current)
  }, [])

  useEffect(() => {
    const transcript = transcriptRef.current
    const startedSend = sending && !previousSendingRef.current
    previousSendingRef.current = sending
    if (!transcript || loading || !ready || preservingOlderRef.current) return

    // A deliberate send re-enters follow mode. After that, the user's scroll position wins. Status
    // changes such as Working -> Needs attention never move the transcript by themselves.
    if (startedSend) nearBottomRef.current = true
    if (!nearBottomRef.current || followFrameRef.current !== undefined) return
    followFrameRef.current = window.requestAnimationFrame(() => {
      followFrameRef.current = undefined
      const current = transcriptRef.current
      if (!current || preservingOlderRef.current || !nearBottomRef.current) return
      current.scrollTop = current.scrollHeight
      refreshJumpAffordances(current)
    })
  }, [messages, loading, ready, sending])

  // Runs after the commit that rendered the older page, so `scrollHeight` is the real one.
  useLayoutEffect(() => {
    const pending = pendingOlderRef.current
    const element = transcriptRef.current
    if (!pending || !element) return
    const grown = element.scrollHeight - pending.previousHeight
    // A commit that has not rendered the page yet reports no growth; wait for the one that does.
    if (grown <= 0) return
    pendingOlderRef.current = null
    // Preserving the reading position exactly is right for infinite scroll and wrong for a button:
    // it moves the viewport down by the whole height of what arrived, leaving the new content above
    // the fold. Land on the junction instead - the last screenful of what was just loaded, ending
    // where the reader already was - so "did it load?" is answered on screen.
    const junction = pending.previousTop + grown
    element.scrollTop = Math.max(0, junction - element.clientHeight * OLDER_JUNCTION_OVERLAP)
    // Reading older history is not following the tail. Without this the follow-to-bottom pass runs
    // in the same commit - passive effects come after layout effects - and takes the transcript
    // straight to the end, which is the whole reason the button looked like it only scrolled.
    nearBottomRef.current = false
    refreshJumpAffordances(element)
    preservingOlderRef.current = false
  }, [messages])

  // Content can become scrollable without a scroll event (initial load, tool expansion, streaming).
  // Refresh on transcript-state changes so the buttons never wait for the user to move first.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const current = transcriptRef.current
      if (current) refreshJumpAffordances(current)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [messages, loading, ready, sending, waiting])

  async function loadOlder() {
    const requestOlder = loadOlderRef.current
    if (!requestOlder || !hasMore || loadingOlder) return
    const transcript = transcriptRef.current
    // Hand the measurements to the layout effect below rather than repositioning here. A
    // `requestAnimationFrame` after the await can run before React commits the new messages, so it
    // measures the pre-prepend height: with a short older page the arithmetic happened to land
    // somewhere sensible, and with a page taller than the viewport it saw no growth at all and let
    // the follow-to-bottom pass take the transcript to the end - which is why pressing the button
    // looked like it only scrolled the text down.
    pendingOlderRef.current = {
      previousHeight: transcript?.scrollHeight ?? 0,
      previousTop: transcript?.scrollTop ?? 0
    }
    preservingOlderRef.current = true
    try {
      await requestOlder()
    } catch (error) {
      pendingOlderRef.current = null
      preservingOlderRef.current = false
      throw error
    }
    // An older page that adds nothing renders no growth, so the layout effect never fires. Release
    // the guard rather than leaving follow-to-bottom disabled for the rest of the Session.
    window.setTimeout(() => {
      if (!pendingOlderRef.current) return
      pendingOlderRef.current = null
      preservingOlderRef.current = false
    }, 400)
  }

  function jumpToTop() {
    const current = transcriptRef.current
    if (!current) return
    nearBottomRef.current = false
    current.scrollTo({ top: 0, behavior: "smooth" })
  }

  function jumpToBottom() {
    const current = transcriptRef.current
    if (!current) return
    nearBottomRef.current = true
    current.scrollTo({ top: current.scrollHeight, behavior: "smooth" })
  }

  return (
    <div className="uw-transcript-shell">
      <div
        className="uw-transcript"
        role="log"
        aria-label={t("sf.conversationTranscript")}
        ref={transcriptRef}
        onWheel={(event) => {
          if (event.deltaY < 0) nearBottomRef.current = false
        }}
        onScroll={(event) => {
          const element = event.currentTarget
          if (scrollFrameRef.current !== undefined) return
          scrollFrameRef.current = window.requestAnimationFrame(() => {
            scrollFrameRef.current = undefined
            nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_BOTTOM_PX
            refreshJumpAffordances(element)
          })
        }}
      >
        {loading || !ready ? (
          <div className="uw-empty-panel"><LoadingIcon size={22} /><strong>{t("sf.loadingConversation")}</strong></div>
        ) : (
          <>
            {hasMore ? (
              <div className="uw-history-loader">
                <button type="button" className="uw-button uw-button-ghost" disabled={loadingOlder} onClick={() => void loadOlder()}>
                  {loadingOlder ? <LoadingIcon size={13} /> : null}
                  {loadingOlder ? t("sf.loadingOlder") : t("sf.loadOlder")}
                </button>
              </div>
            ) : null}
            {messages.length === 0 && !waiting ? (
              <div className="uw-empty-panel"><ChatIcon size={24} /><strong>{emptyText}</strong></div>
            ) : renderMessage
              ? messages.map((message) => renderMessage(message))
              : messages.map((message) => (
                  <MessageBubble key={message.info.id} message={message} agentLabel={agentLabel} />
                ))}
          </>
        )}
        {sending || (waiting && showWaitingIndicator) ? <ThinkingIndicator agentLabel={agentLabel} workingLabel={workingLabel} /> : null}
      </div>

      {jumpAffordances.top || jumpAffordances.bottom ? (
        <div className="uw-transcript-jumps" aria-label={t("sf.conversationNavigation")}>
          {jumpAffordances.top ? (
            <button type="button" className="uw-transcript-jump" onClick={jumpToTop} title={t("app.jumpToTop")} aria-label={t("app.jumpToTop")}>
              <JumpToTopIcon size={18} />
            </button>
          ) : null}
          {jumpAffordances.bottom ? (
            <button type="button" className="uw-transcript-jump" onClick={jumpToBottom} title={t("app.jumpToBottom")} aria-label={t("app.jumpToBottom")}>
              <JumpToBottomIcon size={18} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}, transcriptPropsEqual)

/**
 * The conversation surface is deliberately product-agnostic. A Native Session and a Task provide
 * the same ordered native transcript and callbacks; this component owns how that transcript is
 * displayed, paged, scrolled and continued so those two products cannot slowly diverge.
 */
export function TaskDeskConversation({
  messages,
  agentLabel,
  agentBackend,
  loading = false,
  waiting = false,
  ready = true,
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
  draft,
  onDraftChange,
  onSend,
  sending = false,
  sendDisabled = false,
  onStop,
  stopping = false,
  attachments = [],
  onAttachmentsChange,
  attachmentsSupported = false,
  workingLabel,
  showWaitingIndicator = true,
  placeholder,
  emptyText = "This conversation has no messages yet.",
  directory,
  footerHint,
  renderMessage
}: Props) {
  const t = useTranslator()
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)

  async function stageFiles(files: FileList | File[] | null) {
    if (!files || !onAttachmentsChange) return
    setAttachmentError(null)
    const room = ATTACHMENT_MAX_COUNT - attachments.length
    const chosen = [...files].slice(0, Math.max(0, room))
    if (chosen.length < [...files].length) {
      setAttachmentError(t("sf.attachmentLimit", { count: ATTACHMENT_MAX_COUNT }))
    }
    const staged: AttachmentPart[] = []
    for (const file of chosen) {
      try {
        staged.push(await fileToAttachment(file))
      } catch (reason) {
        // One rejected file must not discard the ones that converted: report it and keep the rest.
        setAttachmentError(reason instanceof Error ? reason.message : String(reason))
      }
    }
    if (staged.length) onAttachmentsChange([...attachments, ...staged])
  }
  const composerFrameRef = useRef<number | undefined>(undefined)
  const touchFirst = hasTouchFirstPointer()
  const canSend = Boolean((draft.trim() || attachments.length) && !sending && !waiting && !sendDisabled && ready)
  // A phone has no Ctrl or Cmd key, so telling a touch user to press Ctrl/Cmd+Enter named the one
  // way to send that they do not have. Enter inserts a newline there; the Send button is the action.
  const hint = footerHint ?? (touchFirst ? t("sf.ctrlEnterToSend") : t("sf.enterToSend"))

  useEffect(() => {
    if (composerFrameRef.current !== undefined) window.cancelAnimationFrame(composerFrameRef.current)
    composerFrameRef.current = window.requestAnimationFrame(() => {
      composerFrameRef.current = undefined
      const composer = composerRef.current
      if (!composer) return
      composer.style.height = "auto"
      composer.style.height = `${Math.min(COMPOSER_MAX_HEIGHT_PX, Math.max(66, composer.scrollHeight))}px`
    })
    return () => {
      if (composerFrameRef.current !== undefined) {
        window.cancelAnimationFrame(composerFrameRef.current)
        composerFrameRef.current = undefined
      }
    }
  }, [draft])

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter") return
    if (touchFirst) {
      if (!event.ctrlKey && !event.metaKey) return
    } else if (event.shiftKey) {
      return
    }
    event.preventDefault()
    if (canSend) void onSend()
  }

  return (
    <div className="uw-conversation-core">
      <ConversationTranscript
        messages={messages}
        agentLabel={agentLabel}
        agentBackend={agentBackend}
        loading={loading}
        waiting={waiting}
        ready={ready}
        hasMore={hasMore}
        loadingOlder={loadingOlder}
        onLoadOlder={onLoadOlder}
        sending={sending}
        workingLabel={workingLabel}
        showWaitingIndicator={showWaitingIndicator}
        emptyText={emptyText}
        renderMessage={renderMessage}
      />

      <div className="uw-composer-shell">
        {/* A placeholder is not a label: it disappears as soon as the field has content, which left
            the product's primary input unnamed for a screen reader.

            `enterKeyHint` labels the soft keyboard's action key. Enter inserts a newline on a touch
            device here, so promising "send" would name a behaviour that key does not have. */}
        <textarea
          ref={composerRef}
          onPaste={attachmentsSupported && onAttachmentsChange ? (event) => {
            const files = [...event.clipboardData.files]
            if (!files.length) return
            // A pasted screenshot must not also drop its filename into the prompt as text.
            event.preventDefault()
            void stageFiles(files)
          } : undefined}
          onDrop={attachmentsSupported && onAttachmentsChange ? (event) => {
            if (!event.dataTransfer.files.length) return
            event.preventDefault()
            void stageFiles(event.dataTransfer.files)
          } : undefined}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={onComposerKeyDown}
          placeholder={waiting ? `${agentLabel} is working…` : placeholder || `Continue with ${agentLabel}…`}
          rows={3}
          enterKeyHint={touchFirst ? "enter" : "send"}
          disabled={!ready}
          aria-label={`Message ${agentLabel}`}
          aria-describedby="uw-composer-hint"
        />
        {attachments.length ? (
          <ul className="uw-composer-attachments" aria-label={t("sf.attachedImages")}>
            {attachments.map((attachment, index) => (
              <li key={`${attachment.filename}:${index}`}>
                <img src={attachment.url} alt="" />
                <span title={attachment.filename}>{attachment.filename}</span>
                <button
                  type="button"
                  onClick={() => onAttachmentsChange?.(attachments.filter((_, at) => at !== index))}
                  aria-label={t("sf.removeAttachment", { name: attachment.filename })}
                >
                  <CloseIcon size={12} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {attachmentError ? <div className="uw-composer-attachment-error" role="alert">{attachmentError}</div> : null}
        <div className="uw-composer-footer">
          <span className="uw-composer-directory">{directory || ""}</span>
          <div>
            <small id="uw-composer-hint">{hint}</small>
            {attachmentsSupported && onAttachmentsChange ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  hidden
                  onChange={(event) => {
                    void stageFiles(event.target.files)
                    // Without this, choosing the same file twice in a row fires no change event.
                    event.target.value = ""
                  }}
                />
                <button
                  type="button"
                  className="uw-button uw-button-ghost uw-composer-attach"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!ready || attachments.length >= ATTACHMENT_MAX_COUNT}
                  aria-label={t("sf.attachImage")}
                  title={t("sf.attachImage")}
                >
                  <PaperclipIcon size={15} />
                </button>
              </>
            ) : null}
            {waiting && onStop ? (
              <button
                type="button"
                className="uw-button uw-button-danger"
                disabled={stopping}
                onClick={() => void onStop()}
                aria-label={stopping ? "Stopping" : "Stop"}
              >
                {stopping ? <LoadingIcon size={15} /> : <StopCircleIcon size={15} />}
                <span className="uw-button-label">{stopping ? "Stopping" : "Stop"}</span>
              </button>
            ) : (
              <button
                type="button"
                className="uw-button uw-button-primary"
                disabled={!canSend}
                onClick={() => void onSend()}
                aria-label={sending ? "Sending" : "Send"}
              >
                {sending ? <LoadingIcon size={15} /> : "↑"}
                <span className="uw-button-label">{sending ? "Sending" : "Send"}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
