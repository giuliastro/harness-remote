import { useEffect, useRef, useState } from "react"
import { api } from "../api"
import { LoadingIcon, TrashIcon } from "../Icons"
import type { NativeSessionSurfaceTarget } from "../native-session-discovery"
import { useDialogDismiss } from "../useDialogDismiss"
import { useTranslator } from "../useTranslator"

/**
 * Delete, for the Session that is open.
 *
 * Rename left here for `native-session-title-editor`: a modal with a heading, a subtitle, a labelled
 * field and two buttons was four lines of chrome to change one line of text, and it hung off an icon
 * button in the corner rather than the title it renamed. Delete keeps its confirmation - it is the
 * one action in this header that cannot be undone.
 */
type Props = {
  target: NativeSessionSurfaceTarget
  /** False while the owning machine is unreachable: a delete cannot land, and offering it produces
   *  a network error instead of an explanation. */
  machineOnline?: boolean
  onDeleted: (key: string) => void
}

export function NativeSessionActions({ target, machineOnline = true, onDeleted }: Props) {
  const t = useTranslator()
  const [mode, setMode] = useState<"delete" | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const deleteRef = useRef<HTMLDivElement>(null)

  // Switching Session must never leave a primed deletion pointing at the Session the user just
  // navigated to.
  useEffect(() => {
    setMode(null)
    setBusy(false)
    setError(null)
  }, [target.key])

  const close = () => {
    if (busy) return
    setMode(null)
    setError(null)
  }

  useDialogDismiss(deleteRef, close, { enabled: mode === "delete" })

  if (!machineOnline) return null
  if (!target.deleteSupported) return null

  function beginDelete() {
    if (busy) return
    setError(null)
    setMode("delete")
  }

  async function deleteSession() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteSession(target.config, target.sessionID, target.directory)
      setMode(null)
      onDeleted(target.key)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hr-session-actions">
      {target.deleteSupported ? (
        <button
          type="button"
          className="tdw-icon-button hr-session-action-danger"
          onClick={beginDelete}
          disabled={busy}
          aria-expanded={mode === "delete"}
          aria-label={t("sf.deleteSession")}
          title={t("sf.deleteSession")}
        >
          <TrashIcon size={15} />
        </button>
      ) : null}

      {mode ? <div className="hr-session-action-backdrop" role="presentation" onMouseDown={close} /> : null}

      {mode === "delete" ? (
        <div className="hr-session-action-panel" role="dialog" aria-modal="true" aria-label={t("sf.deleteSession")} ref={deleteRef}>
          <div className="hr-session-action-heading">
            <div>
              <strong>{t("sf.deleteSessionTitle", { title: target.title })}</strong>
              <small>{t("sf.deleteSubtitle", { agent: target.agentLabel })}</small>
            </div>
            <button type="button" className="tdw-icon-button" data-dismiss="session-actions" onClick={close} disabled={busy} aria-label={t("sf.closeDelete")}>×</button>
          </div>
          {error ? <div className="hr-session-action-error" role="alert">{error}</div> : null}
          <div className="hr-session-action-buttons">
            <button type="button" className="tdw-button secondary" data-autofocus onClick={close} disabled={busy}>{t("sf.keepSession")}</button>
            <button type="button" className="tdw-button danger" onClick={() => void deleteSession()} disabled={busy}>
              {busy ? <LoadingIcon size={15} /> : null}
              {busy ? t("sf.deleting") : t("sf.deleteSession")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
