import { api, type NativeSessionLinkRecord } from "./api"
import type { AttachmentPart } from "./attachments"
import {
  nativeSessionSurfaceTarget,
  type NativeSessionHistoryEntry,
  type NativeSessionRecord,
  type NativeSessionRef,
  type NativeSessionSurfaceTarget
} from "./native-session-discovery"
import { acknowledgeNativeSessionHandoff, handoffNativeSession } from "./native-session-handoff"
import {
  nativeSessionTransferredContext,
  sendNativeSessionPrompt
} from "./native-session-prompt"
import type { MachineAgentHost, ModelSelection, ServerConfig } from "./types"

export type NativeSessionRouteMachine = {
  machineID: string
  label: string
  config: ServerConfig
  agents: MachineAgentHost[]
}

export type NativeSessionRouteContinueInput = {
  machineID: string
  agentID: string
  prompt: string
  attachments: AttachmentPart[]
  model: ModelSelection | null
  /** Required only when the destination is another machine. Same-machine routing ignores it. */
  projectID?: string
  /** Explicit acknowledgement of a reviewed-but-not-identical cross-machine workspace. */
  confirmedProjectContinuity?: boolean
}

type PendingRouteContinue = {
  agentID: string
  createdAt: number
  target: NativeSessionRef
  link?: NativeSessionLinkRecord
}

const STORAGE_PREFIX = "harness-remote.native-session-route-continue.v1"

