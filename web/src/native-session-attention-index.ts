import { api } from "./api"
import { classifyNativeSessionAttention, type NativeSessionAttention } from "./native-session-attention"
import { nativeSessionConfig } from "./native-session-discovery"
import type { MachineAgentHost, PermissionRequest, QuestionRequest, ServerConfig } from "./types"

export type NativeSessionAttentionIndexItem = {
  sessionID: string
  attention: NativeSessionAttention
  questions: QuestionRequest[]
  permissions: PermissionRequest[]
}

export type NativeSessionAttentionIndex = {
  agentID: string
  queried: {
    questions: boolean
    permissions: boolean
  }
  complete: boolean
  errors: {
    questions?: string
    permissions?: string
  }
  items: NativeSessionAttentionIndexItem[]
}

type AttentionLoaders = {
  loadQuestions: (config: ServerConfig) => Promise<QuestionRequest[]>
  loadPermissions: (config: ServerConfig) => Promise<PermissionRequest[]>
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Read pending user-attention payloads once per advertised harness capability.
 *
 * The endpoints already return every pending request with its native sessionID, so callers must not
 * turn this into one request per Session. Harnesses that do not advertise a capability are never
 * probed for it: absence of support is different from an empty pending-request list.
 */
export async function loadNativeSessionAttentionIndex(
  baseConfig: ServerConfig,
  agent: MachineAgentHost,
  loaders: AttentionLoaders = {
    loadQuestions: (config) => api.loadQuestions(config),
    loadPermissions: (config) => api.loadPermissions(config)
  }
): Promise<NativeSessionAttentionIndex> {
  const queryQuestions = agent.capabilities.questions === true
  const queryPermissions = agent.capabilities.permissions === true
  const config = nativeSessionConfig(baseConfig, agent)

  const [questionResult, permissionResult] = await Promise.all([
    queryQuestions
      ? loaders.loadQuestions(config).then((value) => ({ ok: true as const, value }), (reason) => ({ ok: false as const, reason }))
      : Promise.resolve({ ok: true as const, value: [] as QuestionRequest[] }),
    queryPermissions
      ? loaders.loadPermissions(config).then((value) => ({ ok: true as const, value }), (reason) => ({ ok: false as const, reason }))
      : Promise.resolve({ ok: true as const, value: [] as PermissionRequest[] })
  ])

  const errors: NativeSessionAttentionIndex["errors"] = {}
  if (!questionResult.ok) errors.questions = message(questionResult.reason)
  if (!permissionResult.ok) errors.permissions = message(permissionResult.reason)

  const bySession = new Map<string, { questions: QuestionRequest[]; permissions: PermissionRequest[] }>()
  const bucket = (sessionID: string) => {
    const existing = bySession.get(sessionID)
    if (existing) return existing
    const created = { questions: [] as QuestionRequest[], permissions: [] as PermissionRequest[] }
    bySession.set(sessionID, created)
    return created
  }

  if (questionResult.ok) {
    for (const request of questionResult.value) {
      if (request.sessionID) bucket(request.sessionID).questions.push(request)
    }
  }
  if (permissionResult.ok) {
    for (const request of permissionResult.value) {
      if (request.sessionID) bucket(request.sessionID).permissions.push(request)
    }
  }

  const items = [...bySession.entries()]
    .map(([sessionID, pending]) => ({
      sessionID,
      questions: pending.questions,
      permissions: pending.permissions,
      attention: classifyNativeSessionAttention(pending)
    }))
    .sort((left, right) => left.sessionID.localeCompare(right.sessionID))

  return {
    agentID: agent.id,
    queried: { questions: queryQuestions, permissions: queryPermissions },
    complete: Object.keys(errors).length === 0,
    errors,
    items
  }
}
