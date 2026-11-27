import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../api"
import { ChevronDownIcon } from "../Icons"
import type { ServerConfig, SessionMode, SessionModeState } from "../types"
import { useTranslator } from "../useTranslator"
import "../session-mode-control.css"

type SessionModeTarget = {
  config: ServerConfig
  agentID: string
  sessionID: string
  directory?: string
}

export type SessionModes = {
  state: SessionModeState | null
  /** True while the modes are being read for the picker or a switch is in flight. */
  busy: boolean
  error: string | null
  current: SessionMode | undefined
  /** Re-read the current mode without opening the Session on the bridge. */
  refresh: () => Promise<void>
  /** The user opened the picker: open the Session if its modes are not known yet. */
  open: () => Promise<void>
  select: (modeId: string) => Promise<void>
}

/**
 * The selected Session's harness modes. A mode is the harness's own state, so this never keeps a
 * preference of its own: it shows what the bridge reports and asks the bridge to switch.
 */
export function useSessionModes(target: SessionModeTarget | undefined): SessionModes {
  const [state, setState] = useState<SessionModeState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const targetRef = useRef(target)
  targetRef.current = target
  const generation = useRef(0)
  const key = target ? `${target.agentID}\n${target.sessionID}\n${target.directory ?? ""}` : ""

  const read = useCallback(async (openSession: boolean) => {
    const current = targetRef.current
    if (!current) return
    const id = generation.current
    try {
      const next = await api.loadSessionModes(current.config, current.sessionID, current.directory, openSession)
      if (generation.current !== id) return
      setState(next)
      setError(null)
    } catch (reason) {
      if (generation.current !== id) return
      // A background refresh that fails keeps the last known mode; only an explicit open reports it.
      if (openSession) setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  useEffect(() => {
    generation.current += 1
    setState(null)
    setError(null)
    setBusy(false)
    if (key) void read(false)
  }, [key, read])

  const refresh = useCallback(() => read(false), [read])

  const open = useCallback(async () => {
    if (state?.loaded) return
    setBusy(true)
    try {
      await read(true)
    } finally {
      setBusy(false)
    }
  }, [read, state?.loaded])

  const select = useCallback(async (modeId: string) => {
    const current = targetRef.current
    if (!current) return
    const id = generation.current
    setBusy(true)
    setError(null)
    try {
      const next = await api.setSessionMode(current.config, current.sessionID, modeId, current.directory)
      if (generation.current === id) setState(next)
    } catch (reason) {
      if (generation.current === id) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (generation.current === id) setBusy(false)
    }
  }, [])

  const current = state?.modes.find((mode) => mode.id === state.currentModeId)
  return { state, busy, error, current, refresh, open, select }
}

/**
 * The modes as a list of choices. A mode that removes every approval needs a second tap, so a stray
 * tap on a phone cannot turn approvals off.
 */
export function SessionModeList({ modes, disabled = false, onChosen }: {
  modes: SessionModes
  disabled?: boolean
  onChosen?: () => void
}) {
  const t = useTranslator()
  const [confirming, setConfirming] = useState<string | null>(null)
  const { state, busy, error } = modes

  useEffect(() => setConfirming(null), [state?.currentModeId])

  if (!state?.loaded && busy) return <p className="tdw-mode-note" role="status">{t("mode.loading")}</p>
  if (state?.loaded && state.modes.length === 0) return <p className="tdw-mode-note">{t("mode.none")}</p>

  return (
    <div className="tdw-mode-list" role="radiogroup" aria-label={t("mode.title")}>
      {state?.modes.map((mode) => {
        const selected = mode.id === state.currentModeId
        const pending = confirming === mode.id
        return (
          <button
            key={mode.id}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`tdw-mode-option${selected ? " selected" : ""}${mode.unrestricted ? " unrestricted" : ""}${pending ? " confirming" : ""}`}
            disabled={disabled || busy}
            onClick={() => {
              if (selected) {
                onChosen?.()
                return
              }
              if (mode.unrestricted && !pending) {
                setConfirming(mode.id)
                return
              }
              setConfirming(null)
              void modes.select(mode.id).then(() => onChosen?.())
            }}
          >
            <span className="tdw-mode-option-radio" aria-hidden="true" />
            <span className="tdw-mode-option-text">
              <strong>{mode.name}</strong>
              {pending
                ? <small className="tdw-mode-option-warning">{t("mode.confirmUnrestricted", { mode: mode.name })}</small>
                : mode.description ? <small>{mode.description}</small> : null}
            </span>
          </button>
        )
      })}
      {error ? <p className="tdw-mode-error" role="alert">{t("mode.failed", { error })}</p> : null}
    </div>
  )
}

/** Desktop toolbar control: the current mode, opening the list as a popover. */
export function SessionModeMenu({ modes, disabled = false }: { modes: SessionModes; disabled?: boolean }) {
  const t = useTranslator()
  const [open, setOpen] = useState(false)
  const { current, state } = modes

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  // A loaded Session whose harness advertises no modes has nothing to show here.
  if (state?.loaded && state.modes.length === 0) return null

  return (
    <div className={`tdw-mode-control${current?.unrestricted ? " unrestricted" : ""}`}>
      <span className="tdw-mode-control-label">{t("mode.label")}</span>
      <button
        type="button"
        className="tdw-mode-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={current?.description || t("mode.title")}
        disabled={disabled}
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) void modes.open()
        }}
      >
        <span>{current?.name ?? t("mode.unknown")}</span>
        <ChevronDownIcon size={12} />
      </button>
      {open ? (
        <>
          <button type="button" className="tdw-mode-backdrop" aria-label={t("action.close")} onClick={() => setOpen(false)} />
          <div className="tdw-mode-popover" role="dialog" aria-label={t("mode.title")}>
            <SessionModeList modes={modes} disabled={disabled} onChosen={() => setOpen(false)} />
          </div>
        </>
      ) : null}
    </div>
  )
}