function transactionKey(source: NativeSessionSurfaceTarget): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(source.machineID)}:${encodeURIComponent(source.agentID)}:${encodeURIComponent(source.sessionID)}`
}

function machineConfig(config: ServerConfig): ServerConfig {
  return { ...config, agentId: undefined }
}

export function clearPendingNativeSessionRoute(source: NativeSessionSurfaceTarget) {
  try { localStorage.removeItem(transactionKey(source)) } catch {}
}

function loadPending(source: NativeSessionSurfaceTarget): PendingRouteContinue | null {
  try {
    const raw = localStorage.getItem(transactionKey(source))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingRouteContinue>
    if (
      !parsed.target
      || !parsed.target.machineID
      || !parsed.target.agentID
      || !parsed.target.sessionID
      || !parsed.target.directory
      || typeof parsed.agentID !== "string"
    ) {
      clearPendingNativeSessionRoute(source)
      return null
    }
    return {
      agentID: parsed.agentID,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
      target: parsed.target,
      link: parsed.link
    }
  } catch {
    clearPendingNativeSessionRoute(source)
    return null
  }
}

function persistPending(source: NativeSessionSurfaceTarget, pending: PendingRouteContinue): boolean {
  try {
    localStorage.setItem(transactionKey(source), JSON.stringify(pending))
    return true
  } catch {
    return false
  }
}

function historyEntry(source: NativeSessionSurfaceTarget, messages: NativeSessionHistoryEntry["messages"]): NativeSessionHistoryEntry {
  return {
    ref: source.ref,
    title: source.title,
    agentID: source.agentID,
    agentLabel: source.agentLabel,
    backend: source.backend,
    messages
  }
}

function targetRecord(source: NativeSessionSurfaceTarget, ref: NativeSessionRef, agent: MachineAgentHost): NativeSessionRecord {
  const now = Date.now()
  return {
    key: `${agent.id}:${ref.sessionID}`,
    agentId: agent.id,
    agentLabel: agent.label || agent.id,
    backend: agent.backend === "omp" || agent.backend === "pi" || agent.backend === "claude" || agent.backend === "codex"
      ? agent.backend
      : "opencode",
    transport: agent.transport,
    stopCapability: agent.contract?.sessions?.stop,
    abortSupported: agent.capabilities?.abort === true,
    modelsSupported: agent.capabilities?.models === true,
    commandsSupported: agent.capabilities?.commands === true,
    renameSupported: agent.capabilities?.sessionRename === true,
    deleteSupported: agent.capabilities?.sessionDelete === true,
    writerOwned: true,
    session: {
      id: ref.sessionID,
      title: source.title,
      directory: ref.directory,
      time: { created: now, updated: now },
      external: false
    }
  }
}

/**
 * Continue one native Session on another harness of the same machine.
 *
 * Resource creation and first-prompt delivery are intentionally separate recovery domains:
 *
 * - before the target Session is known, handoffNativeSession owns a durable idempotency key and
 *   never expires it client-side;
 * - after the target Session is known, this route record keeps that exact target until its first
 *   prompt is accepted. Prompt/model retry semantics remain exclusively in native-session-prompt;
 *   this record never forgets the target and therefore cannot create another native Session.
 *
 * This means an ambiguous delivery can remain conservative, but it can never turn into duplicate
 * resource creation merely because time passed or a first prompt was refused.
 */
export async function continueNativeSessionOnRoute({
  source,
  targetMachine,
  targetAgent,
  prompt,
  attachments,
  model
}: {
  source: NativeSessionSurfaceTarget
  targetMachine: NativeSessionRouteMachine
  targetAgent: MachineAgentHost
  prompt: string
  attachments: AttachmentPart[]
  model: ModelSelection | null
}): Promise<NativeSessionSurfaceTarget> {
  if (targetMachine.machineID !== source.machineID) {
    throw new Error("Continuing on another machine is not available yet.")
  }
  if (attachments.length) {
    throw new Error("Remove images before continuing on another harness. Attachments remain scoped to the current Session for now.")
  }

  const normalizedPrompt = prompt.trim()
  if (!normalizedPrompt) throw new Error("A text prompt is required")

  let pending = loadPending(source)
  if (pending && pending.agentID !== targetAgent.id) {
    throw new Error(`A linked target Session already exists on ${pending.agentID}. Continue that target before choosing another harness.`)
  }

  if (!pending) {
    const result = await handoffNativeSession(source, targetAgent.id, source.title, model)
    if (result.status !== "accepted" || !result.result?.target) {
      throw new Error("The linked Session has not been confirmed yet. Retry the same harness and model to reconcile it.")
    }
    pending = {
      agentID: targetAgent.id,
      createdAt: Date.now(),
      target: result.result.target,
      link: result.result.link as NativeSessionLinkRecord | undefined
    }
    if (!persistPending(source, pending)) {
      throw new Error("The linked Session was created, but its recovery state could not be persisted. Retry the same harness to recover that exact target.")
    }
    acknowledgeNativeSessionHandoff(source)
  } else {
    // A previous crash may have happened after the route target was persisted but before the
    // creation key was acknowledged. The durable route target is now authoritative.
    acknowledgeNativeSessionHandoff(source)
  }

  const page = await api.loadMessagePage(source.config, source.sessionID, source.directory, undefined, 100, false)
  const next = nativeSessionSurfaceTarget(
    pending.target.machineID,
    targetMachine.config,
    targetRecord(source, pending.target, targetAgent)
  )
  const routedTarget: NativeSessionSurfaceTarget = {
    ...next,
    history: [...(source.history || []), historyEntry(source, page.messages)],
    handoffContextPending: true,
    requiresExplicitClaim: false
  }

  // Prompt idempotency belongs entirely to sendNativeSessionPrompt. Its own pending record decides
  // whether an ambiguous prompt must be retried exactly or whether its normal recovery horizon has
  // elapsed. This route record deliberately owns only the already-created target identity.

  const transferredContext = nativeSessionTransferredContext(routedTarget)
  const linkCandidate: NativeSessionLinkRecord = pending.link ?? {
    type: "handoff",
    source: source.ref,
    target: pending.target,
    createdAt: new Date(pending.createdAt).toISOString()
  }
  // Lineage + transferred context are part of the durable handoff contract, not fire-and-forget
  // enrichment. If this write fails, keep the known target route and retry this exact persistence
  // before sending the first prompt. That guarantees reload/reopen inspectability without ever
  // creating a second native Session.
  const persistedLink = await api.registerNativeSessionLink(machineConfig(source.config), {
    ...linkCandidate,
    ...(transferredContext ? { transferredContext } : {})
  })
  const enriched = { ...pending, link: persistedLink.link }
  if (persistPending(source, enriched)) pending = enriched

  const sent = await sendNativeSessionPrompt(routedTarget, normalizedPrompt, model, [])
  if (sent.status !== "accepted") {
    throw new Error("The linked Session exists, but delivery of its first prompt is not confirmed. Retry the same target to reconcile it.")
  }

  clearPendingNativeSessionRoute(source)
  return routedTarget
}
