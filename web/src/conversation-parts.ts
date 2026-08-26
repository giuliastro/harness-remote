import type { MessagePart } from "./types"

export type ConversationPartGroup =
  | { kind: "content"; parts: MessagePart[] }
  | { kind: "activity"; parts: MessagePart[]; status: "running" | "completed" | "error" }

export type ConversationGroupingOptions = {
  forceActivity?: boolean
  forceRunning?: boolean
  /**
   * The turn this group belongs to has ended.
   *
   * Both rules below describe work in progress, and they read it off part metadata: a tool whose
   * state never reached a terminal value, a reasoning part with a start and no end. On a finished
   * turn that metadata is not progress, it is a gap in what the harness wrote - and Claude leaves
   * exactly that gap, because a thought is only closed by the next part in the same message, so a
   * turn whose last part is a thought never closes it. The Activity then said "Working" forever, on
   * a conversation that ended days ago.
   */
  turnCompleted?: boolean
}

export function isConversationActivityPart(part: MessagePart): boolean {
  return part.type === "reasoning" || part.type === "tool"
}

function activityStatus(
  parts: MessagePart[],
  forceRunning = false,
  turnCompleted = false
): "running" | "completed" | "error" {
  // A failed tool call is local technical activity, not the state of the whole assistant turn.
  // While the native Run is alive the Activity stays visibly Working; once the Run ends, the
  // individual tool card retains its error while the Activity itself can complete normally.
  // A real turn failure is rendered separately from message.info.error by TaskDeskMessageContent.
  if (forceRunning) return "running"
  // Nothing can still be running inside a turn that is over. The tool card keeps its own state.
  if (turnCompleted) return "completed"
  if (parts.some((part) => part.type === "tool" && part.state?.status && part.state.status !== "completed" && part.state.status !== "error")) return "running"
  if (parts.some((part) => part.type === "reasoning" && part.time?.start && !part.time.end)) return "running"
  return "completed"
}

/**
 * Preserve native wire order while keeping the visible conversation turn-based.
 *
 * Once a turn is complete, every text fragment before the final reasoning/tool part is working
 * narration and stays inside Activity; only terminal text is normal assistant dialogue. While the
 * Run is still active, all assistant output is Activity because no text chunk can safely be called
 * the final answer yet. That prevents streamed narration from jumping in and out of normal chat.
 */
export function groupConversationParts(parts: MessagePart[], options: ConversationGroupingOptions = {}): ConversationPartGroup[] {
  const groups: ConversationPartGroup[] = []
  const activityIndexes = parts.flatMap((part, index) => isConversationActivityPart(part) ? [index] : [])
  const lastActivity = activityIndexes.length ? activityIndexes[activityIndexes.length - 1] : -1

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    const workingText = part.type === "text" && lastActivity >= 0 && index < lastActivity
    const kind = options.forceActivity || isConversationActivityPart(part) || workingText ? "activity" : "content"
    const previous = groups[groups.length - 1]

    if (previous?.kind === kind) {
      previous.parts.push(part)
      if (previous.kind === "activity") previous.status = activityStatus(previous.parts, options.forceRunning, options.turnCompleted)
      continue
    }

    if (kind === "activity") groups.push({ kind, parts: [part], status: activityStatus([part], options.forceRunning, options.turnCompleted) })
    else groups.push({ kind, parts: [part] })
  }

  return groups
}

export function activityLabel(group: Extract<ConversationPartGroup, { kind: "activity" }>): string {
  const toolCount = group.parts.filter((part) => part.type === "tool").length
  const hasReasoning = group.parts.some((part) => part.type === "reasoning")
  const hasWorkingNotes = group.parts.some((part) => part.type === "text")
  const detail = [
    toolCount ? `${toolCount} tool${toolCount === 1 ? "" : "s"}` : "",
    hasReasoning ? "reasoning" : "",
    hasWorkingNotes ? "working notes" : ""
  ].filter(Boolean).join(" · ")

  return detail ? `Activity · ${detail}` : "Activity"
}
