import type { NativeSessionIdentityPayload, NativeSessionLinkRecord } from "./api"

export type NativeSessionLineageDirection = "incoming" | "outgoing"

export type NativeSessionLineageEntry = {
  direction: NativeSessionLineageDirection
  other: NativeSessionIdentityPayload
  createdAt: string
  contextCarried: boolean
  authority: "invalidated"
  targetAuthorization: "re_evaluate"
  attachments: "not_transferred"
}

function sameNativeIdentity(left: NativeSessionIdentityPayload, right: NativeSessionIdentityPayload): boolean {
  return left.machineID === right.machineID
    && left.agentID === right.agentID
    && left.sessionID === right.sessionID
}

function lineageKey(link: NativeSessionLinkRecord): string {
  return [
    link.source.machineID,
    link.source.agentID,
    link.source.sessionID,
    link.target.machineID,
    link.target.agentID,
    link.target.sessionID,
    link.createdAt
  ].join("|")
}

/**
 * Project a daemon-owned handoff edge into a UI-safe lineage record.
 *
 * Paths stay machine-local and are deliberately not part of the displayed identity. The boundary
 * state is derived from the cross-machine contract rather than source Session metadata: portable
 * task context may be carried, while permissions and attachments are never inherited.
 */
export function nativeSessionLineage(
  identity: NativeSessionIdentityPayload,
  links: NativeSessionLinkRecord[]
): NativeSessionLineageEntry[] {
  const seen = new Set<string>()
  const entries: NativeSessionLineageEntry[] = []

  for (const link of links) {
    if (link.type !== "handoff") continue
    const sourceMatch = sameNativeIdentity(identity, link.source)
    const targetMatch = sameNativeIdentity(identity, link.target)
    if (sourceMatch === targetMatch) continue

    const key = lineageKey(link)
    if (seen.has(key)) continue
    seen.add(key)

    entries.push({
      direction: targetMatch ? "incoming" : "outgoing",
      other: targetMatch ? link.source : link.target,
      createdAt: link.createdAt,
      contextCarried: Boolean(link.transferredContext?.trim()),
      authority: "invalidated",
      targetAuthorization: "re_evaluate",
      attachments: "not_transferred"
    })
  }

  return entries.sort((left, right) => {
    const leftTime = Date.parse(left.createdAt)
    const rightTime = Date.parse(right.createdAt)
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime
    return left.createdAt.localeCompare(right.createdAt)
  })
}
