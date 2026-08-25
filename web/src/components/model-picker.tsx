import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDownIcon } from "../Icons"
import type { ModelOption } from "../types"
import "../model-picker.css"

type Props = {
  models: ModelOption[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  loading?: boolean
  placeholder?: string
  compact?: boolean
  /** Shown instead of the placeholder when discovery finished without a usable catalog. */
  unavailableHint?: string
}

type ModelGroup = {
  id: string
  providerID: string
  providerName: string
  modelID: string
  modelName: string
  description?: string
  base: ModelOption
  variants: ModelOption[]
  options: ModelOption[]
}
const MAX_VISIBLE_MODEL_GROUPS = 100


export function modelOptionKey(model: Pick<ModelOption, "providerID" | "modelID" | "variant">): string {
  return `${model.providerID}|${model.modelID}|${model.variant || ""}`
}

function formatLimit(value?: number): string {
  if (!Number.isFinite(value) || !value) return ""
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`
  return String(value)
}

function formatPrice(value?: number): string {
  if (!Number.isFinite(value)) return ""
  if (value === 0) return "$0"
  if (value! < 0.01) return `$${value!.toFixed(4)}`
  if (value! < 1) return `$${value!.toFixed(2)}`
  return `$${Math.round(value! * 100) / 100}`
}

function groupModels(models: ModelOption[]): ModelGroup[] {
  const groups = new Map<string, ModelOption[]>()
  for (const model of models) {
    const key = `${model.providerID}|${model.modelID}`
    const current = groups.get(key) || []
    if (!current.some((candidate) => modelOptionKey(candidate) === modelOptionKey(model))) current.push(model)
    groups.set(key, current)
  }

  return [...groups.entries()].map(([id, options]) => {
    const base = options.find((option) => !option.variant) || options.find((option) => option.isDefault) || options[0]
    const variants = options
      .filter((option) => Boolean(option.variant))
      .sort((left, right) => String(left.variant).localeCompare(String(right.variant)))
    return {
      id,
      providerID: base.providerID,
      providerName: base.providerName || base.providerID,
      modelID: base.modelID,
      modelName: base.modelName || base.modelID,
      description: base.description,
      base,
      variants,
      options
    }
  }).sort((left, right) => {
    const leftDefault = left.options.some((option) => option.isDefault) ? 0 : 1
    const rightDefault = right.options.some((option) => option.isDefault) ? 0 : 1
    if (leftDefault !== rightDefault) return leftDefault - rightDefault
    return left.providerName.localeCompare(right.providerName) || left.modelName.localeCompare(right.modelName)
  })
}

function ModelBadges({ group }: { group: ModelGroup }) {
  const metadata = group.options.find((option) => option.isDefault) || group.base
  const context = formatLimit(metadata.contextLimit)
  const inputCost = formatPrice(metadata.inputCost)
  const outputCost = formatPrice(metadata.outputCost)
  const explicitlyPaid = metadata.isFree === false || (Number(metadata.inputCost) > 0 || Number(metadata.outputCost) > 0)

  return (
    <span className="tdw-model-badges">
      {group.options.some((option) => option.isDefault) ? <b className="default">Default</b> : null}
      {metadata.isFree === true ? <b className="free">Free</b> : explicitlyPaid ? <b>Paid</b> : null}
      {metadata.status && metadata.status !== "active" ? <b>{metadata.status}</b> : null}
      {context ? <b>{context} ctx</b> : null}
      {inputCost || outputCost ? <b title="Catalog pricing">{inputCost || "?"} in · {outputCost || "?"} out</b> : null}
    </span>
  )
}

export function ModelPicker({ models, value, onChange, disabled = false, loading = false, placeholder = "Choose model", compact = false, unavailableHint }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [freeOnly, setFreeOnly] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const groups = useMemo(() => groupModels(models), [models])
  const freeCount = useMemo(
    () => groups.filter((group) => group.options.some((option) => option.isFree === true)).length,
    [groups]
  )
  const selected = models.find((model) => modelOptionKey(model) === value)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const candidates = freeOnly
      ? groups.filter((group) => group.options.some((option) => option.isFree === true))
      : groups
    if (!needle) return candidates
    return candidates.filter((group) => `${group.providerName} ${group.providerID} ${group.modelName} ${group.modelID} ${group.description || ""} ${group.variants.map((variant) => variant.variant).join(" ")}`.toLowerCase().includes(needle))
  }, [freeOnly, groups, query])
  const visibleGroups = useMemo(() => filtered.slice(0, MAX_VISIBLE_MODEL_GROUPS), [filtered])

  const providers = useMemo(() => {
    const result = new Map<string, ModelGroup[]>()
    for (const group of visibleGroups) {
      const key = group.providerName || group.providerID
      result.set(key, [...(result.get(key) || []), group])
    }
    return [...result.entries()]
  }, [visibleGroups])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!open) setQuery("")
  }, [open])
  useEffect(() => {
    if (freeOnly && freeCount === 0) setFreeOnly(false)
  }, [freeCount, freeOnly])


  function choose(next: ModelOption) {
    onChange(modelOptionKey(next))
    setOpen(false)
  }

  // A disabled control with a "Choose model" label reads as broken. When discovery finished and the
  // catalog is empty the conversation still starts — on the harness-native default — so say that
  // instead of leaving a dead dropdown with no explanation.
  const empty = !loading && models.length === 0
  const hint = unavailableHint || "No model catalog is available for this coding agent. The harness default will be used."
  const triggerLabel = loading
    ? "Loading models…"
    : empty
      ? "Harness default"
      : selected?.modelName || selected?.modelID || placeholder

  return (
    <div className={`tdw-model-picker${compact ? " compact" : ""}${open ? " open" : ""}${empty ? " unavailable" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="tdw-model-trigger"
        disabled={disabled || loading || empty}
        title={empty ? hint : undefined}
        onClick={(event) => {
          event.preventDefault()
          setOpen((current) => !current)
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="tdw-model-trigger-copy">
          <strong>{triggerLabel}</strong>
          {!loading && selected ? <small>{selected.providerName || selected.providerID}{selected.variant ? ` · ${selected.variant}` : ""}</small> : null}
          {empty ? <small>Chosen by the coding agent</small> : null}
        </span>
        <span className="tdw-model-chevron" aria-hidden="true"><ChevronDownIcon size={13} /></span>
      </button>

      {open ? (
        <div className="tdw-model-popover" role="listbox" aria-label="Models">
          <div className="tdw-model-search-wrap">
            <span aria-hidden="true">⌕</span>
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search model, provider, variant…" spellCheck={false} />
            <kbd>{filtered.length}</kbd>
          </div>
          {freeCount > 0 ? (
            <div className="tdw-model-filter-row">
              <button type="button" className={freeOnly ? "active" : ""} onClick={() => setFreeOnly((current) => !current)} aria-pressed={freeOnly}>
                Free <b>{freeCount}</b>
              </button>
              <span>{freeOnly ? "Showing catalog-confirmed free models" : "Free and paid models"}</span>
            </div>
          ) : null}
          <div className="tdw-model-results">
            {providers.length === 0 ? <div className="tdw-model-empty"><strong>No models found</strong><span>Try another model name, provider or variant.</span></div> : providers.map(([provider, providerModels]) => (
              <section className="tdw-model-provider" key={provider}>
                <header><strong>{provider}</strong><span>{providerModels.length} model{providerModels.length === 1 ? "" : "s"}</span></header>
                {providerModels.map((group) => {
                  const baseSelected = selected && selected.providerID === group.providerID && selected.modelID === group.modelID && !selected.variant
                  return (
                    <div className={`tdw-model-row${selected && selected.providerID === group.providerID && selected.modelID === group.modelID ? " selected-family" : ""}`} key={group.id}>
                      <button
                        type="button"
                        className={`tdw-model-main${baseSelected ? " selected" : ""}`}
                        onClick={(event) => {
                          event.preventDefault()
                          choose(group.base)
                        }}
                      >
                        <span className="tdw-model-copy">
                          <span className="tdw-model-name"><strong>{group.modelName}</strong><code>{group.modelID}</code></span>
                          {group.description ? <small>{group.description}</small> : null}
                          <ModelBadges group={group} />
                        </span>
                        <span className="tdw-model-check" aria-hidden="true">{baseSelected ? "✓" : ""}</span>
                      </button>
                      {group.variants.length ? (
                        <div className="tdw-model-variants" aria-label={`${group.modelName} variants`}>
                          <span>Reasoning / variant</span>
                          {group.variants.map((variant) => (
                            <button
                              type="button"
                              className={modelOptionKey(variant) === value ? "selected" : ""}
                              onClick={(event) => {
                                event.preventDefault()
                                choose(variant)
                              }}
                              key={modelOptionKey(variant)}
                            >
                              {variant.variant}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </section>
            ))}
          </div>
          <footer>
            Showing {visibleGroups.length}{visibleGroups.length < filtered.length ? ` of ${filtered.length}` : ""} base models from {providers.length} provider{providers.length === 1 ? "" : "s"}.
            {visibleGroups.length < filtered.length ? " Refine the search to see more." : " Variants stay grouped with their model."}
          </footer>
        </div>
      ) : null}
    </div>
  )
}
