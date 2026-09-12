import { useEffect, useMemo, useRef, useState } from "react"
import { listMachineProjects } from "../machineClient"
import { resolveSourceSessionProject } from "../cross-machine-route-projects"
import type { NativeSessionSurfaceTarget } from "../native-session-discovery"
import {
  loadMachineProjectOutcome,
  type MachineProjectOutcome,
  type MachineProjectOutcomeFile
} from "../project-outcome-client"
import "../native-session-outcome.css"

const MAX_VISIBLE_FILES = 12

type Props = {
  target: NativeSessionSurfaceTarget
  working: boolean
  interactionEnabled?: boolean
  onConnectionIssue?: () => void
}

type OutcomeView = {
  projectName: string
  outcome: MachineProjectOutcome
}

function connectionFailure(reason: unknown): boolean {
  return /cannot reach|timed out|network|connection/i.test(reason instanceof Error ? reason.message : String(reason))
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

export function NativeSessionOutcomePanel({
  target,
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
    if (!interactionEnabled || working) return
    const generation = ++generationRef.current
    let disposed = false

    void (async () => {
      try {
        const projects = await listMachineProjects(target.config)
        const projectRoute = resolveSourceSessionProject(target, projects)
        if (!projectRoute || projectRoute.project.kind !== "git") {
          if (!disposed && generation === generationRef.current) setView(null)
          return
        }
        const outcome = await loadMachineProjectOutcome(target.config, projectRoute.project.id)
        if (!disposed && generation === generationRef.current) {
          setView(outcome ? { projectName: projectRoute.project.name, outcome } : null)
        }
      } catch (reason) {
        if (!disposed && generation === generationRef.current) {
          if (connectionFailure(reason)) onConnectionIssue?.()
          // Outcome is optional enrichment. A failed read must never replace a previously useful
          // snapshot with invented clean/empty state or make the native Session unusable.
        }
      }
    })()

    return () => { disposed = true }
  }, [target.key, target.config, working, interactionEnabled, onConnectionIssue])

  const visibleFiles = useMemo(() => view?.outcome.files?.slice(0, MAX_VISIBLE_FILES) ?? [], [view])
  if (!view) return null

  const { outcome, projectName } = view
  const total = outcome.totalChangedFiles
  const hiddenCount = total === undefined ? 0 : Math.max(0, total - visibleFiles.length)
  const branchOrHead = outcome.branch || (outcome.head ? outcome.head.slice(0, 8) : "Git Project")
  const state = outcomeState(outcome)

  return (
    <section className="hr-native-outcome" aria-label="Project outcome">
      <button
        type="button"
        className="hr-native-outcome-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="hr-native-outcome-title">
          <strong>Project outcome</strong>
          <small>{projectName}</small>
        </span>
        <span className={`hr-native-outcome-summary ${outcome.dirty === true ? "dirty" : outcome.dirty === false ? "clean" : "unverified"}`}>
          {branchOrHead} · {state}{total !== undefined ? ` · ${total} changed ${total === 1 ? "file" : "files"}` : ""}
        </span>
      </button>

      {expanded ? (
        <div className="hr-native-outcome-body">
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
        </div>
      ) : null}
    </section>
  )
}
