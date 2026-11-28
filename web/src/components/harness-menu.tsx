import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { harnessIconUrl } from "../harness-icons"
import type { MachineAgentHost } from "../types"
import { useTranslator } from "../useTranslator"

/**
 * Desktop harness picker for the Session toolbar. It replaces the operating system's select menu,
 * which looked nothing like the Mode and Model popovers beside it: the panel and the options reuse the
 * Mode menu's classes, with each harness's logo. The trigger is a transparent button laid over the
 * whole field, so the field keeps the look the toolbar gives it and opens from anywhere in it.
 * Phones keep the native select next to it (this component is hidden there).
 */
export function HarnessMenu({
  agents,
  value,
  label,
  disabled = false,
  onChange
}: {
  agents: MachineAgentHost[]
  value: string
  label: string
  disabled?: boolean
  onChange: (agentID: string) => void
}) {
  const t = useTranslator()
  const [open, setOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const current = agents.find((agent) => agent.id === value)

  useEffect(() => {
    if (!open) return
    // Start on the chosen harness so Enter keeps it and the arrows move from there.
    const options = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? [])]
    ;(options.find((option) => option.getAttribute("aria-selected") === "true") ?? options[0])?.focus()
  }, [open])

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      close(true)
      return
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return
    event.preventDefault()
    const options = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? [])]
    const index = options.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === "Home" ? 0
      : event.key === "End" ? options.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length
    options[next]?.focus()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="tdw-harness-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current?.label ?? value}`}
        disabled={disabled || agents.length === 0}
        onClick={() => setOpen((next) => !next)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault()
            setOpen(true)
          }
        }}
      />
      {open ? (
        <>
          <button type="button" className="tdw-mode-backdrop" aria-label={t("action.close")} onClick={() => close(false)} />
          {/* The menu sits inside the field's <label>: a click on its padding must not reach the
              label, which would re-activate the trigger and reopen it. */}
          <div className="tdw-mode-popover tdw-harness-popover" onClick={(event) => event.preventDefault()}>
            <div ref={listRef} className="tdw-mode-list" role="listbox" aria-label={label} onKeyDown={onListKey}>
              {agents.map((agent) => {
                const selected = agent.id === value
                const icon = harnessIconUrl(agent.backend)
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    key={agent.id}
                    className={`tdw-mode-option tdw-harness-option${selected ? " selected" : ""}`}
                    onClick={() => {
                      if (!selected) onChange(agent.id)
                      close(true)
                    }}
                  >
                    <span className="tdw-harness-option-icon" aria-hidden="true">
                      {icon ? <img src={icon} alt="" /> : agent.label.slice(0, 2)}
                    </span>
                    <span className="tdw-mode-option-text">
                      <strong>{agent.label}</strong>
                    </span>
                    <span className="tdw-harness-option-check" aria-hidden="true" />
                  </button>
                )
              })}
            </div>
          </div>
        </>
      ) : null}
    </>
  )
}
