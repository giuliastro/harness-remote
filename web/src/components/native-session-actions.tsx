import { useEffect, useRef, useState } from "react"
import { api } from "../api"
import { LoadingIcon, PencilIcon, TrashIcon } from "../Icons"
import type { NativeSessionSurfaceTarget } from "../native-session-discovery"
import type { Session } from "../types"
import { useDialogDismiss } from "../useDialogDismiss"

/**
 * Rename and Delete belong to the Session that is open, not to the navigation list.
 *
 * Keeping them in the sidebar heading meant the two most consequential Session actions were
 * detached from the Session they act on: the buttons appeared next to New Session, changed meaning
 * with every selection, and were invisible while the phone showed only the chat. They now live in
 * the chat header of the open Session and mutate the real native Session through its owning harness.
 */
type Props = {
  target: NativeSessionSurfaceTarget
  onRenamed: (session: Session, title: string) => void
  onDeleted: (key: string) => void
}

export function NativeSessionActions({ target, onRenamed, onDeleted }: Props) {
  const [mode, setMode] = useState<"rename" | "delete" | null>(null)
  const [title, setTitle] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const renameRef = useRef<HTMLDivElement>(null)
  const deleteRef = useRef<HTMLDivElement>(null)

  // Switching Session must never leave a half-typed rename, or a primed deletion, pointing at the
  // Session the user just navigated to.
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

  // Each panel owns its own dismissal instance, so Escape, the Tab trap and focus restoration
  // follow the panel that is actually open.
  useDialogDismiss(renameRef, close, { enabled: mode === "rename" })
  useDialogDismiss(deleteRef, close, { enabled: mode === "delete" })

  if (!target.renameSupported && !target.deleteSupported) return null

  function beginRename() {
    if (busy) return
    setError(null)
    setTitle(target.title === "Untitled Session" ? "" : target.title)
    setMode("rename")
  }

  function beginDelete() {
    if (busy) return
    setError(null)
    setMode("delete")
  }

  async function renameSession() {
    if (busy) return
    const nextTitle = title.replace(/[\r\n]+/g, " ").trim()
    if (!nextTitle) {
      setError("Enter a Session name.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const session = await api.renameSession(target.config, target.sessionID, nextTitle, target.directory)
      setMode(null)
      onRenamed(session, nextTitle)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
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
      {target.renameSupported ? (
        <button
          type="button"
          className="tdw-icon-button"
          onClick={beginRename}
          disabled={busy}
          aria-expanded={mode === "rename"}
          aria-label="Rename Session"
          title="Rename Session"
        >
          <PencilIcon size={15} />
        </button>
      ) : null}
      {target.deleteSupported ? (
        <button
          type="button"
          className="tdw-icon-button hr-session-action-danger"
          onClick={beginDelete}
          disabled={busy}
          aria-expanded={mode === "delete"}
          aria-label="Delete Session"
          title="Delete Session"
        >
          <TrashIcon size={15} />
        </button>
      ) : null}

      {mode ? <div className="hr-session-action-backdrop" role="presentation" onMouseDown={close} /> : null}

      {mode === "rename" ? (
        <div className="hr-session-action-panel" role="dialog" aria-modal="true" aria-label="Rename Session" ref={renameRef}>
          <div className="hr-session-action-heading">
            <div>
              <strong>Rename Session</strong>
              <small>Changes the native harness Session name, not a Harness Remote alias.</small>
            </div>
            <button type="button" className="tdw-icon-button" data-dismiss="session-actions" onClick={close} disabled={busy} aria-label="Close Rename Session">×</button>
          </div>
          <label className="hr-session-action-field">
            <span>Session name</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={busy}
              maxLength={200}
              data-autofocus
              onKeyDown={(event) => { if (event.key === "Enter") void renameSession() }}
            />
          </label>
          {error ? <div className="hr-session-action-error" role="alert">{error}</div> : null}
          <div className="hr-session-action-buttons">
            <button type="button" className="tdw-button secondary" onClick={close} disabled={busy}>Cancel</button>
            <button type="button" className="tdw-button primary" onClick={() => void renameSession()} disabled={busy || !title.trim()}>
              {busy ? <LoadingIcon size={15} /> : null}
              {busy ? "Renaming..." : "Rename"}
            </button>
          </div>
        </div>
      ) : null}

      {mode === "delete" ? (
        <div className="hr-session-action-panel" role="dialog" aria-modal="true" aria-label="Delete Session" ref={deleteRef}>
          <div className="hr-session-action-heading">
            <div>
              <strong>Delete “{target.title}”?</strong>
              <small>This deletes the native Session from {target.agentLabel}. This cannot be undone from Harness Remote.</small>
            </div>
            <button type="button" className="tdw-icon-button" data-dismiss="session-actions" onClick={close} disabled={busy} aria-label="Close Delete Session">×</button>
          </div>
          {error ? <div className="hr-session-action-error" role="alert">{error}</div> : null}
          <div className="hr-session-action-buttons">
            <button type="button" className="tdw-button secondary" data-autofocus onClick={close} disabled={busy}>Keep Session</button>
            <button type="button" className="tdw-button danger" onClick={() => void deleteSession()} disabled={busy}>
              {busy ? <LoadingIcon size={15} /> : null}
              {busy ? "Deleting..." : "Delete Session"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
