import { useEffect, useRef, useState } from "react"
import { api } from "../api"
import { handoffNativeSession } from "../native-session-handoff"
import {
  nativeSessionSurfaceTarget,
  type NativeSessionHistoryEntry,
  type NativeSessionRecord,
  type NativeSessionSurfaceTarget
} from "../native-session-discovery"
import type { MachineAgentHost, Session } from "../types"
import { LoadingIcon } from "../Icons"
import { useDialogDismiss } from "../useDialogDismiss"
import { useTranslator } from "../useTranslator"

/** How much of the source transcript travels with the handoff, newest first. */
const HANDOFF_HISTORY_LIMIT = 40

type Props = {
  source: NativeSessionSurfaceTarget
  agents: MachineAgentHost[]
  onOpen: (target: NativeSessionSurfaceTarget) => void
}

/**
 * Continue this Session with a different coding agent.
 *
 * A native Session belongs to the harness that created it, so "continuing with another agent"
 * cannot mean rewriting that Session: it means creating a real Session on the target harness and
 * carrying the conversation into its first prompt. The daemon owns that creation and links the two
 * Sessions (`/session/:id/handoff`), keyed by a client request id so a lost response retries the
 * same handoff instead of creating a second Session.
 *
 * The transcript travels as `history`, which `native-session-prompt` folds into one context packet
 * on the first prompt only - `handoffContextPending` marks that the packet is still owed.
 */
export function NativeSessionHandoffControl({ source, agents, onOpen }: Props) {
  const t = useTranslator()
  const [open, setOpen] = useState(false)
  const [targetAgentID, setTargetAgentID] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const candidates = agents.filter((agent) =>
    agent.id !== source.agentID && agent.capabilities?.sessions !== false && agent.capabilities?.prompt !== false)

  useEffect(() => {
    setOpen(false)
    setError(null)
    setBusy(false)
  }, [source.key])

  useEffect(() => {
    if (!candidates.some((agent) => agent.id === targetAgentID)) setTargetAgentID(candidates[0]?.id || "")
  }, [candidates, targetAgentID])

  useDialogDismiss(panelRef, () => { if (!busy) { setOpen(false); setError(null) } }, { enabled: open })

  // A Session with no directory cannot be reproduced on another harness: the target would open in
  // the wrong workspace, which is worse than refusing.
  if (!candidates.length || !source.directory) return null

  /**
   * The visible conversation, not the wire transcript: the same `USER INSTRUCTION` extraction the
   * timeline uses keeps an earlier handoff packet from being nested inside the next one.
   */
  async function sourceHistory(): Promise<NativeSessionHistoryEntry[]> {
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
      // Context is enrichment. A handoff whose history could not be read still creates the Session;
      // it just starts without the transferred conversation rather than failing outright.
      return []
    }
  }

  async function handoff() {
    const agent = candidates.find((candidate) => candidate.id === targetAgentID)
    if (!agent || busy) return
    setBusy(true)
    setError(null)
    try {
      const history = await sourceHistory()
      const outcome = await handoffNativeSession(source, agent.id, source.title)
      if (outcome.status !== "accepted" || !outcome.result) {
        throw new Error(t("sf.handoffPending"))
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
        // The daemon just created this Session through this bridge, so the writer is ours and the
        // user must not be asked to claim it a second time.
        writerOwned: true,
        session
      }

      const target = nativeSessionSurfaceTarget(created.machineID || source.machineID, source.config, record)
      setOpen(false)
      onOpen({ ...target, history, handoffContextPending: history.length > 0 })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hr-session-handoff">
      <button
        type="button"
        className="tdw-button secondary hr-session-handoff-trigger"
        onClick={() => { setError(null); setOpen((value) => !value) }}
        disabled={busy}
        aria-expanded={open}
      >
        {busy ? <LoadingIcon size={14} /> : null}
        {t("sf.continueWithAgent")}
      </button>

      {open ? (
        <div className="hr-session-action-panel" role="dialog" aria-modal="true" aria-label={t("sf.continueWithAgent")} ref={panelRef}>
          <div className="hr-session-action-heading">
            <div>
              <strong>{t("sf.continueWithAgent")}</strong>
              <small>{t("sf.handoffSubtitle")}</small>
            </div>
            <button type="button" className="tdw-icon-button" data-dismiss="session-actions" onClick={() => !busy && setOpen(false)} disabled={busy} aria-label={t("sf.close")}>×</button>
          </div>
          <label className="hr-session-action-field">
            <span>{t("sf.codingAgent")}</span>
            <select value={targetAgentID} onChange={(event) => setTargetAgentID(event.target.value)} disabled={busy} data-autofocus>
              {candidates.map((agent) => <option value={agent.id} key={agent.id}>{agent.label || agent.id}</option>)}
            </select>
          </label>
          {error ? <div className="hr-session-action-error" role="alert">{error}</div> : null}
          <div className="hr-session-action-buttons">
            <button type="button" className="tdw-button secondary" onClick={() => setOpen(false)} disabled={busy}>{t("sf.cancel")}</button>
            <button type="button" className="tdw-button primary" onClick={() => void handoff()} disabled={busy || !targetAgentID}>
              {busy ? <LoadingIcon size={15} /> : null}
              {busy ? t("sf.handingOff") : t("sf.continueSession")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
