import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import {
  buildActivityTimeline, currentStep, describeTool, formatSpan, isThoughtRunning, latestNote, spanMs, startedAt,
  summarizeActivity, toolKind, toolStatus, type ActivityItem, type ToolKind
} from "../activity-model"
import type { ActivityPreferences } from "../activity-preferences"
import type { ConversationPartGroup } from "../conversation-parts"
import type { Translator } from "../i18n"
import {
  AlertIcon, CheckIcon, ChevronDownIcon, CommandIcon, FolderIcon, PencilIcon, SearchIcon, ServerIcon, SparkIcon,
  TaskListIcon
} from "../Icons"
import type { MessagePart, TodoItem } from "../types"
import { useTranslator } from "../useTranslator"
import { CopyButton, Markdown } from "./message-markdown"

type ActivityGroupValue = Extract<ConversationPartGroup, { kind: "activity" }>

/** "Expand all" / "Collapse all" reaches every row through this: a new version is a new order. */
type DetailCommand = { open: boolean; version: number } | null

const OUTPUT_LIMIT = 4_000
/** A run of calls longer than this keeps only its tail on screen until asked: the newest steps are
 *  the ones a reader is looking for, and twenty identical rows bury the notes between them. */
const STEP_FOLD_THRESHOLD = 8
const STEP_FOLD_KEEP = 5

/**
 * Real icons rather than unicode glyphs: a borrowed character inherits the text metrics and renders
 * as a different shape on every platform - which on Android was a box. Colour stays reserved for
 * status; the kind is carried by the glyph alone.
 */
const KIND_ICON: Record<ToolKind, (props: { size?: number }) => JSX.Element> = {
  run: CommandIcon, read: FolderIcon, edit: PencilIcon, search: SearchIcon, web: ServerIcon,
  task: SparkIcon, todo: TaskListIcon, tool: SparkIcon
}

const COUNT_ORDER: ToolKind[] = ["run", "edit", "read", "search", "web", "task", "todo", "tool"]

function plural(t: Translator, key: string, count: number): string {
  return t(count === 1 ? `${key}.one` : key, { count })
}

/** MCP tools arrive as `mcp__server__do_thing`; the reader wants "do thing". */
function humanizeToolName(name: string): string {
  const bare = name.includes("__") ? name.split("__").pop() || name : name
  const spaced = bare.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim()
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : name
}

function toolVerb(t: Translator, kind: ToolKind, live: boolean, name: string): string {
  if (kind === "tool") return humanizeToolName(name)
  return t(`act.verb.${kind}.${live ? "live" : "done"}`)
}

function firstLine(value: string): string {
  return (value.split(/\r?\n/).find((line) => line.trim()) ?? "").trim()
}

function useElapsed(since: number | undefined, running: boolean): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running || !since) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [running, since])
  if (!running || !since) return ""
  const ms = now - since
  // A harness that reports seconds where the type says milliseconds would otherwise render a clock
  // reading in decades. Out of range means "no timestamp worth showing".
  return ms > 86_400_000 ? "" : formatSpan(Math.max(0, ms) < 2_000 ? undefined : ms)
}

function useDetailCommand(command: DetailCommand, apply: (open: boolean) => void): void {
  const applyRef = useRef(apply)
  applyRef.current = apply
  useEffect(() => {
    if (command) applyRef.current(command.open)
  }, [command])
}

function StatusGlyph({ status }: { status: string }) {
  return (
    <span className={`hr-act-glyph is-${status}`} aria-hidden="true">
      {status === "running" ? <span className="hr-act-spinner" />
        : status === "error" ? <AlertIcon size={12} />
          : status === "completed" ? <CheckIcon size={12} />
            : <span className="hr-act-dot" />}
    </span>
  )
}

function Chevron() {
  return <span className="hr-act-chevron" aria-hidden="true"><ChevronDownIcon size={14} /></span>
}

