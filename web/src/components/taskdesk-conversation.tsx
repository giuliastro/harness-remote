import { memo, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import type { MessageEnvelope } from "../types"
import { ChatIcon, LoadingIcon, StopCircleIcon } from "../Icons"
import "../taskdesk-conversation.css"
import "../taskdesk-conversation-fixes.css"
import { TaskDeskMessageContent } from "./taskdesk-message-content"

const NEAR_BOTTOM_PX = 96
const COMPOSER_MAX_HEIGHT_PX = 180

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

function formatClock(timestamp: number): string {
  if (!timestamp) return ""
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(timestamp)
}

function hasTouchFirstPointer(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true
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
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const started = Date.now()
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1_000)), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className="uw-session-typing" role="status" aria-live="polite" aria-label={`Waiting for ${agentLabel} response`}>
      <span className="uw-thinking-orb" aria-hidden="true"><i /><i /><i /></span>
      <span className="uw-thinking-copy">
        <strong>{workingLabel || `${agentLabel} is working`}</strong>
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
  const transcriptRef = useRef<HTMLDivElement>(null)
  const nearBottomRef = useRef(true)
  const preservingOlderRef = useRef(false)
  const loadOlderRef = useRef(onLoadOlder)
  const followFrameRef = useRef<number | undefined>(undefined)
  const scrollFrameRef = useRef<number | undefined>(undefined)
  const previousSendingRef = useRef(false)
  loadOlderRef.current = onLoadOlder

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
    })
  }, [messages, loading, ready, sending])

  async function loadOlder() {
    const requestOlder = loadOlderRef.current
    if (!requestOlder || !hasMore || loadingOlder) return
    const transcript = transcriptRef.current
    const previousHeight = transcript?.scrollHeight ?? 0
    const previousTop = transcript?.scrollTop ?? 0
    preservingOlderRef.current = true
    try {
      await requestOlder()
      window.requestAnimationFrame(() => {
        const current = transcriptRef.current
        if (current) current.scrollTop = previousTop + (current.scrollHeight - previousHeight)
        preservingOlderRef.current = false
      })
    } catch (error) {
      preservingOlderRef.current = false
      throw error
    }
  }

  return (
    <div
      className="uw-transcript"
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
        })
      }}
    >
      {loading || !ready ? (
        <div className="uw-empty-panel"><LoadingIcon size={22} /><strong>Loading conversation…</strong></div>
      ) : (
        <>
          {hasMore ? (
            <div className="uw-history-loader">
              <button type="button" className="uw-button uw-button-ghost" disabled={loadingOlder} onClick={() => void loadOlder()}>
                {loadingOlder ? <LoadingIcon size={15} /> : null}
                {loadingOlder ? "Loading older messages…" : "Load older messages"}
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
  workingLabel,
  showWaitingIndicator = true,
  placeholder,
  emptyText = "This conversation has no messages yet.",
  directory,
  footerHint,
  renderMessage
}: Props) {
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const composerFrameRef = useRef<number | undefined>(undefined)
  const touchFirst = hasTouchFirstPointer()
  const canSend = Boolean(draft.trim() && !sending && !waiting && !sendDisabled && ready)
  const hint = footerHint ?? (touchFirst ? "Ctrl/Cmd+Enter to send" : "Shift+Enter for newline")

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
        <textarea
          ref={composerRef}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={onComposerKeyDown}
          placeholder={waiting ? `${agentLabel} is working…` : placeholder || `Continue with ${agentLabel}…`}
          rows={3}
          disabled={!ready}
        />
        <div className="uw-composer-footer">
          <span className="uw-composer-directory">{directory || ""}</span>
          <div>
            <small>{hint}</small>
            {waiting && onStop ? (
              <button
                type="button"
                className="uw-button uw-button-danger"
                disabled={stopping}
                onClick={() => void onStop()}
              >
                {stopping ? <LoadingIcon size={15} /> : <StopCircleIcon size={15} />}
                {stopping ? "Stopping" : "Stop"}
              </button>
            ) : (
              <button
                type="button"
                className="uw-button uw-button-primary"
                disabled={!canSend}
                onClick={() => void onSend()}
              >
                {sending ? <LoadingIcon size={15} /> : "↑"}
                {sending ? "Sending" : "Send"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
