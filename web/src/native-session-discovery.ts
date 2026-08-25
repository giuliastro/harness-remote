import { api } from "./api"
import { nativeSessionDisplayTitle } from "./native-session-title"
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

function supportedBackend(value: string, fallback: BackendKind): BackendKind {
  return value === "opencode" || value === "omp" || value === "pi" || value === "claude" || value === "codex"
    ? value
    : fallback
}

/** Every status value a harness adapter reports while a turn is still running. */
const WORKING_STATUS_TYPES = new Set([
  "busy",
  "running",
  "working",
  "waiting",
  "retry",
  "in_progress",
  "in-progress"
])

/**
 * How long a reported "working" status is honoured after the Session last showed activity.
 *
 * A live turn advances the Session's own activity time on every chunk, plan update and message, so
 * a Session that claims to be working while its newest activity is this old is reporting a flag
 * that outlived its turn, not a harness that is still thinking. Sessions the user had long since
 * stopped or finished stayed painted as Working until the daemon was restarted.
 *
 * The window is far longer than any silent stretch inside a real turn (a long tool call still
 * streams its own updates, and the ACP prompt watchdog gives up after 300s), so this can only ever
 * downgrade a status that is genuinely stale.
 */
export const WORKING_STATUS_GRACE_MS = 600_000

/**
 * Presentation guard, not a second source of truth: any status the harness reports is passed
 * through untouched except a working claim that its own Session activity contradicts.
 */
export function corroboratedSessionStatus(
  session: Session,
  status: SessionStatus | undefined,
  now: number = Date.now()
): SessionStatus | undefined {
  if (!status) return status
  if (!WORKING_STATUS_TYPES.has(status.type?.trim().toLowerCase() || "")) return status
  const activityAt = session.time?.updated || session.time?.created || 0
  if (!activityAt || now - activityAt < WORKING_STATUS_GRACE_MS) return status
  return { ...status, type: "idle" }
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
    backend: supportedBackend(agent.backend || agent.id, base.backend),
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
  return sessions.map((session) => ({
    key: `${agent.id}:${session.id}`,
    agentId: agent.id,
    agentLabel: agent.label || agent.id,
    backend: config.backend,
    transport: agent.transport,
    stopCapability: agent.contract?.sessions?.stop,
    abortSupported: agent.capabilities?.abort === true,
    modelsSupported: agent.capabilities?.models === true,
    renameSupported: agent.capabilities?.sessionRename === true,
    deleteSupported: agent.capabilities?.sessionDelete === true,
    session,
    status: corroboratedSessionStatus(session, statuses[session.id])
  }))
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
