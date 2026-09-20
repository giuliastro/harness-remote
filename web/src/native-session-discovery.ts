import { api, type NativeSessionLinkRecord } from "./api"
import { nativeSessionDisplayTitle } from "./native-session-title"
import { liveSessionIndexStatus } from "./session-index-live-state"
import { backendForAgent } from "./serverConfig"
import type { BackendKind, MachineAgentHost, MessageEnvelope, ModelSelection, ServerConfig, Session, SessionStatus } from "./types"

export type NativeSessionRecord = {
  key: string
  agentId: string
  agentLabel: string
  backend: BackendKind
  transport: string
  stopCapability?: string
  abortSupported: boolean
  modelsSupported: boolean
  commandsSupported?: boolean
  renameSupported: boolean
  deleteSupported: boolean
  /** True only when this UI record comes from a mutation that just created/claimed the Session through
   * this daemon. Discovery itself deliberately leaves ownership unknown. */
  writerOwned?: boolean
  session: Session
  status?: SessionStatus
}

/** Stable identity for one real native coding-agent Session across every configured machine. */
export type NativeSessionRef = {
  machineID: string
  agentID: string
  sessionID: string
  directory: string
}

export type NativeSessionLink = NativeSessionLinkRecord

/**
 * Visible history inherited from an earlier native Session in an explicit cross-agent handoff.
 * This is presentation/context data only: the Session ids remain the real lifecycle identities.
 */
export type NativeSessionHistoryEntry = {
  ref: NativeSessionRef
  title: string
  agentID: string
  agentLabel: string
  backend: BackendKind
  messages: MessageEnvelope[]
}

/**
 * This is the minimal input the existing HR3 chat surface needs in order to render one real native
 * Session. It deliberately contains no Task/Conversation identity: discovery and observation must
 * work for Sessions that were started entirely outside Harness Remote.
 *
 * `ref` is the operation identity. Native session ids are harness-owned and are not assumed to be
 * globally unique across agents or machines, so every mutation keeps machine + agent + native id.
 */
export type NativeSessionSurfaceTarget = {
  key: string
  ref: NativeSessionRef
  machineID: string
  sessionID: string
  directory: string
  title: string
  agentID: string
  agentLabel: string
  backend: BackendKind
  transport: string
  config: ServerConfig
  status?: SessionStatus
  external: boolean
  modelsSupported: boolean
  commandsSupported?: boolean
  /** Native metadata mutations are exposed by the owning harness contract. The chat header shows
   * Rename/Delete only for a Session whose harness actually implements them. */
  renameSupported: boolean
  deleteSupported: boolean
  model: ModelSelection | null
  parentID?: string
  summary?: Session["summary"]
  tokens?: Session["tokens"]
  cost?: number
  nativeAgent?: string
  permission?: Session["permission"]
  /** Earlier linked native Sessions shown before this Session, preserving the mature v3 continuity
   * experience without introducing a new Conversation identity. */
  history?: NativeSessionHistoryEntry[]
  /** A freshly created cross-agent target has not received its first user instruction yet. The
   * client uses the inherited history to build one bounded v3-style context packet for that first
   * prompt only. */
  handoffContextPending?: boolean
  /** Lightweight ACP discovery cannot prove that this bridge owns the writer. A Session that was
   * just created/claimed through this daemon can set writerOwned and must not make the user claim it
   * a second time. */
  requiresExplicitClaim: boolean
  /** Stop is exposed only when both the coarse capability and the Session-first contract name a
   * native cancellation primitive we understand. Unknown adapter semantics stay hidden. */
  canStop: boolean
}

function supportedStopCapability(value: string | undefined): boolean {
  return value === "owned-session-native-cancel" || value === "native-abort"
}

function sessionModel(session: Session): ModelSelection | null {
  if (!session.model?.providerID || !session.model.id) return null
  return {
    providerID: session.model.providerID,
    modelID: session.model.id,
    ...(session.model.variant ? { variant: session.model.variant } : {})
  }
}

/**
 * A machine profile addresses the daemon. Native Session reads must then be scoped to the exact
 * harness that owns the Session, otherwise a multi-harness machine silently falls back to the
 * daemon's primary agent. Keep this derivation in one place so Session-first UI never invents a
 * second routing policy.
 */
export function nativeSessionConfig(base: ServerConfig, agent: MachineAgentHost): ServerConfig {
  return {
    ...base,
    backend: backendForAgent(agent.backend, agent.id, base.backend),
    agentId: agent.id
  }
}

