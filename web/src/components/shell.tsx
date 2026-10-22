import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { SearchIcon } from "../Icons"

export type PaletteCommand = {
  id: string
  group: string
  label: string
  hint?: string
  keywords?: string
  icon?: ReactNode
  disabled?: boolean
  run: () => void
}

/** Every character of the query has to appear in order somewhere in the haystack. Cheap, and it is
 *  what makes "nsd" find "New session in this directory" the way a developer expects. */
function fuzzyScore(haystack: string, query: string): number | null {
  if (!query) return 0
  let score = 0
  let cursor = 0
  for (const character of query) {
    const index = haystack.indexOf(character, cursor)
    if (index === -1) return null
    // Adjacent matches and matches at a word boundary are what the user meant; scattered ones
    // are a coincidence, and ranking has to be able to tell them apart.
    score += index === cursor ? 3 : haystack[index - 1] === " " ? 2 : 1
    cursor = index + 1
  }
  return score
}

/**
 * Ctrl/Cmd+K. Everything the menus can do, plus every open session, reachable by typing. This is
 * what keeps the app usable as it grows: a new capability becomes one more command rather than one
 * more button competing for room in the chrome.
 */
function finePointer(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches
}

export function CommandPalette({
  commands,
  placeholder,
  emptyLabel,
  navigateHint,
  runHint,
  closeHint,
  onClose
}: {
  commands: PaletteCommand[]
  placeholder: string
  emptyLabel: string
  navigateHint: string
  runHint: string
  closeHint: string
  onClose: () => void
}) {
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const matches = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return commands.filter((command) => !command.disabled)
    return commands
      .filter((command) => !command.disabled)
      .map((command) => ({
        command,
        score: fuzzyScore(`${command.group} ${command.label} ${command.keywords ?? ""} ${command.hint ?? ""}`.toLowerCase(), text)
      }))
      .filter((entry): entry is { command: PaletteCommand; score: number } => entry.score !== null)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.command)
  }, [commands, query])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  // The keyboard is the point of a palette, so the highlighted row has to stay on screen while
  // arrowing past the bottom of the list.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".palette-item.active")?.scrollIntoView({ block: "nearest" })
  }, [activeIndex, matches])

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActiveIndex((index) => (matches.length === 0 ? 0 : (index + 1) % matches.length))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setActiveIndex((index) => (matches.length === 0 ? 0 : (index - 1 + matches.length) % matches.length))
    } else if (event.key === "Enter") {
      event.preventDefault()
      const chosen = matches[activeIndex]
      if (chosen) {
        onClose()
        chosen.run()
      }
    } else if (event.key === "Escape") {
      event.preventDefault()
      onClose()
    }
  }

  let lastGroup: string | null = null

  return (
    <div className="palette-backdrop" role="presentation" onClick={onClose}>
      <section
        className="palette fade-in"
        role="dialog"
        aria-modal="true"
        aria-label={placeholder}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="palette-input-row">
          <SearchIcon size={18} />
          <input
            className="palette-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            // With a keyboard the palette is typed into at once. On touch, focusing would raise the
            // on-screen keyboard over the command list, so the list shows first and a tap focuses.
            autoFocus={finePointer()}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label={placeholder}
            aria-activedescendant={matches[activeIndex] ? `palette-${matches[activeIndex].id}` : undefined}
          />
        </div>
        <div className="palette-list" ref={listRef} role="listbox" aria-label={placeholder}>
          {matches.length === 0 ? (
            <p className="palette-empty subtle">{emptyLabel}</p>
          ) : (
            matches.map((command, index) => {
              const groupLabel = command.group !== lastGroup ? command.group : null
              lastGroup = command.group
              return (
                <div key={command.id}>
                  {groupLabel && <div className="menu-group-label">{groupLabel}</div>}
                  <button
                    type="button"
                    id={`palette-${command.id}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    className={`palette-item${index === activeIndex ? " active" : ""}`}
                    onPointerEnter={() => setActiveIndex(index)}
                    onClick={() => {
                      onClose()
                      command.run()
                    }}
                  >
                    {command.icon && <span className="palette-item-icon">{command.icon}</span>}
                    <span className="palette-item-label">{command.label}</span>
                    {command.hint && <span className="palette-item-hint">{command.hint}</span>}
                  </button>
                </div>
              )
            })
          )}
        </div>
        <div className="palette-footer">
          <span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> {navigateHint}</span>
          <span><kbd className="kbd">↵</kbd> {runHint}</span>
          <span><kbd className="kbd">esc</kbd> {closeHint}</span>
        </div>
      </section>
    </div>
  )
}
