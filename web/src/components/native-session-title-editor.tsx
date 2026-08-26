import { useEffect, useRef, useState } from "react"
import { api } from "../api"
import { LoadingIcon, PencilIcon } from "../Icons"
import type { NativeSessionSurfaceTarget } from "../native-session-discovery"
import type { Session } from "../types"
import { useTranslator } from "../useTranslator"

type Props = {
  target: NativeSessionSurfaceTarget
  /** False while the owning machine is unreachable: a rename cannot land, and offering it produces
   *  a network error where an explanation belongs. */
  machineOnline?: boolean
  onRenamed: (session: Session, title: string) => void
}

/**
 * The Session's title, edited where it is shown.
 *
 * Renaming used to open a modal panel with its own heading, subtitle, labelled field and two
 * buttons - four lines of chrome to change one line of text, anchored to a small icon button in the
 * corner and therefore prone to overflowing it. Editing in place is the same operation with none of
 * that: the heading becomes an input at the same size and position, Enter commits, Escape cancels.
 *
 * Delete keeps its confirmation. It is the one action here that cannot be undone.
 */
export function NativeSessionTitleEditor({ target, machineOnline = true, onRenamed }: Props) {
  const t = useTranslator()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Blur commits, but not when the user is leaving through Escape or the commit itself.
  const abandonRef = useRef(false)

  // Navigating to another Session must never leave a half-typed name pointing at it.
  useEffect(() => {
    setEditing(false)
    setBusy(false)
    setError(null)
  }, [target.key])

  useEffect(() => {
    if (!editing) return
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [editing])

  if (!target.renameSupported || !machineOnline) return <h1>{target.title}</h1>

  function begin() {
    setError(null)
    setTitle(target.title)
    abandonRef.current = false
    setEditing(true)
  }

  function cancel() {
    abandonRef.current = true
    setEditing(false)
    setError(null)
  }

  async function commit() {
    if (busy || abandonRef.current) return
    const next = title.replace(/[\r\n]+/g, " ").trim()
    if (!next) {
      setError(t("sf.enterSessionName"))
      inputRef.current?.focus()
      return
    }
    if (next === target.title) {
      cancel()
      return
    }
    setBusy(true)
    setError(null)
    try {
      const session = await api.renameSession(target.config, target.sessionID, next, target.directory)
      abandonRef.current = true
      setEditing(false)
      onRenamed(session, next)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      inputRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  if (!editing) {
    return (
      <h1 className="hr-session-title">
        <button
          type="button"
          className="hr-session-title-edit"
          onClick={begin}
          aria-label={t("sf.renameSessionInline", { title: target.title })}
          title={t("sf.renameSession")}
        >
          <span>{target.title}</span>
          <PencilIcon size={13} />
        </button>
      </h1>
    )
  }

  return (
    <h1 className="hr-session-title editing">
      <input
        ref={inputRef}
        className="hr-session-title-input"
        value={title}
        maxLength={200}
        disabled={busy}
        aria-label={t("sf.sessionName")}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "hr-session-title-error" : undefined}
        onChange={(event) => { setTitle(event.target.value); if (error) setError(null) }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); void commit() }
          else if (event.key === "Escape") { event.preventDefault(); cancel() }
        }}
      />
      {busy ? <LoadingIcon size={14} /> : null}
      {error ? <small className="hr-session-title-error" id="hr-session-title-error" role="alert">{error}</small> : null}
    </h1>
  )
}