/**
 * Convert discovery data into the same primitive the HR3 transcript/composer can consume next.
 * This is a view-model conversion only. It never adopts, resumes or creates anything on the daemon.
 *
 * ACP discovery is intentionally conservative: `/experimental/session` is metadata-only and cannot
 * prove this process owns a native writer. Discovered ACP Sessions therefore start observe-only.
 * A mutation-created record may explicitly carry `writerOwned: true`; in that case forcing another
 * claim would be both redundant and a visible UX regression.
 */
export function nativeSessionSurfaceTarget(
  machineID: string,
  base: ServerConfig,
  record: NativeSessionRecord
): NativeSessionSurfaceTarget {
  const directory = record.session.directory || ""
  const ref: NativeSessionRef = {
    machineID,
    agentID: record.agentId,
    sessionID: record.session.id,
    directory
  }
  const external = record.session.external === true
  return {
    key: `${machineID}:${record.key}`,
    ref,
    machineID,
    sessionID: ref.sessionID,
    directory: ref.directory,
    title: nativeSessionDisplayTitle(record.session.title),
    agentID: ref.agentID,
    agentLabel: record.agentLabel,
    backend: record.backend,
    transport: record.transport,
    config: {
      ...base,
      backend: record.backend,
      agentId: record.agentId
    },
    status: record.status,
    external,
    modelsSupported: record.modelsSupported,
    commandsSupported: record.commandsSupported === true,
    renameSupported: record.renameSupported,
    deleteSupported: record.deleteSupported,
    model: sessionModel(record.session),
    parentID: record.session.parentID,
    summary: record.session.summary,
    tokens: record.session.tokens,
    cost: record.session.cost,
    nativeAgent: record.session.agent,
    permission: record.session.permission,
    requiresExplicitClaim: external || (record.transport === "acp" && record.writerOwned !== true),
    canStop: record.abortSupported && supportedStopCapability(record.stopCapability)
  }
}

export type NativeSessionReadApi = Pick<typeof api, "listGlobalSessions" | "listSessions" | "listStatuses">

export type NativeSessionPageReadApi = Pick<typeof api, "listGlobalSessionPage" | "listSessions" | "listStatuses">

export type NativeSessionRecordPage = {
  records: NativeSessionRecord[]
  nextCursor?: string
}

/**
 * Session-first discovery fans out across every harness on a machine. A cold ACP adapter can spend
 * tens of seconds starting (and intentionally has a much larger adapter startup ceiling), but that
 * must never keep an already-available OpenCode/PI/etc. Session rail on "Loading Sessions".
 *
 * This is only an observation budget for one harness index read. It does not abort, close or mutate
 * the native harness; the in-flight adapter start may still finish normally and the next ordinary
 * discovery pass can pick it up. Eight seconds matches the existing prompt-side enrichment budget
 * and is long enough for a local index read while keeping one slow harness from owning global UX.
 */
export const NATIVE_SESSION_DISCOVERY_BUDGET_MS = 8_000

export class NativeSessionDiscoveryTimeoutError extends Error {
  constructor(agentID: string, timeoutMs: number) {
    super(`Native Session discovery for ${agentID} timed out after ${timeoutMs}ms`)
    this.name = "NativeSessionDiscoveryTimeoutError"
  }
}

async function withinNativeSessionDiscoveryBudget<T>(
  work: Promise<T>,
  agentID: string,
  timeoutMs: number
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new NativeSessionDiscoveryTimeoutError(agentID, timeoutMs)), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function isHarnessRemoteInternalTestSession(session: Session): boolean {
  const directory = String(session.directory ?? "").replace(/\\/g, "/")
  const parts = directory.split("/").filter(Boolean)
  const leaf = parts.length ? parts[parts.length - 1] : ""
  if (/^harness-[a-z0-9._-]+-smoke-[a-z0-9._-]+$/i.test(leaf)) return true

  const title = String(session.title ?? "").trim()
  return /^Harness Remote (?:smoke|release-gate\b)/i.test(title)
}

