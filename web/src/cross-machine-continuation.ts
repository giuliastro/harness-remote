import { api, type NativeSessionLinkRecord } from "./api"
import type { AttachmentPart } from "./attachments"
import {
  markCrossMachineHandoffContextSent,
  sendCrossMachineFirstPrompt
} from "./cross-machine-first-prompt"
import {
  preflightCrossMachineProject,
  requireCrossMachineProjectApproval,
  type CrossMachineProjectPreflight
} from "./cross-machine-project-preflight"
import {
  acknowledgeCrossMachineTargetSession,
  createCrossMachineTargetSession
} from "./cross-machine-target-client"
import { canCreateNativeSession } from "./native-session-create"
import {
  nativeSessionSurfaceTarget,
  type NativeSessionHistoryEntry,
  type NativeSessionRecord,
  type NativeSessionRef,
  type NativeSessionSurfaceTarget
} from "./native-session-discovery"
import { normalizeModel, sameModel } from "./native-session-model"
import { nativeSessionTransferredContext } from "./native-session-prompt"
import type { NativeSessionRouteMachine } from "./native-session-routing"
import type { BackendKind, MachineAgentHost, MessageEnvelope, ModelSelection, ServerConfig } from "./types"

export type CrossMachineContinuationResult = {
  target: NativeSessionSurfaceTarget
  preflight: CrossMachineProjectPreflight
}

type PendingCrossMachineContinuation = {
  targetMachineID: string
  sourceProjectId: string
  targetProjectId: string
  targetAgentID: string
  target: NativeSessionRef
  title: string
  prompt: string
  model?: ModelSelection | null
  promptRequestId: string
  createdAt: number
  transferredContext?: string
}

export type CrossMachineContinuationServices = {
  preflightProject: typeof preflightCrossMachineProject
  requireProjectApproval: typeof requireCrossMachineProjectApproval
  createTargetSession: typeof createCrossMachineTargetSession
  acknowledgeTargetSession: typeof acknowledgeCrossMachineTargetSession
  loadSourceMessages: (source: NativeSessionSurfaceTarget) => Promise<MessageEnvelope[]>
  registerSessionLink: (config: ServerConfig, link: NativeSessionLinkRecord) => Promise<void>
  sendFirstPrompt: typeof sendCrossMachineFirstPrompt
  markHandoffContextSent: typeof markCrossMachineHandoffContextSent
}

const STORAGE_PREFIX = "harness-remote.cross-machine-continuation.v1"

const defaultServices: CrossMachineContinuationServices = {
  preflightProject: preflightCrossMachineProject,
  requireProjectApproval: requireCrossMachineProjectApproval,
  createTargetSession: createCrossMachineTargetSession,
  acknowledgeTargetSession: acknowledgeCrossMachineTargetSession,
  async loadSourceMessages(source) {
    const page = await api.loadMessagePage(source.config, source.sessionID, source.directory, undefined, 100, false)
    return page.messages
  },
  async registerSessionLink(config, link) {
    await api.registerNativeSessionLink(config, link)
  },
  sendFirstPrompt: sendCrossMachineFirstPrompt,
  markHandoffContextSent: markCrossMachineHandoffContextSent
}

function storageKey(source: NativeSessionSurfaceTarget): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(source.machineID)}:${encodeURIComponent(source.agentID)}:${encodeURIComponent(source.sessionID)}`
}

function requestID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `cross-machine-prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function validRef(value: unknown): value is NativeSessionRef {
  if (!value || typeof value !== "object") return false
  const ref = value as Partial<NativeSessionRef>
  return [ref.machineID, ref.agentID, ref.sessionID, ref.directory].every((entry) => typeof entry === "string" && entry.length > 0)
}

function loadPending(source: NativeSessionSurfaceTarget): PendingCrossMachineContinuation | null {
  try {
    const raw = localStorage.getItem(storageKey(source))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingCrossMachineContinuation>
    if (!validRef(parsed.target)) return null
    if (typeof parsed.targetMachineID !== "string" || !parsed.targetMachineID) return null
    if (typeof parsed.sourceProjectId !== "string" || !parsed.sourceProjectId) return null
    if (typeof parsed.targetProjectId !== "string" || !parsed.targetProjectId) return null
    if (typeof parsed.targetAgentID !== "string" || !parsed.targetAgentID) return null
    if (typeof parsed.title !== "string") return null
    if (typeof parsed.prompt !== "string" || !parsed.prompt.trim()) return null
    if (typeof parsed.promptRequestId !== "string" || !parsed.promptRequestId) return null
    return {
      targetMachineID: parsed.targetMachineID,
      sourceProjectId: parsed.sourceProjectId,
      targetProjectId: parsed.targetProjectId,
      targetAgentID: parsed.targetAgentID,
      target: parsed.target,
      title: parsed.title,
      prompt: parsed.prompt,
      model: normalizeModel(parsed.model),
      promptRequestId: parsed.promptRequestId,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
      ...(typeof parsed.transferredContext === "string" ? { transferredContext: parsed.transferredContext } : {})
    }
  } catch {
    return null
  }
}

