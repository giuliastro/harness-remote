import { useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import type { ConversationRuntime } from "../conversation-runtime"
import { listMachineProjects } from "../machineClient"
import { resolveSourceSessionProject } from "../cross-machine-route-projects"
import type { NativeSessionSurfaceTarget } from "../native-session-discovery"
import {
  nativeSessionGateEvidence,
  type NativeSessionGateEvidence
} from "../native-session-gate-evidence"
import {
  nativeSessionReviewEvidence,
  type NativeSessionReviewAttention
} from "../native-session-review-evidence"
import {
  loadMachineProjectOutcome,
  type MachineProjectOutcome,
  type MachineProjectOutcomeFile
} from "../project-outcome-client"
import type { PermissionRequest, QuestionRequest } from "../types"
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
  gate?: NativeSessionGateEvidence
}

type AttentionLoad = {
  questions?: QuestionRequest[]
  permissions?: PermissionRequest[]
  connectionIssue: boolean
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

async function loadAttentionEvidence(target: NativeSessionSurfaceTarget): Promise<AttentionLoad> {
  const [questionResult, permissionResult] = await Promise.allSettled([
    api.loadQuestions(target.config, target.directory),
    api.loadPermissions(target.config, target.directory)
  ])
  return {
    ...(questionResult.status === "fulfilled" ? {
      questions: questionResult.value.filter((request) => request.sessionID === target.sessionID)
    } : {}),
    ...(permissionResult.status === "fulfilled" ? {
      permissions: permissionResult.value.filter((request) => request.sessionID === target.sessionID)
    } : {}),
    connectionIssue:
      (questionResult.status === "rejected" && connectionFailure(questionResult.reason))
      || (permissionResult.status === "rejected" && connectionFailure(permissionResult.reason))
  }
}

function gateFromAttentionLoad(
  load: AttentionLoad,
  previous?: NativeSessionGateEvidence
): NativeSessionGateEvidence | undefined {
  // A failed permission read cannot prove that an already-known authorization gate disappeared.
  // Preserve that fail-closed evidence until the permission endpoint returns a complete replacement.
  if (load.permissions === undefined && previous?.kind === "authorization") return previous

  const permissionGate = nativeSessionGateEvidence(load.permissions ?? [], [])
  if (permissionGate) return permissionGate

  // Once permissions are known empty, questions may become the highest-priority gate. If that
  // endpoint is the one that failed, retain only a previously known question instead of inventing one.
  if (load.questions === undefined && previous?.kind === "question") return previous
  return nativeSessionGateEvidence([], load.questions ?? []) ?? undefined
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
    if (!interactionEnabled || working) {
      // The previous idle snapshot cannot certify the next turn or a disconnected target. Keep the
      // Project snapshot visible, but invalidate attention immediately so stale absence of a gate can
      // never flash/retain "Completed" before fresh permission/question reads are possible.
      setView((current) => current && current.attention.complete
        ? { ...current, attention: { ...current.attention, complete: false } }
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
      if (attentionResult.status === "fulfilled" && attentionResult.value.connectionIssue) onConnectionIssue?.()

      setView((current) => {
        const project = projectResult.status === "fulfilled"
          ? projectResult.value ?? undefined
          : current?.project
        const previousAttention = current?.attention ?? UNKNOWN_ATTENTION
        const attention = attentionResult.status === "fulfilled"
          ? {
              complete: attentionResult.value.questions !== undefined && attentionResult.value.permissions !== undefined,
              questions: attentionResult.value.questions?.length ?? previousAttention.questions,
              permissions: attentionResult.value.permissions?.length ?? previousAttention.permissions
            }
          : { ...previousAttention, complete: false }
        const gate = attentionResult.status === "fulfilled"
          ? gateFromAttentionLoad(attentionResult.value, current?.gate)
          : current?.gate
        return {
          ...(project ? { project } : {}),
          attention,
          ...(gate ? { gate } : {})
        }
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
  const gate = view?.gate
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
                {gate ? (
                  <span>{gate.kind === "authorization" ? "Requested action" : "Waiting for"} <strong>{gate.label}</strong></span>
                ) : null}
              </div>
              <p className="hr-native-outcome-note">
                {review.summary}{review.detail ? ` ${review.detail}` : ""} {review.nextAction}
              </p>
              {gate?.detail ? <p className="hr-native-outcome-note">{gate.detail}</p> : null}
              {gate?.kind === "authorization" && gate.boundaries.length ? (
                <div className="hr-native-outcome-files" aria-label="Authorization boundaries">
                  {gate.boundaries.map((boundary, index) => (
                    <div className="hr-native-outcome-file" key={`${boundary}:${index}`}>
                      <span>Gated scope</span>
                      <code title={boundary}>{boundary}</code>
                    </div>
                  ))}
                </div>
              ) : null}
              {gate?.omittedBoundaries ? (
                <p className="hr-native-outcome-note">
                  {gate.omittedBoundaries} additional gated {gate.omittedBoundaries === 1 ? "scope is" : "scopes are"} omitted by display bounds.
                </p>
              ) : null}
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
