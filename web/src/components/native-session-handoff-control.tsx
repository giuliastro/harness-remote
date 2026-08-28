import { useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import { ChatIcon, LoadingIcon } from "../Icons"
import { canCreateNativeSession } from "../native-session-create"
import {
  nativeSessionSurfaceTarget,
  type NativeSessionHistoryEntry,
  type NativeSessionRecord,
  type NativeSessionSurfaceTarget
} from "../native-session-discovery"
import { handoffNativeSession } from "../native-session-handoff"
import type { MachineAgentHost } from "../types"
import { useDialogDismiss } from "../useDialogDismiss"
import { useTranslator } from "../useTranslator"

type Props = {
  source: NativeSessionSurfaceTarget
  agents: MachineAgentHost[]
  onOpen: (target: NativeSessionSurfaceTarget) => void
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

/**
 * Explicit cross-agent continuation for one native Session.
 *
 * Handoff creates a second real native Session on another harness; it never retargets the current
 * Session and never routes a prompt through the retired Task/Conversation pipeline. Before creating
 * that target we read the already-visible source transcript without refresh. This is deliberately
 * important for OMP and the other ACP adapters: opening this panel must never issue session/load,
 * resume a writer or touch replay/ownership state.
 */
export function NativeSessionHandoffControl({ source, agents, onOpen }: Props) {
  const t = useTranslator()
  const candidates = useMemo(
    () => agents.filter((agent) => agent.id !== source.agentID && canCreateNativeSession(agent)),
    [agents, source.agentID]
  )
  const [open, setOpen] = useState(false)
  const [targetAgentID, setTargetAgentID] = useState("")
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setOpen(false)
    setTargetAgentID("")
    setBusy(false)
    setPending(false)
    setError(null)
  }, [source.key])

  useEffect(() => {
    if (!open) return
    setTargetAgentID((current) => candidates.some((agent) => agent.id === current) ? current : (candidates[0]?.id || ""))
  }, [open, candidates])

  const close = () => {
    if (busy) return
    setOpen(false)
    setError(null)
  }

  useDialogDismiss(panelRef, close, { enabled: open })

  if (!source.directory || candidates.length === 0) return null

  async function continueWithAgent() {
    const agent = candidates.find((candidate) => candidate.id === targetAgentID)
    if (!agent || busy) return
    setBusy(true)
    setPending(false)
    setError(null)

    try {
      // refreshHistory=false is a hard ACP-safety boundary. The existing transcript cache/journal
      // is enough for handoff context and must not cause a second OMP replay or writer acquisition.
      const sourcePage = await api.loadMessagePage(source.config, source.sessionID, source.directory, undefined, 100, false)
      const result = await handoffNativeSession(source, agent.id, source.title)
      if (result.status !== "accepted" || !result.result?.target) {
        setPending(true)
        return
      }

      const nativeTarget = result.result.target
      const now = Date.now()
      const record: NativeSessionRecord = {
        key: `${agent.id}:${nativeTarget.sessionID}`,
        agentId: agent.id,
        agentLabel: agent.label || agent.id,
        backend: agent.backend === "omp" || agent.backend === "pi" || agent.backend === "claude" || agent.backend === "codex"
          ? agent.backend
          : "opencode",
        transport: agent.transport,
        stopCapability: agent.contract?.sessions?.stop,
        abortSupported: agent.capabilities?.abort === true,
        modelsSupported: agent.capabilities?.models === true,
        renameSupported: agent.capabilities?.sessionRename === true,
        deleteSupported: agent.capabilities?.sessionDelete === true,
        writerOwned: true,
        session: {
          id: nativeTarget.sessionID,
          title: source.title,
          directory: nativeTarget.directory,
          time: { created: now, updated: now },
          external: false
        }
      }
      const target = nativeSessionSurfaceTarget(nativeTarget.machineID, source.config, record)
      const inherited = [
        ...(source.history || []),
        historyEntry(source, sourcePage.messages)
      ]
      setOpen(false)
      onOpen({
        ...target,
        history: inherited,
        handoffContextPending: true,
        requiresExplicitClaim: false
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hr-session-actions hr-session-handoff">
      <button
        type="button"
        className="tdw-button secondary hr-session-handoff-trigger"
        onClick={() => { setError(null); setPending(false); setOpen(true) }}
        disabled={busy}
        aria-expanded={open}
      >
        <ChatIcon size={14} />
        {t("sf.continueWithAgent")}
        <span className="hr-experimental-badge">Experimental</span>
      </button>

      {open ? <div className="hr-session-action-backdrop" role="presentation" onMouseDown={close} /> : null}

      {open ? (
        <div className="hr-session-action-panel" role="dialog" aria-modal="true" aria-label={t("sf.continueWithAgent")} ref={panelRef}>
          <div className="hr-session-action-heading">
            <div>
              <strong>{t("sf.continueWithAgent")} <span className="hr-experimental-badge">Experimental</span></strong>
              <small>{t("sf.handoffSubtitle")}</small>
            </div>
            <button type="button" className="tdw-icon-button" data-dismiss="session-actions" onClick={close} disabled={busy} aria-label={t("sf.cancel")}>×</button>
          </div>

          <label className="hr-session-handoff-agent">
            <span>{t("sf.codingAgent")}</span>
            <select value={targetAgentID} onChange={(event) => { setTargetAgentID(event.target.value); setPending(false); setError(null) }} disabled={busy || pending}>
              {candidates.map((agent) => <option key={agent.id} value={agent.id}>{agent.label || agent.id}</option>)}
            </select>
          </label>

          {pending ? <div className="hr-session-action-error" role="status">{t("sf.handoffPending")}</div> : null}
          {error ? <div className="hr-session-action-error" role="alert">{error}</div> : null}

          <div className="hr-session-action-buttons">
            <button type="button" className="tdw-button secondary" data-autofocus onClick={close} disabled={busy}>{t("sf.cancel")}</button>
            <button type="button" className="tdw-button primary" onClick={() => void continueWithAgent()} disabled={busy || !targetAgentID}>
              {busy ? <LoadingIcon size={15} /> : null}
              {busy ? t("sf.handingOff") : pending ? t("sf.retry") : t("sf.continueSession")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
