import { useEffect, useState } from "react"
import { api } from "../api"
import { discoverMachine, recordApprovalDecision, type ApprovalDecisionIdentity } from "../machineClient"
import { permissionExecutionContext } from "../native-session-attention-notifications"
import { classifyNativeSessionAttention } from "../native-session-attention"
import type { PermissionRequest, QuestionRequest, ServerConfig } from "../types"

type Props = {
  config: ServerConfig
  directory: string
  questions: QuestionRequest[]
  permissions: PermissionRequest[]
  approvalIdentity?: ApprovalDecisionIdentity
  onResolved: () => Promise<void> | void
}

type AnswerMap = Record<string, string[]>
type CustomMap = Record<string, string>

const ATTENTION_RESOLUTION_SETTLE_MS = 900

function answerKey(requestID: string, index: number): string {
  return `${requestID}:${index}`
}

function permissionExplanation(request: PermissionRequest): string | undefined {
  for (const key of ["reason", "description", "message"]) {
    const value = request.metadata?.[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

const HARNESS_LABELS: Record<string, string> = {
  opencode: "OpenCode",
  opencode2: "OpenCode 2",
  omp: "Oh My Pi",
  pi: "PI",
  claude: "Claude Code",
  codex: "Codex",
  copilot: "GitHub Copilot",
  mimo: "MiMo Code",
  deepseek: "DeepSeek",
  antigravity: "Google Antigravity"
}

function harnessName(config: ServerConfig): string {
  const id = config.agentId || config.backend
  return HARNESS_LABELS[id] || id
}

function baseName(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || value
}

function samePath(left: string, right: string): boolean {
  return left.replace(/[\\/]+$/, "") === right.replace(/[\\/]+$/, "")
}

function permissionKind(command: string | undefined, targetPath: string | undefined, toolKind: string | undefined): string {
  if (toolKind === "edit" || toolKind === "write" || toolKind === "patch") return "File edit"
  if (command !== undefined) return "Command"
  if (targetPath !== undefined) return "File"
  return "Request"
}

/**
 * A native permission/question reply is acknowledged before OpenCode necessarily makes the resumed
 * turn's final transcript durable. Event delivery normally closes that gap, but OpenCode must not
 * depend on one `permission.replied`/`question.replied` edge surviving navigation, reconnect or
 * renderer scheduling. Reconcile immediately for every backend (the pre-existing behavior), then
 * exactly once more for OpenCode after the same bounded settle window used by the live Session
 * controller. This is user-action driven, not polling, and leaves ACP resolution semantics unchanged.
 */
export async function settleResolvedAttention(
  onResolved: () => Promise<void> | void,
  backend: ServerConfig["backend"],
  delayMs = ATTENTION_RESOLUTION_SETTLE_MS
): Promise<void> {
  await onResolved()
  if (backend !== "opencode") return
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, delayMs)))
  await onResolved()
}

