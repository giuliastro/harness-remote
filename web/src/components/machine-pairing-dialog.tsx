import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { MachineHttpError } from "../machine-request-error"
import { readMachinePairingGrantStatus, requestMachinePairingGrant } from "../machineClient"
import type { MachinePairingGrant } from "../machine-pairing"
import { pairingQRCode } from "../pairing-qr"
import { useDialogDismiss } from "../useDialogDismiss"
import { useTranslator } from "../useTranslator"
import type { WorkspaceMachine } from "../workspaceMachines"

/** How often the dialog asks the daemon whether the code was claimed or expired. Two seconds keeps
 *  the confirmation feeling immediate without turning a five-minute dialog into a polling loop. */
export const PAIRING_STATUS_POLL_MS = 2_000

export type MachinePairingDialogState =
  | { phase: "preparing" }
  | { phase: "ready"; grant: MachinePairingGrant; endpoint: string }
  | { phase: "claimed"; grant: MachinePairingGrant }
  | { phase: "expired"; grant: MachinePairingGrant }
  | { phase: "loopback" }
  | { phase: "no-address" }
  | { phase: "unsupported" }
  | { phase: "failed"; detail: string }

/** Countdown text for the pairing dialog: M:SS, clamped at zero so an expired code never renders
 *  negative time while the next status poll catches up. */
export function pairingCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

/** A regenerate that arrives after the user picked an address must keep that address selected; a
 *  pickup that the fresh grant no longer offers falls back to the daemon's first choice. */
export function preferredPairingEndpoint(grant: MachinePairingGrant, previous: string | null): string | null {
  if (!grant.links.length) return null
  return previous && grant.links.some((link) => link.endpoint === previous) ? previous : grant.links[0].endpoint
}

/** Distinguish "this daemon predates the grant route" from "the request failed". An old daemon
 *  answers 404 (no route) or 405 (route exists without POST); both mean the same thing to a user:
 *  update the daemon instead of retrying the same code. */
export function pairingFailureState(reason: unknown): MachinePairingDialogState {
  if (reason instanceof MachineHttpError && (reason.status === 404 || reason.status === 405)) {
    return { phase: "unsupported" }
  }
  const detail = reason instanceof Error && reason.message ? reason.message : "The pairing request failed."
  return { phase: "failed", detail }
}

/**
 * The phone pairing QR a Machine card can open.
 *
 * The daemon hands the authenticated client one-time URIs; this dialog renders the selected one as
 * a QR, counts down its five-minute life, polls the daemon for a claim, and explains the cases where
 * no QR can work at all: a loopback-bound daemon no phone can reach, a daemon too old to know the
 * grant route, and a machine with no address a phone could use.
 *
 * A loopback-bound *desktop-local* runtime is not a dead end the user has to solve in a terminal:
 * when the caller passes `onOpenSettings`, the explanation offers the jump to this computer's
 * settings where LAN pairing can be switched on in place.
 */