function nativeSessionRecords(
  agent: MachineAgentHost,
  config: ServerConfig,
  sessions: Session[],
  statuses: Record<string, SessionStatus> = {}
): NativeSessionRecord[] {
  return sessions
    .filter((session) => !isHarnessRemoteInternalTestSession(session))
    .map((session) => ({
    key: `${agent.id}:${session.id}`,
    agentId: agent.id,
    agentLabel: agent.label || agent.id,
    backend: config.backend,
    transport: agent.transport,
    stopCapability: agent.contract?.sessions?.stop,
    abortSupported: agent.capabilities?.abort === true,
    modelsSupported: agent.capabilities?.models === true,
    commandsSupported: agent.capabilities?.commands === true,
    renameSupported: agent.capabilities?.sessionRename === true,
    deleteSupported: agent.capabilities?.sessionDelete === true,
    session,
    // A lifecycle edge can precede convergence of the lightweight status endpoint. Use that fresher
    // observation only inside its bounded grace period; durable discovery becomes authoritative again
    // automatically afterwards, so a missed future event cannot pin presentation forever.
    status: liveSessionIndexStatus(config, session.id) ?? statuses[session.id] ?? session.status
  }))
}

/**
 * Read exactly one lightweight native Session page. A cursor belongs to the adapter connection and
 * is forwarded untouched; only the initial page may fall back to the stable non-paged endpoint.
 *
 * The complete read for one harness is bounded. In particular, a cold ACP startup is allowed to
 * continue in the daemon, but the federated rail stops waiting for it and can render the other
 * harnesses. A real unsupported-route error may still use the legacy stable endpoint inside the same
 * overall budget; a timeout never starts a second fallback request behind the first slow one.
 */
export async function discoverAgentNativeSessionPage(
  base: ServerConfig,
  agent: MachineAgentHost,
  cursor?: string,
  client: NativeSessionPageReadApi = api,
  timeoutMs = NATIVE_SESSION_DISCOVERY_BUDGET_MS
): Promise<NativeSessionRecordPage> {
  if (agent.capabilities?.sessions === false) return { records: [] }
  const config = nativeSessionConfig(base, agent)
  const startedAt = Date.now()
  const remaining = () => Math.max(1, timeoutMs - (Date.now() - startedAt))
  const bounded = <T>(work: Promise<T>) => withinNativeSessionDiscoveryBudget(work, agent.id, remaining())

  try {
    const page = await bounded(client.listGlobalSessionPage(config, cursor))
    const statuses = page.sessions.some((session) => !session.status)
      ? await bounded(client.listStatuses(config)).catch(() => ({} as Record<string, SessionStatus>))
      : {}
    return {
      records: nativeSessionRecords(agent, config, page.sessions, statuses),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
    }
  } catch (error) {
    if (cursor || error instanceof NativeSessionDiscoveryTimeoutError) throw error
    const sessions = await bounded(client.listSessions(config))
    const statuses = sessions.some((session) => !session.status)
      ? await bounded(client.listStatuses(config)).catch(() => ({} as Record<string, SessionStatus>))
      : {}
    return { records: nativeSessionRecords(agent, config, sessions, statuses) }
  }
}

/**
 * Read-only discovery for one native harness. The experimental global listing is preferred because
 * it already provides pagination for large histories; harnesses that do not expose it fall back to
 * the stable Session endpoint. Status is enrichment only and must never make discovery fail.
 *
 * This intentionally does not create/adopt/attach a Task or Conversation. A Session started outside
 * Harness Remote must be visible as itself before we decide whether HR may continue writing to it.
 */
export async function discoverAgentNativeSessions(
  base: ServerConfig,
  agent: MachineAgentHost,
  client: NativeSessionReadApi = api
): Promise<NativeSessionRecord[]> {
  if (agent.capabilities?.sessions === false) return []
  const config = nativeSessionConfig(base, agent)
  const sessions = await client.listGlobalSessions(config).catch(() => client.listSessions(config))
  const statuses = await client.listStatuses(config).catch(() => ({} as Record<string, SessionStatus>))
  return nativeSessionRecords(agent, config, sessions, statuses)
}

/**
 * Discover every harness independently. One broken or lazily unavailable adapter must not hide the
 * Sessions of the other harnesses on the same machine.
 */
export async function discoverMachineNativeSessions(
  base: ServerConfig,
  agents: MachineAgentHost[],
  client: NativeSessionReadApi = api
): Promise<NativeSessionRecord[]> {
  const groups = await Promise.all(agents.map((agent) =>
    discoverAgentNativeSessions(base, agent, client).catch(() => [] as NativeSessionRecord[])
  ))
  return groups
    .flat()
    .sort((left, right) => (right.session.time?.updated || 0) - (left.session.time?.updated || 0))
}