export function WorkThreadAttention({ config, directory, questions, permissions, approvalIdentity, onResolved }: Props) {
  const [answers, setAnswers] = useState<AnswerMap>({})
  const [custom, setCustom] = useState<CustomMap>({})
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [machineIdentity, setMachineIdentity] = useState<{ name: string; id: string } | null>(null)
  const attention = classifyNativeSessionAttention({ questions, permissions })
  const authorizationRequired = attention.kind === "authorization"

  useEffect(() => {
    setAnswers({})
    setCustom({})
    setError(null)
  }, [questions.map((request) => request.id).join("|"), permissions.map((request) => request.id).join("|")])

  useEffect(() => {
    let active = true
    setMachineIdentity(null)
    if (permissions.length) {
      void discoverMachine(config, { allowCachedOnTransportFailure: true })
        .then((snapshot) => {
          if (active && snapshot) setMachineIdentity({ name: snapshot.machine.name, id: snapshot.machine.id })
        })
        .catch(() => undefined)
    }
    return () => { active = false }
  }, [config.host, config.port, config.backend, config.agentId, permissions.length])

  if (questions.length === 0 && permissions.length === 0) return null

  async function persistSuccessfulPermissionDecision(request: PermissionRequest, reply: "once" | "always" | "reject") {
    let identity = approvalIdentity
    if (identity && request.sessionID !== identity.sessionID) return
    if (!identity) {
      // HR3 surfaces already discover this machine, so this is normally an in-memory cache hit. On a
      // legacy bridge there is no machine identity (and no metadata endpoint), which correctly means
      // "do not record" rather than manufacturing one from host:port.
      const machine = await discoverMachine(config)
      if (!machine) return
      identity = {
        machineID: machine.machine.id,
        agentID: config.agentId || config.backend,
        sessionID: request.sessionID,
        directory
      }
    }
    const explanation = permissionExplanation(request)
    await recordApprovalDecision(config, {
      ...identity,
      requestID: request.id,
      requestedAction: request.permission,
      boundary: request.patterns,
      decision: reply,
      decidedAt: new Date().toISOString(),
      ...(explanation ? { explanation } : {})
    })
  }

  async function respondPermission(request: PermissionRequest, reply: "once" | "always" | "reject") {
    setSubmitting(request.id)
    setError(null)
    try {
      // The native harness is the authorization authority. Only after it confirms this reply do we
      // emit observational control-plane metadata; metadata failure must never reverse a real allow
      // or deny that already happened.
      await api.replyPermission(config, request.id, reply, directory)
      void persistSuccessfulPermissionDecision(request, reply).catch(() => undefined)
      await settleResolvedAttention(onResolved, config.backend)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSubmitting(null)
    }
  }

  async function respondQuestion(request: QuestionRequest) {
    const result = request.questions.map((_question, index) => {
      const key = answerKey(request.id, index)
      const selected = answers[key] ?? []
      const typed = (custom[key] || "").trim()
      return typed ? [...selected, typed] : selected
    })
    if (result.some((answer) => answer.length === 0)) {
      setError("Answer each question before continuing.")
      return
    }
    setSubmitting(request.id)
    setError(null)
    try {
      await api.replyQuestion(config, request.id, result, directory)
      await settleResolvedAttention(onResolved, config.backend)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSubmitting(null)
    }
  }

  function toggleOption(requestID: string, questionIndex: number, label: string, multiple: boolean) {
    const key = answerKey(requestID, questionIndex)
    setAnswers((current) => {
      const selected = current[key] ?? []
      if (!multiple) return { ...current, [key]: [label] }
      return {
        ...current,
        [key]: selected.includes(label) ? selected.filter((value) => value !== label) : [...selected, label]
      }
    })
  }

  return (
    <section
      className="tdw-attention bui-approval"
      aria-label={authorizationRequired ? "Authorization required" : "Agent needs your input"}
      aria-live="polite"
    >
      <div className="tdw-attention-heading">
        <span><i className="bui-approval-dot" aria-hidden="true" />{authorizationRequired ? "Authorization required" : "Needs your input"}</span>
        <strong>
          {authorizationRequired
            ? "The coding agent is blocked until you allow or deny this request."
            : "The coding agent is waiting for your answer."}
        </strong>
      </div>

      {questions.map((request) => (
        <div className="tdw-attention-card" key={request.id}>
          {request.questions.map((question, index) => {
            const key = answerKey(request.id, index)
            const selected = answers[key] ?? []
            return (
              <fieldset key={key}>
                <legend>{question.header || "Question"}</legend>
                <p>{question.question}</p>
                {question.options?.length ? (
                  <div className="tdw-attention-options">
                    {question.options.map((option) => (
                      <button
                        type="button"
                        className={selected.includes(option.label) ? "selected" : ""}
                        aria-pressed={selected.includes(option.label)}
                        onClick={() => toggleOption(request.id, index, option.label, Boolean(question.multiple))}
                        key={option.label}
                      >
                        <strong>
                          <i className="bui-approval-check" aria-hidden="true">{selected.includes(option.label) ? "✓" : ""}</i>
                          {option.label}
                        </strong>
                        {option.description ? <span>{option.description}</span> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
                {question.custom !== false ? (
                  <input
                    value={custom[key] || ""}
                    onChange={(event) => setCustom((current) => ({ ...current, [key]: event.target.value }))}
                    placeholder="Type another answer..."
                    aria-label={`Custom answer for ${question.header || question.question || "this question"}`}
                  />
                ) : null}
              </fieldset>
            )
          })}
          <div className="tdw-attention-actions">
            <button type="button" className="tdw-button primary" disabled={submitting === request.id} onClick={() => void respondQuestion(request)}>
              {submitting === request.id ? "Sending..." : "Send answer"}
            </button>
          </div>
        </div>
      ))}

      {permissions.map((request) => {
        const execution = permissionExecutionContext(request.metadata)
        const offeredReplies = Array.isArray(request.metadata?.availableReplies)
          ? request.metadata.availableReplies.filter((value): value is string => typeof value === "string")
          : null
        const title = request.permission?.trim() || "Permission requested"
        const command = execution.command
        const targetPath = execution.targetPath
        const redundantTitle = (command !== undefined && title === command.trim())
          || (targetPath !== undefined && (title === targetPath || title === baseName(targetPath)))
        const explanation = permissionExplanation(request)
        const machineName = machineIdentity?.name || "Machine name unavailable"
        const machineID = machineIdentity?.id || approvalIdentity?.machineID
        const kind = permissionKind(command, targetPath, execution.toolKind)
        return (
        <div className="tdw-attention-card bui-approval-card" key={request.id}>
          <div className="bui-approval-top">
            <span className="bui-approval-kind">{kind}</span>
            <span className="bui-approval-machine">{machineName} · {harnessName(config)}</span>
          </div>
          {redundantTitle ? null : <p className="bui-approval-title">{title}</p>}
          {command !== undefined ? (
            <pre className="bui-approval-command" tabIndex={0} title={command}>{command}</pre>
          ) : null}
          {targetPath !== undefined ? (
            <p className="bui-approval-target">
              <span>Target file</span>
              <code title={targetPath}>{targetPath}</code>
            </p>
          ) : null}
          {command === undefined && targetPath === undefined
            ? <p className="bui-approval-missing">{kind === "File edit" ? "Target file not supplied by the harness." : "Exact command not supplied by the harness."}</p>
            : null}
          <div className="bui-approval-paths">
            {directory
              ? <span title={directory}>Session <code>{directory}</code></span>
              : <span>Session directory unavailable</span>}
            {execution.executionDirectory !== undefined && !samePath(execution.executionDirectory, directory)
              ? <span title={execution.executionDirectory}>Runs in <code>{execution.executionDirectory}</code></span>
              : null}
          </div>
          <div className="tdw-attention-actions">
            <button type="button" className="tdw-button secondary bui-approval-deny" disabled={submitting === request.id} onClick={() => void respondPermission(request, "reject")}>Deny</button>
            {(!offeredReplies || offeredReplies.includes("once")) ? <button type="button" className="tdw-button secondary" disabled={submitting === request.id} onClick={() => void respondPermission(request, "once")}>Allow once</button> : null}
            {(!offeredReplies || offeredReplies.includes("always")) ? <button type="button" className="tdw-button primary" disabled={submitting === request.id} onClick={() => void respondPermission(request, "always")}>Always allow</button> : null}
          </div>
          <details className="bui-approval-details">
            <summary>More details</summary>
            <dl>
              <dt>Machine</dt><dd>{machineName}</dd>
              {machineID ? <><dt>Machine ID</dt><dd><code>{machineID}</code></dd></> : null}
              <dt>Harness</dt><dd>{harnessName(config)}</dd>
              <dt>Gateway</dt><dd><code>{config.host}:{config.port}</code></dd>
              <dt>Session directory</dt><dd>{directory ? <code>{directory}</code> : "Not available"}</dd>
              <dt>Execution directory</dt><dd>{execution.executionDirectory !== undefined ? <code>{execution.executionDirectory}</code> : "Not supplied by the harness"}</dd>
              {execution.toolKind !== undefined || request.metadata?.toolName !== undefined ? (
                <><dt>Tool</dt><dd>{typeof request.metadata?.toolName === "string" ? request.metadata.toolName : execution.toolKind}</dd></>
              ) : null}
              {explanation ? <><dt>Reason</dt><dd>{explanation}</dd></> : null}
            </dl>
            {request.patterns?.length ? (
              <div className="bui-approval-scopes" aria-label="Requested scope">
                {request.patterns.map((pattern) => <code key={pattern}>{pattern}</code>)}
              </div>
            ) : null}
            <p>If you do nothing, this request remains blocked.</p>
          </details>
        </div>
        )
      })}

      {error ? <div className="tdw-inline-error" role="alert">{error}</div> : null}
    </section>
  )
}