export function MachinePairingDialog({ machine, onClose, onOpenSettings }: { machine: WorkspaceMachine; onClose: () => void; onOpenSettings?: () => void }) {
  const t = useTranslator()
  const [state, setState] = useState<MachinePairingDialogState>({ phase: "preparing" })
  const [now, setNow] = useState(() => Date.now())
  const [selectedEndpoint, setSelectedEndpoint] = useState<string | null>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const issueRun = useRef(0)
  const started = useRef(false)
  useDialogDismiss(dialogRef, onClose)

  const issue = useCallback(async () => {
    const run = ++issueRun.current
    setState({ phase: "preparing" })
    try {
      const grant = await requestMachinePairingGrant(machine.config)
      if (issueRun.current !== run) return
      if (grant.loopbackOnly) {
        setState({ phase: "loopback" })
        return
      }
      const endpoint = preferredPairingEndpoint(grant, selectedEndpoint)
      if (!endpoint) {
        setState({ phase: "no-address" })
        return
      }
      setSelectedEndpoint(endpoint)
      setState({ phase: "ready", grant, endpoint })
    } catch (reason) {
      if (issueRun.current !== run) return
      setState(pairingFailureState(reason))
    }
  }, [machine.config, selectedEndpoint])

  // The initial grant is issued exactly once. Regenerate goes through the button, so StrictMode's
  // double effect must not issue two grants where the user asked for one.
  const issueRef = useRef(issue)
  issueRef.current = issue
  useEffect(() => {
    if (started.current) return
    started.current = true
    void issueRef.current()
  }, [])

  const ready = state.phase === "ready"
  useEffect(() => {
    if (!ready) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [ready])

  const expiresAt = state.phase === "ready" ? state.grant.expiresAt : null
  useEffect(() => {
    if (expiresAt === null) return
    // Only the daemon decides claimed/expired: the local countdown is presentation, and a failed
    // poll is transient noise that must not replace the QR with an error.
    let active = true
    const poll = () => {
      void readMachinePairingGrantStatus(machine.config).then((status) => {
        if (!active) return
        setState((current) => {
          if (current.phase !== "ready" || current.grant.expiresAt !== expiresAt) return current
          if (status.claimed) return { phase: "claimed", grant: current.grant }
          if (status.expired) return { phase: "expired", grant: current.grant }
          return current
        })
      }).catch(() => undefined)
    }
    const timer = window.setInterval(poll, PAIRING_STATUS_POLL_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [expiresAt, machine.config])

  const qr = useMemo(() => {
    if (state.phase !== "ready") return null
    const link = state.grant.links.find((candidate) => candidate.endpoint === state.endpoint) ?? state.grant.links[0]
    return pairingQRCode(link.uri)
  }, [state])

  return (
    <div className="uw-machine-pairing-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="uw-machine-pairing-card"
        role="dialog"
        aria-modal="true"
        aria-label={t("pair.title")}
        data-machine-pairing-dialog
        data-machine-pairing-phase={state.phase}
        ref={dialogRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="uw-machine-pairing-header">
          <div>
            <h3>{t("pair.title")}</h3>
            <p>{t("pair.subtitle", { name: machine.name })}</p>
          </div>
          <button type="button" className="uw-manager-close" onClick={onClose} aria-label={t("sf.close")}>×</button>
        </header>
        <div className="uw-machine-pairing-body">
          {state.phase === "preparing" ? (
            <p className="uw-machine-pairing-status" role="status" data-machine-pairing-preparing>{t("pair.issuing")}</p>
          ) : null}
          {state.phase === "ready" ? (
            <div className="uw-machine-pairing-ready">
              {qr ? (
                <svg
                  className="uw-machine-pairing-qr"
                  data-machine-pairing-qr
                  viewBox={`0 0 ${qr.size} ${qr.size}`}
                  role="img"
                  aria-label={t("pair.qrLabel")}
                >
                  <path d={qr.path} />
                </svg>
              ) : (
                <p role="alert">{t("pair.qrUnavailable")}</p>
              )}
              {state.grant.links.length > 1 ? (
                <label className="uw-machine-pairing-address">
                  <span>{t("pair.address")}</span>
                  <select
                    data-machine-pairing-address
                    value={state.endpoint}
                    onChange={(event) => {
                      setSelectedEndpoint(event.target.value)
                      setState({ ...state, endpoint: event.target.value })
                    }}
                  >
                    {state.grant.links.map((link) => <option value={link.endpoint} key={link.endpoint}>{link.endpoint}</option>)}
                  </select>
                </label>
              ) : null}
              <small className="uw-machine-pairing-countdown" data-machine-pairing-countdown>
                {t("pair.expiresIn", { time: pairingCountdown(state.grant.expiresAt - now) })}
              </small>
              <small className="uw-machine-pairing-hint">{t("pair.replaceHint")}</small>
            </div>
          ) : null}
          {state.phase === "claimed" ? (
            <div className="uw-machine-pairing-result success" role="status" data-machine-pairing-claimed>
              <strong>{t("pair.claimedTitle")}</strong>
              <span>{t("pair.claimedBody", { name: machine.name })}</span>
            </div>
          ) : null}
          {state.phase === "expired" ? (
            <div className="uw-machine-pairing-result" data-machine-pairing-expired>
              <strong>{t("pair.expiredTitle")}</strong>
              <span>{t("pair.expiredBody")}</span>
            </div>
          ) : null}
          {state.phase === "loopback" ? (
            <div className="uw-machine-pairing-result" data-machine-pairing-loopback>
              <strong>{t("pair.loopbackTitle")}</strong>
              <span>{t("pair.loopbackBody")}</span>
              {onOpenSettings ? <span data-machine-pairing-loopback-local>{t("pair.loopbackLocalHint")}</span> : null}
            </div>
          ) : null}
          {state.phase === "no-address" ? (
            <div className="uw-machine-pairing-result" data-machine-pairing-no-address>
              <strong>{t("pair.noAddressTitle")}</strong>
              <span>{t("pair.noAddressBody")}</span>
            </div>
          ) : null}
          {state.phase === "unsupported" ? (
            <div className="uw-machine-pairing-result" data-machine-pairing-unsupported>
              <strong>{t("pair.unsupportedTitle")}</strong>
              <span>{t("pair.unsupportedBody", { name: machine.name })}</span>
            </div>
          ) : null}
          {state.phase === "failed" ? (
            <div className="uw-machine-pairing-result error" role="alert" data-machine-pairing-failed>
              <strong>{t("pair.failedTitle")}</strong>
              <span>{state.detail}</span>
            </div>
          ) : null}
        </div>
        <footer className="uw-machine-pairing-actions">
          {state.phase === "ready" || state.phase === "expired" ? (
            <button type="button" className="uw-manager-button" data-machine-pairing-regenerate onClick={() => void issue()}>
              {t("pair.regenerate")}
            </button>
          ) : null}
          {state.phase === "claimed" ? (
            <button type="button" className="uw-manager-button" data-machine-pairing-another onClick={() => void issue()}>
              {t("pair.pairAnother")}
            </button>
          ) : null}
          {state.phase === "loopback" && onOpenSettings ? (
            <button type="button" className="uw-manager-button" data-machine-pairing-open-settings onClick={onOpenSettings}>
              {t("pair.loopbackLocalAction")}
            </button>
          ) : null}
          {state.phase === "loopback" || state.phase === "no-address" || state.phase === "unsupported" || state.phase === "failed" ? (
            <button type="button" className="uw-manager-button" data-machine-pairing-retry onClick={() => void issue()}>
              {t("pair.retry")}
            </button>
          ) : null}
          <button type="button" className="uw-manager-button primary" onClick={onClose}>{t("sf.close")}</button>
        </footer>
      </section>
    </div>
  )
}