function persistPending(source: NativeSessionSurfaceTarget, pending: PendingCrossMachineContinuation): boolean {
  try {
    localStorage.setItem(storageKey(source), JSON.stringify(pending))
    return true
  } catch {
    return false
  }
}

function clearPending(source: NativeSessionSurfaceTarget) {
  try { localStorage.removeItem(storageKey(source)) } catch {}
}

function machineConfig(config: ServerConfig): ServerConfig {
  return { ...config, agentId: undefined }
}

function supportedBackend(value: string | undefined, fallback: BackendKind): BackendKind {
  return value === "opencode" || value === "omp" || value === "pi" || value === "claude" || value === "codex"
    ? value
    : fallback
}

function historyEntry(source: NativeSessionSurfaceTarget, messages: MessageEnvelope[]): NativeSessionHistoryEntry {
  return {
    ref: source.ref,
    title: source.title,
    agentID: source.agentID,
    agentLabel: source.agentLabel,
    backend: source.backend,
    messages
  }
}

function targetRecord(
  pending: PendingCrossMachineContinuation,
  targetMachine: NativeSessionRouteMachine,
  targetAgent: MachineAgentHost
): NativeSessionRecord {
  const now = Date.now()
  return {
    key: `${targetAgent.id}:${pending.target.sessionID}`,
    agentId: targetAgent.id,
    agentLabel: targetAgent.label || targetAgent.id,
    backend: supportedBackend(targetAgent.backend, targetMachine.config.backend),
    transport: targetAgent.transport,
    stopCapability: targetAgent.contract?.sessions?.stop,
    abortSupported: targetAgent.capabilities?.abort === true,
    modelsSupported: targetAgent.capabilities?.models === true,
    commandsSupported: targetAgent.capabilities?.commands === true,
    renameSupported: targetAgent.capabilities?.sessionRename === true,
    deleteSupported: targetAgent.capabilities?.sessionDelete === true,
    writerOwned: true,
    session: {
      id: pending.target.sessionID,
      title: pending.title,
      directory: pending.target.directory,
      time: { created: now, updated: now },
      external: false,
      ...(pending.model ? {
        model: {
          providerID: pending.model.providerID,
          id: pending.model.modelID,
          ...(pending.model.variant ? { variant: pending.model.variant } : {})
        }
      } : {})
    }
  }
}

function targetSurface(
  source: NativeSessionSurfaceTarget,
  pending: PendingCrossMachineContinuation,
  targetMachine: NativeSessionRouteMachine,
  targetAgent: MachineAgentHost,
  sourceMessages?: MessageEnvelope[]
): NativeSessionSurfaceTarget {
  const base = nativeSessionSurfaceTarget(targetMachine.machineID, targetMachine.config, targetRecord(pending, targetMachine, targetAgent))
  const history = [
    ...(source.history || []),
    ...(sourceMessages ? [historyEntry(source, sourceMessages)] : [])
  ]
  return {
    ...base,
    model: pending.model ?? null,
    ...(history.length ? { history } : {}),
    handoffContextPending: true,
    requiresExplicitClaim: false
  }
}

function assertSamePendingRoute(
  pending: PendingCrossMachineContinuation,
  {
    sourceProjectId,
    targetProjectId,
    targetMachineID,
    targetAgentID,
    prompt,
    model
  }: {
    sourceProjectId: string
    targetProjectId: string
    targetMachineID: string
    targetAgentID: string
    prompt: string
    model: ModelSelection | null
  }
) {
  if (
    pending.sourceProjectId !== sourceProjectId
    || pending.targetProjectId !== targetProjectId
    || pending.targetMachineID !== targetMachineID
    || pending.targetAgentID !== targetAgentID
    || pending.prompt !== prompt
    || !sameModel(pending.model, model)
  ) {
    throw new Error("A cross-machine continuation is already in progress. Retry the same target machine, Project, harness, prompt and model until it is reconciled.")
  }
}

/**
 * Crash-safe orchestration for one explicit cross-machine continuation.
 *
 * Safety/order invariants:
 * 1. Project continuity is checked before every mutation/recovery attempt.
 * 2. Target creation remains exactly-once through cross-machine-target-client.
 * 3. The exact target + first-prompt request id are persisted before creation is acknowledged.
 * 4. A bounded context snapshot is persisted before lineage or prompt delivery.
 * 5. The same lineage edge is durably stored on both source and target daemons before the prompt.
 * 6. The first prompt uses its own durable id with no client TTL, so a lost accepted response cannot
 *    become a duplicate turn on retry.
 * 7. No source permission/approval/tool ownership state is copied into the target Session.
 */
