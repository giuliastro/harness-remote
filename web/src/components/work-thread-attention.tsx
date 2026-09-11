import { useEffect, useState } from "react"
import { api } from "../api"
import { recordApprovalDecision, type ApprovalDecisionIdentity } from "../machineClient"
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

export function WorkThreadAttention({ config, directory, questions, permissions, approvalIdentity, onResolved }: Props) {
  const [answers, setAnswers] = useState<AnswerMap>({})
  const [custom, setCustom] = useState<CustomMap>({})
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const attention = classifyNativeSessionAttention({ questions, permissions })
  const authorizationRequired = attention.kind === "authorization"

  useEffect(() => {
    setAnswers({})
    setCustom({})
    setError(null)
  }, [questions.map((request) => request.id).join("|"), permissions.map((request) => request.id).join("|")])

  if (questions.length === 0 && permissions.length === 0) return null

  async function respondPermission(request: PermissionRequest, reply: "once" | "always" | "reject") {
    setSubmitting(request.id)
    setError(null)
    try {
      // The native harness is the authorization authority. Only after it confirms this reply do we
      // emit observational control-plane metadata; metadata failure must never reverse a real allow
      // or deny that already happened.
      await api.replyPermission(config, request.id, reply, directory)
      if (approvalIdentity && request.sessionID === approvalIdentity.sessionID) {
        void recordApprovalDecision(config, {
          ...approvalIdentity,
          requestID: request.id,
          requestedAction: request.permission,
          boundary: request.patterns,
          decision: reply,
          decidedAt: new Date().toISOString(),
          ...(permissionExplanation(request) ? { explanation: permissionExplanation(request) } : {})
        }).catch(() => undefined)
      }
      await onResolved()
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
      await onResolved()
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

      {permissions.map((request) => (
        <div className="tdw-attention-card" key={request.id}>
          <strong>Authorization required</strong>
          <p>{request.permission}</p>
          {request.patterns?.length ? (
            <div className="bui-approval-scopes" aria-label="Requested scope">
              {request.patterns.map((pattern) => <code key={pattern}>{pattern}</code>)}
            </div>
          ) : null}
          <p>If you do nothing, this request remains blocked.</p>
          <div className="tdw-attention-actions">
            <button type="button" className="tdw-button secondary bui-approval-deny" disabled={submitting === request.id} onClick={() => void respondPermission(request, "reject")}>Deny</button>
            <button type="button" className="tdw-button secondary" disabled={submitting === request.id} onClick={() => void respondPermission(request, "once")}>Allow once</button>
            <button type="button" className="tdw-button primary" disabled={submitting === request.id} onClick={() => void respondPermission(request, "always")}>Always allow</button>
          </div>
        </div>
      ))}

      {error ? <div className="tdw-inline-error" role="alert">{error}</div> : null}
    </section>
  )
}