export function UnsupportedPart({ part }: { part: MessagePart }) {
  const label = part.filename || part.tool || part.type || "unknown"
  return <div className="uw-unsupported-part" title={`Unsupported message part: ${part.type}`}>{label}</div>
}

function parseTodos(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value)) return null
  const items = value.filter(
    (item): item is TodoItem => Boolean(item) && typeof item === "object" && typeof (item as TodoItem).content === "string"
  )
  return items.length ? items : null
}

function TodoListView({ items }: { items: TodoItem[] }) {
  return (
    <div className="hr-act-todos" aria-label="Todo list">
      {items.map((item, index) => (
        <div className={`hr-act-todo is-${item.status || "pending"}`} key={item.id || `${index}:${item.content}`}>
          <span aria-hidden="true">{item.status === "completed" ? "✓" : item.status === "in_progress" ? "◐" : "○"}</span>
          <span>{item.content}</span>
        </div>
      ))}
    </div>
  )
}

function EditDiff({ before, after }: { before: string; after: string }) {
  const lines = (text: string, sign: string) => text ? text.split(/\r?\n/).slice(0, 80).map((line) => `${sign} ${line}`) : []
  return (
    <pre className="hr-act-pre hr-act-diff">
      {lines(before, "-").map((line, index) => <span className="is-del" key={`d${index}`}>{line}{"\n"}</span>)}
      {lines(after, "+").map((line, index) => <span className="is-add" key={`a${index}`}>{line}{"\n"}</span>)}
    </pre>
  )
}