export async function continueNativeSessionAcrossMachine({
  source,
  sourceProjectId,
  targetMachine,
  targetProjectId,
  targetAgent,
  prompt,
  attachments,
  model,
  confirmedProjectContinuity = false,
  services = defaultServices
}: {
  source: NativeSessionSurfaceTarget
  sourceProjectId: string
  targetMachine: NativeSessionRouteMachine
  targetProjectId: string
  targetAgent: MachineAgentHost
  prompt: string
  attachments: AttachmentPart[]
  model: ModelSelection | null
  confirmedProjectContinuity?: boolean
  services?: CrossMachineContinuationServices
}): Promise<CrossMachineContinuationResult> {
  const sourceProject = sourceProjectId.trim()
  const targetProject = targetProjectId.trim()
  const normalizedPrompt = prompt.trim()
  const normalizedModel = normalizeModel(model)

  if (targetMachine.machineID === source.machineID) throw new Error("Choose a different machine for cross-machine continuation.")
  if (!sourceProject || !targetProject) throw new Error("Source and target Project identities are required for cross-machine continuation.")
  if (!normalizedPrompt) throw new Error("A text prompt is required")
  if (attachments.length) throw new Error("Cross-machine continuation does not transfer images yet. Remove attachments before continuing.")
  if (!targetMachine.agents.some((candidate) => candidate.id === targetAgent.id)) {
    throw new Error("The selected harness does not belong to the target machine.")
  }
  if (!canCreateNativeSession(targetAgent)) {
    throw new Error("The selected target harness cannot create a native Session right now.")
  }

  const preflight = await services.preflightProject({
    sourceMachineID: source.machineID,
    targetMachineID: targetMachine.machineID,
    sourceConfig: source.config,
    sourceProjectId: sourceProject,
    targetConfig: targetMachine.config,
    targetProjectId: targetProject
  })
  services.requireProjectApproval(preflight, { confirmed: confirmedProjectContinuity })

  let pending = loadPending(source)
  if (pending) {
    assertSamePendingRoute(pending, {
      sourceProjectId: sourceProject,
      targetProjectId: targetProject,
      targetMachineID: targetMachine.machineID,
      targetAgentID: targetAgent.id,
      prompt: normalizedPrompt,
      model: normalizedModel
    })
  } else {
    const created = await services.createTargetSession({
      source,
      targetMachineID: targetMachine.machineID,
      targetConfig: targetMachine.config,
      projectId: targetProject,
      targetAgentID: targetAgent.id,
      title: source.title,
      model: normalizedModel
    })
    if (created.status !== "accepted" || !created.result?.target) {
      throw new Error("Target Session creation is not confirmed yet. Retry the same destination to reconcile it.")
    }
    pending = {
      targetMachineID: targetMachine.machineID,
      sourceProjectId: sourceProject,
      targetProjectId: targetProject,
      targetAgentID: targetAgent.id,
      target: created.result.target,
      title: source.title,
      prompt: normalizedPrompt,
      model: normalizedModel,
      promptRequestId: requestID(),
      createdAt: Date.now()
    }
    if (!persistPending(source, pending)) {
      throw new Error("The target Session exists, but cross-machine recovery state could not be persisted. Retry the same destination to recover that exact Session.")
    }
  }

  // Once the exact target is in our own durable route record, the target-creation ledger key is no
  // longer the only recovery handle. A crash before this acknowledgement is harmless: retrying the
  // route calls the same acknowledgement again.
  services.acknowledgeTargetSession(source)

  let sourceMessages: MessageEnvelope[] | undefined
  if (pending.transferredContext === undefined) {
    sourceMessages = await services.loadSourceMessages(source)
    const provisional = targetSurface(source, pending, targetMachine, targetAgent, sourceMessages)
    const transferredContext = nativeSessionTransferredContext(provisional)
    const enriched = { ...pending, transferredContext }
    if (!persistPending(source, enriched)) {
      throw new Error("The target Session exists, but its bounded handoff context could not be persisted. Retry the same destination before sending the first prompt.")
    }
    pending = enriched
  } else {
    // Once the bounded snapshot is durable, source transcript availability is presentation-only.
    // Recovery may proceed while the source daemon is temporarily unavailable.
    try { sourceMessages = await services.loadSourceMessages(source) } catch {}
  }

  const routedTarget = targetSurface(source, pending, targetMachine, targetAgent, sourceMessages)
  const link: NativeSessionLinkRecord = {
    type: "handoff",
    source: source.ref,
    target: pending.target,
    createdAt: new Date(pending.createdAt).toISOString(),
    ...(pending.transferredContext ? { transferredContext: pending.transferredContext } : {})
  }

  // Replicate the same metadata edge to both machine-local stores. addHandoff is idempotent, so a
  // crash after either write simply retries the identical edge. Prompt delivery never starts until
  // both sides can explain the lineage after restart.
  await services.registerSessionLink(machineConfig(source.config), link)
  await services.registerSessionLink(machineConfig(targetMachine.config), link)

  const sent = await services.sendFirstPrompt({
    target: routedTarget,
    clientRequestId: pending.promptRequestId,
    text: pending.prompt,
    model: pending.model,
    transferredContext: pending.transferredContext || ""
  })
  if (sent.status !== "accepted") {
    throw new Error("The target Session and lineage exist, but first-prompt delivery is not confirmed. Retry the same continuation to reconcile it.")
  }

  services.markHandoffContextSent(routedTarget)
  clearPending(source)
  return { target: routedTarget, preflight }
}
