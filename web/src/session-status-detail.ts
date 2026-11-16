import type { SessionStatus } from "./types"

/** A running turn with no updates for this long gets a "quiet" hint; the bridge sets `quietSince`. */
const MS_PER_MINUTE = 60_000

export function isListeningStatus(status?: Pick<SessionStatus, "type"> | null): boolean {
  return status?.type?.trim().toLowerCase() === "listening"
}

/** Number of background tasks a listening Session is waiting on (never below 1). */
export function listeningBackgroundCount(status?: SessionStatus | null): number {
  const count = Number(status?.background)
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 1
}

/** Whole minutes a busy Session has been quiet, or null when it is not flagged quiet. */
export function quietMinutes(status?: SessionStatus | null, now = Date.now()): number | null {
  if (status?.type?.trim().toLowerCase() !== "busy") return null
  const since = Number(status.quietSince)
  if (!Number.isFinite(since) || since <= 0) return null
  return Math.max(1, Math.floor((now - since) / MS_PER_MINUTE))
}

/** Copy the optional bridge fields a status carries so normalizers cannot drop them. */
export function statusDetailFields(source?: { background?: unknown; quietSince?: unknown; source?: unknown } | null): Pick<SessionStatus, "background" | "quietSince" | "source"> {
  const out: Pick<SessionStatus, "background" | "quietSince" | "source"> = {}
  const background = Number(source?.background)
  if (source?.background !== undefined && Number.isFinite(background)) out.background = background
  const quiet = Number(source?.quietSince)
  if (source?.quietSince !== undefined && Number.isFinite(quiet)) out.quietSince = quiet
  if (typeof source?.source === "string" && source.source) out.source = source.source
  return out
}