function ToolRow({ part, command }: { part: MessagePart; command: DetailCommand }) {
  const t = useTranslator()
  const state = part.state
  const status = toolStatus(part)
  const description = describeTool(part)
  const [open, setOpen] = useState(false)
  useDetailCommand(command, setOpen)

  const input = (state?.input && typeof state.input === "object" ? state.input : {}) as Record<string, unknown>
  const output = state?.error || state?.output || ""
  const todos = description.kind === "todo" ? parseTodos(input.todos) : null
  const showInput = !description.command && !description.edit && !todos
    && ["tool", "task", "web", "search"].includes(description.kind) && Object.keys(input).length > 0
  const hasBody = Boolean(output || todos || description.command || description.edit || showInput)
  const errorLine = status === "error" ? firstLine(state?.error || output) : ""
  const duration = formatSpan(spanMs([part]))
  const KindIcon = KIND_ICON[description.kind]
  const label = description.titleOnly
    ? description.name
    : toolVerb(t, description.kind, status === "running", description.name)

  return (
    <div className={`hr-act-tool is-${status} kind-${description.kind}${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="hr-act-tool-row"
        aria-expanded={hasBody ? open : undefined}
        disabled={!hasBody}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="hr-act-kind" aria-hidden="true"><KindIcon size={13} /></span>
        <span className="hr-act-tool-label">
          <span className="hr-act-tool-verb">{label}</span>
          {description.target && !description.titleOnly ? <code className="hr-act-tool-target">{description.target}</code> : null}
        </span>
        {status === "error" ? <span className="hr-act-badge is-error">{t("act.status.failed")}</span> : null}
        {status === "incomplete" ? <span className="hr-act-badge">{t("act.status.incomplete")}</span> : null}
        {duration ? <span className="hr-act-duration">{duration}</span> : null}
        {status === "running" ? <StatusGlyph status="running" /> : null}
        {hasBody ? <Chevron /> : <span className="hr-act-chevron" aria-hidden="true" />}
      </button>
      {errorLine && !open ? <div className="hr-act-tool-error">{errorLine}</div> : null}
      {open ? (
        <div className="hr-act-tool-body">
          {description.command ? (
            <div className="uw-code-block">
              <CopyButton text={description.command} label="Copy command" />
              <pre className="hr-act-pre hr-act-input">{description.command}</pre>
            </div>
          ) : null}
          {description.edit ? <EditDiff before={description.edit.before} after={description.edit.after} /> : null}
          {showInput ? <pre className="hr-act-pre hr-act-input">{JSON.stringify(input, null, 2).slice(0, 2_000)}</pre> : null}
          {todos ? <TodoListView items={todos} /> : null}
          {/* The truncated body is what is on screen, but the copy carries the whole output: a stack
              trace clipped at 4000 characters is the half you cannot paste anywhere useful. */}
          {output && !todos ? (
            <div className="uw-code-block">
              <CopyButton text={output} label="Copy output" />
              <pre className={`hr-act-pre hr-act-output${status === "error" ? " is-error" : ""}`}>
                {output.length > OUTPUT_LIMIT ? `${output.slice(0, OUTPUT_LIMIT)}\n…` : output}
              </pre>
              {output.length > OUTPUT_LIMIT ? <p className="hr-act-truncated">{t("act.outputTruncated", { count: OUTPUT_LIMIT.toLocaleString() })}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function StepList({ parts, command }: { parts: MessagePart[]; command: DetailCommand }) {
  const t = useTranslator()
  const [showAll, setShowAll] = useState(false)
  useDetailCommand(command, (open) => { if (open) setShowAll(true) })
  const hidden = !showAll && parts.length > STEP_FOLD_THRESHOLD ? parts.length - STEP_FOLD_KEEP : 0

  return (
    <div className="hr-act-steps">
      {hidden ? (
        <button type="button" className="hr-act-more" onClick={() => setShowAll(true)}>
          {plural(t, "act.showEarlier", hidden)}
        </button>
      ) : null}
      {parts.slice(hidden).map((part) => <ToolRow part={part} command={command} key={part.id} />)}
    </div>
  )
}

function ThoughtRow({ parts, startOpen, command }: { parts: MessagePart[]; startOpen: boolean; command: DetailCommand }) {
  const t = useTranslator()
  const running = isThoughtRunning(parts)
  const text = parts.map((part) => part.text?.trim() || "").filter(Boolean).join("\n\n")
  const [open, setOpen] = useState(startOpen)
  useEffect(() => setOpen(startOpen), [startOpen])
  useDetailCommand(command, setOpen)
  const duration = formatSpan(spanMs(parts))
  const label = running ? t("act.thinking") : duration ? t("act.thoughtFor", { duration }) : t("act.thought")
  // While the model is still thinking, the end of the stream is the news; once it is done, the
  // opening sentence is what says what the thought was about.
  const flat = text.replace(/\s+/g, " ").trim()
  const preview = open || !flat ? "" : running ? flat.slice(-140) : flat.slice(0, 140)

  return (
    <div className={`hr-act-thought${running ? " is-running" : ""}${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="hr-act-thought-row"
        aria-expanded={text ? open : undefined}
        disabled={!text}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="hr-act-kind" aria-hidden="true">{running ? <span className="hr-act-spinner" /> : <SparkIcon size={13} />}</span>
        <span className="hr-act-thought-label">{label}</span>
        {preview ? <span className="hr-act-thought-preview">{running ? "…" : ""}{preview}</span> : <span />}
        {text ? <Chevron /> : <span className="hr-act-chevron" aria-hidden="true" />}
      </button>
      {open && text ? <div className="hr-act-thought-body"><Markdown text={text} /></div> : null}
    </div>
  )
}

/** Memoised on the text: the live clock re-renders the section every second, and re-parsing every
 *  note's Markdown on each tick is the cost a long turn would feel. */
const Note = memo(function Note({ part }: { part: MessagePart }) {
  return <div className="hr-act-note"><Markdown text={part.text || ""} /></div>
}, (previous, next) => previous.part.text === next.part.text)

/** The newest update, clipped to its last few lines; the fade marks the clip only when there is one. */
function LatestNote({ part }: { part: MessagePart }) {
  const ref = useRef<HTMLDivElement>(null)
  const [clipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (element) setClipped(element.scrollHeight > element.clientHeight + 1)
  }, [part.text])
  return <div className={`hr-act-latest${clipped ? " is-clipped" : ""}`} ref={ref}><Note part={part} /></div>
}

function visibleItems(parts: MessagePart[], preferences: ActivityPreferences): ActivityItem[] {
  const items = buildActivityTimeline(parts)
  return preferences.reasoning === "hidden" ? items.filter((item) => item.kind !== "thought") : items
}

function Timeline({ items, preferences, command }: { items: ActivityItem[]; preferences: ActivityPreferences; command: DetailCommand }) {
  return (
    <div className="hr-act-timeline">
      {items.map((item) => {
        if (item.kind === "note") return <Note part={item.part} key={item.id} />
        if (item.kind === "thought") return <ThoughtRow parts={item.parts} startOpen={preferences.reasoning === "expanded"} command={command} key={item.id} />
        if (item.kind === "steps") return <StepList parts={item.parts} command={command} key={item.id} />
        return <UnsupportedPart part={item.part} key={item.id} />
      })}
    </div>
  )
}

/**
 * The agent's notes in order, with everything it did between two notes reduced to one chip. This is
 * the view for "tell me what happened" without the "show me how": the notes are the agent's own
 * account, and the chip is where the evidence is one tap away.
 */
function Highlights({ items, running, onOpen }: { items: ActivityItem[]; running: boolean; onOpen: () => void }) {
  const t = useTranslator()
  if (!items.some((item) => item.kind === "note")) return null
  const blocks: ReactNode[] = []
  let pending: ActivityItem[] = []
  const flush = (last: boolean) => {
    if (!pending.length) return
    const steps = pending.reduce((count, item) => count + (item.kind === "steps" ? item.parts.length : 0), 0)
    const thoughts = pending.filter((item) => item.kind === "thought").length
    const label = [steps ? plural(t, "act.steps", steps) : "", thoughts ? t("act.thought") : ""].filter(Boolean).join(" · ")
    blocks.push(
      <button type="button" className="hr-act-chip" onClick={onOpen} key={`chip:${pending[0].id}`}>
        {last && running ? <span className="hr-act-spinner" aria-hidden="true" /> : <Chevron />}
        <span>{label || t("act.steps.one")}</span>
      </button>
    )
    pending = []
  }
  for (const item of items) {
    if (item.kind === "note") {
      flush(false)
      blocks.push(<Note part={item.part} key={item.id} />)
    } else {
      pending.push(item)
    }
  }
  flush(true)
  return <div className="hr-act-highlights">{blocks}</div>
}

/**
 * What the turn did, by kind. Failed calls are deliberately not counted here: an agent's failed grep
 * or red test run is part of how it works, and it recovers on its own. A failure that matters ends
 * the turn, and that is reported under the answer rather than in this line.
 */
function summaryText(t: Translator, parts: MessagePart[]): string {
  const summary = summarizeActivity(parts)
  return COUNT_ORDER
    .filter((kind) => summary.counts[kind])
    .map((kind) => plural(t, `act.count.${kind}`, summary.counts[kind] ?? 0))
    .join(" · ")
}

/**
 * One turn's Activity: a single header line that always says what happened, and below it as much
 * detail as the reader's settings ask for - from nothing, through the agent's own notes, to every
 * step. Open, the header sticks to the top of the transcript so collapsing is one click away however
 * far the steps have pushed it, and a second Collapse waits at the bottom.
 */
export function ActivitySection({ group, preferences }: { group: ActivityGroupValue; preferences: ActivityPreferences }) {
  const t = useTranslator()
  const running = group.status === "running"
  const failed = group.status === "error"
  const defaultOpen = running ? preferences.live === "expanded" : failed || preferences.finished === "expanded"
  const [open, setOpen] = useState(defaultOpen)
  const [command, setCommand] = useState<DetailCommand>(null)
  const touched = useRef(false)
  const headRef = useRef<HTMLDivElement>(null)
  const preferencesKey = `${preferences.live}|${preferences.finished}`
  const appliedPreferences = useRef(preferencesKey)

  useEffect(() => {
    // A Settings change is a new instruction for every section; a phase change (the turn finishing)
    // is not, so a section the reader opened or closed by hand during the run stays as they left it.
    if (appliedPreferences.current !== preferencesKey) {
      appliedPreferences.current = preferencesKey
      touched.current = false
    }
    if (!touched.current) setOpen(defaultOpen)
  }, [defaultOpen, preferencesKey])

  const items = visibleItems(group.parts, preferences)
  const elapsed = useElapsed(startedAt(group.parts), running)
  const duration = formatSpan(summarizeActivity(group.parts).durationMs)
  const counts = summaryText(t, group.parts)
  const step = running ? currentStep(group.parts) : null
  const stepText = !step ? ""
    : step.kind === "thinking" ? t("act.thinking")
      : step.kind === "writing" ? t("act.writing")
        : (() => {
            const description = describeTool(step.part)
            if (description.titleOnly) return description.name
            const verb = toolVerb(t, toolKind(step.part), true, description.name)
            return description.target ? `${verb} ${description.target}` : verb
          })()
  const title = running ? t("act.working")
    : failed ? t("act.failed")
      : duration ? t("act.workedFor", { duration }) : t("act.worked")
  const collapsedView = running
    ? preferences.live === "latest" || preferences.live === "highlights" ? preferences.live : "none"
    : preferences.finished === "highlights" ? "highlights" : "none"
  const latest = collapsedView === "latest" ? latestNote(group.parts) : undefined
  const expandable = items.length > 0
  const detailed = items.some((item) => item.kind === "steps" || item.kind === "thought")

  function toggle(next = !open) {
    touched.current = true
    setOpen(next)
    if (!next) {
      // Collapsing from the bottom of a long section would leave the reader staring at whatever
      // came after it; bring the header back instead.
      window.requestAnimationFrame(() => headRef.current?.scrollIntoView({ block: "nearest" }))
    }
  }

  return (
    <section className={`hr-activity is-${group.status}${open ? " is-open" : ""}`} aria-label={t("act.label")}>
      {/* The sticky header's travel ends with this wrapper, so it never slides over the footer. */}
      <div className="hr-activity-frame">
      <div className="hr-activity-head" ref={headRef}>
        <button
          type="button"
          className="hr-activity-toggle"
          aria-expanded={expandable ? open : undefined}
          disabled={!expandable}
          onClick={() => toggle()}
        >
          <StatusGlyph status={group.status} />
          <span className="hr-activity-title">{title}</span>
          {stepText ? <span className="hr-activity-step">{stepText}</span> : null}
          {!stepText && counts ? <span className="hr-activity-counts">{counts}</span> : null}
          <span className="hr-activity-fill" />
          {elapsed ? <span className="hr-act-duration">{elapsed}</span> : null}
          {expandable ? <Chevron /> : null}
        </button>
        {open && detailed ? (
          <button
            type="button"
            className="hr-activity-all"
            onClick={() => setCommand((current) => ({ open: !current?.open, version: (current?.version ?? 0) + 1 }))}
          >
            {command?.open ? t("act.collapseAll") : t("act.expandAll")}
          </button>
        ) : null}
      </div>
      {open ? <Timeline items={items} preferences={preferences} command={command} /> : null}
      </div>
      {open && items.length > 3 ? (
        <button type="button" className="hr-activity-foot" onClick={() => toggle(false)}>
          <Chevron />
          <span>{t("act.collapse")}</span>
        </button>
      ) : null}
      {open ? null : collapsedView === "highlights" ? (
        <Highlights items={items} running={running} onOpen={() => toggle(true)} />
      ) : latest ? (
        <LatestNote part={latest} />
      ) : null}
    </section>
  )
}
