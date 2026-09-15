import { useMemo, useSyncExternalStore, type ComponentProps } from "react"
import {
  NativeSessionHome as NativeSessionHomeWithAttention,
  appendCursorPage,
  attentionInboxCounts,
  refreshCursorPage,
  sessionTreeRows
} from "./native-session-home-attention"
import {
  sessionIndexInvalidationRevision,
  subscribeSessionIndexInvalidation
} from "../session-index-live-state"

export { appendCursorPage, attentionInboxCounts, refreshCursorPage, sessionTreeRows }

export type {
  AttentionInboxCounts,
  CursorPageState
} from "./native-session-home-attention"

type Props = ComponentProps<typeof NativeSessionHomeWithAttention>

/**
 * Session lifecycle is not part of `/v1/machine`, so a live edge must invalidate the Session read
 * directly rather than smuggling client-only state into the daemon snapshot. Cloning only the
 * source wrappers preserves the real machine payload while making the existing discovery effect
 * observe the lifecycle revision. Manual refreshToken semantics remain untouched.
 */
export function NativeSessionHome(props: Props) {
  const liveRevision = useSyncExternalStore(
    subscribeSessionIndexInvalidation,
    sessionIndexInvalidationRevision,
    sessionIndexInvalidationRevision
  )
  const liveSources = useMemo(
    () => props.sources.map((source) => ({ ...source })),
    [props.sources, liveRevision]
  )
  return <NativeSessionHomeWithAttention {...props} sources={liveSources} />
}
