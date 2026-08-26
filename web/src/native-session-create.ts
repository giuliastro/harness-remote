import { api } from "./api"
import {
  nativeSessionConfig,
  nativeSessionSurfaceTarget,
  type NativeSessionRecord,
  type NativeSessionSurfaceTarget
} from "./native-session-discovery"
import type { MachineAgentHost, ServerConfig } from "./types"

/** Native create is enabled only for transports that have passed the Session-first contract gate. */
export function canCreateNativeSession(agent: MachineAgentHost): boolean {
  const validatedTransport = (agent.backend === "pi" && agent.transport === "acp")
    || (agent.backend === "opencode" && agent.transport === "http")
  return validatedTransport && agent.capabilities?.sessions !== false
}

/**
 * Create one real harness-owned Session through the existing mature /session endpoint.
 *
 * This is intentionally a very small Session-first adapter. It does not create or persist a Task,
 * Conversation or Run. A Session created through the owning harness is immediately writable: ACP
 * owns the new writer already, while OpenCode's HTTP server owns writer coordination itself.
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
    throw new Error("New Session is currently enabled only for PI and OpenCode while native create parity is validated.")
  }
  if (!directory.trim()) throw new Error("Choose a Project before creating a Session.")

  const config = nativeSessionConfig(baseConfig, agent)
  const session = await api.createSession(config, title?.trim() || undefined, undefined, directory)
  if (!session?.id) throw new Error(`${agent.label || agent.id} did not return a native Session id.`)

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
    attachmentsSupported: agent.capabilities?.attachments === true,
    writerOwned: true,
    session
  }

  return {
    record,
    target: nativeSessionSurfaceTarget(machineID, baseConfig, record)
  }
}
