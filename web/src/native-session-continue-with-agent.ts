import { api } from "./api"
import type { AttachmentPart } from "./attachments"
import {
  nativeSessionSurfaceTarget,
  type NativeSessionHistoryEntry,
  type NativeSessionRecord,
  type NativeSessionSurfaceTarget
} from "./native-session-discovery"
import { handoffNativeSession } from "./native-session-handoff"
import { sendNativeSessionPrompt } from "./native-session-prompt"
import type { MachineAgentHost, ModelSelection, Session } from "./types"

/** How much of the source transcript travels with the continuation, newest first. */
const HANDOFF_HISTORY_LIMIT = 40

/**
 * Continuing the conversation with a different coding agent.
 *
 * A native Session belongs to the harness that created it, and the transport rejects a prompt
 * addressed to a different one - so "continuing with another agent" cannot mean rewriting this
 * Session. It means creating a real Session on the chosen harness and carrying the conversation
 * into its first prompt. The daemon owns that creation and links the two Sessions
 * (`/session/:id/handoff`), keyed by a client request id so a lost response retries the same
 * handoff instead of creating a second Session.
 *
 * This used to sit behind a "Continue with another agent" button in the chat header, which said
 * nothing about when it applied and duplicated a choice the header already offers. It is now what
 * the header's agent selector does: pick another harness, write the next message, and the
 * conversation continues there.
 */
export function continuationCandidates(
  source: NativeSessionSurfaceTarget,
  agents: MachineAgentHost[]
): MachineAgentHost[] {
  // A Session with no directory cannot be reproduced on another harness: the target would open in
  // the wrong workspace, which is worse than refusing.
  if (!source.directory) return []
  return agents.filter((agent) =>
    agent.id !== source.agentID
    && agent.capabilities?.sessions !== false
    && agent.capabilities?.prompt !== false)
}

/**
 * The visible conversation, not the wire transcript: the same `USER INSTRUCTION` extraction the
 * timeline uses keeps an earlier handoff packet from being nested inside the next one.
 *
 * Context is enrichment. A continuation whose history could not be read still creates the Session;
 * it just starts without the transferred conversation rather than failing outright.
 */
async function sourceHistory(source: NativeSessionSurfaceTarget): Promise<NativeSessionHistoryEntry[]> {
  try {
    const page = await api.loadMessagePage(source.config, source.sessionID, source.directory, undefined, HANDOFF_HISTORY_LIMIT, false)
    if (!page.messages.length) return []
    return [{
      ref: source.ref,
      title: source.title,
      agentID: source.agentID,
      agentLabel: source.agentLabel,
      backend: source.backend,
      messages: page.messages
    }]
  } catch {
    return []
  }
}

export type ContinueWithAgentInput = {
  agent: MachineAgentHost
  prompt: string
  attachments?: AttachmentPart[]
  model?: ModelSelection | null
}

/**
 * Creates the Session on the target harness, sends the user's message into it with this
 * conversation folded in, and returns the new Session to open.
 *
 * The prompt travels with the handoff rather than waiting for the user to retype it: they already
 * wrote it in the composer, and a continuation that lands on an empty Session is indistinguishable
 * from having lost the message.
 */
export async function continueNativeSessionWithAgent(
  source: NativeSessionSurfaceTarget,
  { agent, prompt, attachments = [], model = null }: ContinueWithAgentInput
): Promise<NativeSessionSurfaceTarget> {
  const outcome = await handoffNativeSession(source, agent.id, source.title)
  if (outcome.status !== "accepted" || !outcome.result) {
    throw new Error(`Continuation is ${outcome.status}. Send the same message again to reconcile the existing request instead of creating a second Session.`)
  }

  const created = outcome.result.target
  const session: Session = {
    id: created.sessionID,
    title: source.title,
    directory: created.directory || source.directory,
    time: { created: Date.now(), updated: Date.now() },
    summary: { additions: 0, deletions: 0, files: 0 }
  }
  const record: NativeSessionRecord = {
    key: `${created.agentID}:${created.sessionID}`,
    agentId: created.agentID,
    agentLabel: agent.label || agent.id,
    backend: (agent.backend || agent.id) as NativeSessionRecord["backend"],
    transport: agent.transport,
    stopCapability: agent.contract?.sessions?.stop,
    abortSupported: agent.capabilities?.abort === true,
    modelsSupported: agent.capabilities?.models === true,
    renameSupported: agent.capabilities?.sessionRename === true,
    deleteSupported: agent.capabilities?.sessionDelete === true,
    attachmentsSupported: agent.capabilities?.attachments === true,
    // The daemon just created this Session through this bridge, so the writer is ours and the user
    // must not be asked to claim it a second time.
    writerOwned: true,
    session
  }

  const history = await sourceHistory(source)
  const target: NativeSessionSurfaceTarget = {
    ...nativeSessionSurfaceTarget(created.machineID || source.machineID, source.config, record),
    history,
    handoffContextPending: history.length > 0
  }

  const delivery = await sendNativeSessionPrompt(target, prompt, model, attachments)
  if (delivery.status !== "accepted") {
    // The Session exists and is the one to open: retrying the same message there converges on the
    // daemon's existing ledger entry rather than duplicating the turn.
    throw new Error(`Message delivery to ${agent.label || agent.id} is ${delivery.status}. Open the new Session and send it again to reconcile.`)
  }
  return target
}
