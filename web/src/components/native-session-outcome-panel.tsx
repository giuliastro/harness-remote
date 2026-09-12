import { useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import type { ConversationRuntime } from "../conversation-runtime"
import { listMachineProjects } from "../machineClient"
import { resolveSourceSessionProject } from "../cross-machine-route-projects"
import type { NativeSessionSurfaceTarget } from "../native-session-discovery"
import {
  nativeSessionReviewEvidence,
  type NativeSessionReviewAttention
} from "../native-session-review-evidence"
import {
  loadMachineProjectOutcome,
  type MachineProjectOutcome,
  type MachineProjectOutcomeFile
} from "../project-outcome-client"
import "../native-session-outcome.css"

const MAX_VISIBLE_FILES = 12
const UNKNOWN_ATTENTION: NativeSessionReviewAttention = { complete: false, questions: 0, permissions: 0 }

type Props = {
  target: NativeSessionSurfaceTarget
  conversation: ConversationRuntime
  working: boolean
  interactionEnabled?: boolean
  onConnectionIssue?: () => void
}

type ProjectOutcomeView = {
  projectName: string
  outcome: MachineProjectOutcome
}

type OutcomeView = {
  project?: ProjectOutcomeView
  attention: NativeSessionReviewAttention
}

function connectionFailure(reason: unknown): boolean {
  return /cannot reach|timed out|network|connection|failed to fetch/i.test(reason instanceof Error ? reason.message : String(reason))
}

function fileStatus(file: MachineProjectOutcomeFile): string {
  const status = `${file.indexStatus}${file.worktreeStatus}`
  if (status === "??") return "Untracked"
  if (status.includes("U")) return "Conflict"
  if (status.includes("R")) return "Renamed"
  if (status.includes("C")) return "Copied"
  if (status.includes("D")) return "Deleted"
  if (status.includes("A")) return "Added"
  if (status.includes("M")) return "Modified"
  return "Changed"
}

function fileLabel(file: MachineProjectOutcomeFile): string {
  return file.originalPath ? `${file.originalPath} → ${file.path}` : file.path
}

function outcomeState(outcome: MachineProjectOutcome): string {
  if (outcome.dirty === true) return "Dirty"
  if (outcome.dirty === false) return "Clean"
  return "Worktree unverified"
}

async function loadProjectOutcome(target: NativeSessionSurfaceTarget): Promise<ProjectOutcomeView | null> {
  const projects = await listMachineProjects(target.config)
  const projectRoute = resolveSourceSessionProject(target, projects)
  if (!projectRoute || projectRoute.kind !== "git") return null
  const outcome = await loadMachineProjectOutcome(target.config, projectRoute.id)
  return outcome ? { projectName: projectRoute.name, outcome } : null
}

async function loadAttentionEvidence(target: NativeSessionSurfaceTarget): Promise<NativeSessionReviewAttention> {
  const [questionResult, permissionResult] = await Promise.all([
    api.loadQuestions(target.config, target.directory)
      .then((value) => ({ ok: true as const, value }), (reason) => ({ ok: false as const, reason })),
    api.loadPermissions(target.config, target.directory)
      .then((value) => ({ ok: true as const, value }), (reason) => ({ ok: false as const, reason }))
  ])
  if (!questionResult.ok) throw questionResult.reason
  if (!permissionResult.ok) throw permissionResult.reason
  return {
    complete: true,
    questions: questionResult.value.filter((request) => request.sessionID === target.sessionID).length,
    permissions: permissionResult.value.filter((request) => request.sessionID === target.sessionID).length
  }
}

export function NativeSessionOutcomePanel({
  target,
  conversation,
  working,
  interactionEnabled = true,
  onConnectionIssue
}: Props) {
  const [view, setView] = useState<OutcomeView | null>(null)
  const [expanded, setExpanded] = useState(false)
  const generationRef = useRef(0)

  useEffect(() => {
    setView(null)
    setExpanded(false)
  }, [target.key])

  useEffect(() => {
    if (!interactionEnabled) return
    if (working) {
      // The previous idle snapshot cannot certify the next turn. Invalidate attention immediately so
      // an idle edge cannot flash "Completed" before fresh target-side permission/question reads land.
      setView((current) => current && current.attention.complete
        ? { ...current, attention: UNKNOWN_ATTENTION }
        : current)
      return
    }
    const generation = ++generationRef.current
    let disposed = false

    void (async () => {
      const [projectResult, attentionResult] = await Promise.allSettled([
        loadProjectOutcome(target),
        loadAttentionEvidence(target)
      ])
      if (disposed || generation !== generationRef.current) return

      if (projectResult.status === "rejected" && connectionFailure(projectResult.reason)) onConnectionIssue?.()
      if (attentionResult.status === "rejected" && connectionFailure(attentionResult.reason)) onConnectionIssue?.()

      setView((current) => {
        const project = projectResult.status === "fulfilled"
          ? projectResult.value ?? undefined
          : current?.project
        const attention = attentionResult.status === "fulfilled"
          ? attentionResult.value
          : current?.attention ?? UNKNOWN_ATTENTION
        return { ...(project ? { project } : {}), attention }
      })
    })()

    return () => { disposed = true }
  }, [target.key, target.config, target.directory, target.sessionID, working, interactionEnabled, onConnectionIssue])

  const review = useMemo(
    () => nativeSessionReviewEvidence(conversation, view?.attention ?? UNKNOWN_ATTENTION),
    [conversation, view?.attention]
  )
  const outcome = view?.project?.outcome
  const visibleFiles = useMemo(() => outcome?.files?.slice(0, MAX_VISIBLE_FILES) ?? [], [outcome])
  if (!outcome && !review) return null

  const projectName = view?.project?.projectName
  const total = outcome?.totalChangedFiles
  const hiddenCount = total === undefined ? 0 : Math.max(0, total - visibleFiles.length)
  const branchOrHead = outcome?.branch || (outcome?.head ? outcome.head.slice(0, 8) : undefined)
  const state = outcome ? outcomeState(outcome) : undefined
  const summary = [
    review?.label,
    branchOrHead,
    state,
    total !== undefined ? `${total} changed ${total === 1 ? "file" : "files"}` : undefined
  ].filter(Boolean).join(" · ")

  return (
    <section className="hr-native-outcome" aria-label="Session outcome">
      <button
        type="button"
        className="hr-native-outcome-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="hr-native-outcome-title">
          <strong>{outcome ? "Project outcome" : "Session outcome"}</strong>
          {projectName ? <small>{projectName}</small> : null}
        </span>
        <span className={`hr-native-outcome-summary ${outcome?.dirty === true ? "dirty" : outcome?.dirty === false ? "clean" : "unverified"}`}>
          {summary}
        </span>
      </button>

      {expanded ? (
        <div className="hr-native-outcome-body">
          {review ? (
            <>
              <div className="hr-native-outcome-facts" aria-label="Session review evidence">
                <span>Session <strong>{review.label}</strong></span>
                {view?.attention.permissions ? <span>Authorization <strong>{view.attention.permissions} pending</strong></span> : null}
                {view?.attention.questions ? <span>Questions <strong>{view.attention.questions} pending</strong></span> : null}
              </div>
              <p className="hr-native-outcome-note">
                {review.summary}{review.detail ? ` ${review.detail}` : ""} {review.nextAction}
              </p>
            </>
          ) : null}

          {outcome ? (
            <>
              <div className="hr-native-outcome-facts">
                {outcome.branch ? <span>Branch <strong>{outcome.branch}</strong></span> : null}
                {outcome.head ? <span>HEAD <strong>{outcome.head.slice(0, 8)}</strong></span> : null}
                <span>Worktree <strong>{state}</strong></span>
              </div>

              {outcome.dirty === true && visibleFiles.length ? (
                <div className="hr-native-outcome-files" aria-label="Changed files">
                  {visibleFiles.map((file, index) => (
                    <div className="hr-native-outcome-file" key={`${file.path}:${file.originalPath ?? ""}:${index}`}>
                      <span>{fileStatus(file)}</span>
                      <code title={fileLabel(file)}>{fileLabel(file)}</code>
                    </div>
                  ))}
                </div>
              ) : null}

              {outcome.dirty === false ? (
                <p className="hr-native-outcome-note">No local worktree changes are currently reported by Git.</p>
              ) : outcome.dirty === undefined ? (
                <p className="hr-native-outcome-note">Git branch or HEAD is known, but worktree status could not be verified.</p>
              ) : hiddenCount > 0 || outcome.filesTruncated ? (
                <p className="hr-native-outcome-note">
                  {visibleFiles.length ? `${visibleFiles.length} file names shown. ` : ""}
                  {hiddenCount > 0 ? `${hiddenCount} additional changed ${hiddenCount === 1 ? "file is" : "files are"} omitted by safety or display bounds.` : "Additional file names are omitted by safety or display bounds."}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
