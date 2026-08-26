import { api } from "./api"
import {
  nativeSessionConfig,
  nativeSessionSurfaceTarget,
  type NativeSessionRecord,
  type NativeSessionSurfaceTarget
} from "./native-session-discovery"
import type { MachineAgentHost, ServerConfig } from "./types"

/**
 * Native create uses the same mature /session route for every harness transport that can own a
 * writable Session. This creates a real harness-owned native Session, never a parallel Conversation
 * object. ACP's implementation is deliberately generic (`session/new`) and OpenCode owns the
 * equivalent HTTP lifecycle, so the UI must not hide OMP, Claude or Codex behind an old rollout
 * gate that was only meant for the first Session-first validation pass.
 */
export function canCreateNativeSession(agent: MachineAgentHost): boolean {
  const supportedTransport = agent.transport === "acp" || agent.transport === "http"
  return supportedTransport
    && agent.state !== "unavailable"
    && agent.capabilities?.sessions !== false
    && agent.capabilities?.prompt !== false
}

/**
 * Create one real harness-owned Session through the existing mature /session endpoint.
 *
 * OMP's ACP `session/new` does not accept a title field. OMP 18.x does expose its native `/rename`
 * command through ACP, however, and that command updates the same title storage used by `session/list`.
 * Persist an explicitly supplied title through that native path immediately after creation instead
 * of keeping a Harness Remote-only display name that disappears on the next discovery refresh.
 */
export async function createNativeSessionTarget({
  machineID,
  baseConfig,
  agent,
  directory,
  title
}: {
  machineID: string
  baseConfig: ServerConfig
  agent: MachineAgentHost
  directory: string
  title?: string
}): Promise<{ target: NativeSessionSurfaceTarget; record: NativeSessionRecord }> {
  if (!canCreateNativeSession(agent)) {
    throw new Error("This harness does not expose writable native Sessions on its current transport.")
  }
  if (!directory.trim()) throw new Error("Choose a Project before creating a Session.")

  const config = nativeSessionConfig(baseConfig, agent)
  const normalizedTitle = title?.trim() || undefined
  let session = await api.createSession(config, normalizedTitle, undefined, directory)
  if (!session?.id) throw new Error(`${agent.label || agent.id} did not return a native Session id.`)

  // OMP cannot receive the title in session/new. The bridge profile maps this PATCH to OMP's native
  // ACP /rename command, so the name survives daemon restarts and is visible to OMP itself too.
  if (config.backend === "omp" && normalizedTitle) {
    session = await api.renameSession(config, session.id, normalizedTitle, directory)
  }

  const record: NativeSessionRecord = {
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
    writerOwned: true,
    session
  }

  return {
    record,
    target: nativeSessionSurfaceTarget(machineID, baseConfig, record)
  }
}