import { useEffect, useState } from "react"
import { api } from "../api"
import type { PermissionRequest, QuestionRequest, ServerConfig } from "../types"

type Props = {
  config: ServerConfig
  directory: string
  questions: QuestionRequest[]
  permissions: PermissionRequest[]
  onResolved: () => Promise<void> | void
}

type AnswerMap = Record<string, string[]>
type CustomMap = Record<string, string>

function answerKey(requestID: string, index: number): string {
  return `${requestID}:${index}`
}

export function WorkThreadAttention({ config, directory, questions, permissions, onResolved }: Props) {
  const [answers, setAnswers] = useState<AnswerMap>({})
  const [custom, setCustom] = useState<CustomMap>({})
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
      await api.replyPermission(config, request.id, reply, directory)
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
    <section className="tdw-attention" aria-label="Agent needs your input">
      <div className="tdw-attention-heading"><span>Needs your input</span><strong>The coding agent is waiting for a decision.</strong></div>

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
                        onClick={() => toggleOption(request.id, index, option.label, Boolean(question.multiple))}
                        key={option.label}
                      >
                        <strong>{option.label}</strong>
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
          <strong>Permission required</strong>
          <p>{request.permission}</p>
          {request.patterns?.length ? <code>{request.patterns.join(" · ")}</code> : null}
          <div className="tdw-attention-actions">
            <button type="button" className="tdw-button secondary" disabled={submitting === request.id} onClick={() => void respondPermission(request, "reject")}>Deny</button>
            <button type="button" className="tdw-button secondary" disabled={submitting === request.id} onClick={() => void respondPermission(request, "once")}>Allow once</button>
            <button type="button" className="tdw-button primary" disabled={submitting === request.id} onClick={() => void respondPermission(request, "always")}>Always allow</button>
          </div>
        </div>
      ))}

      {error ? <div className="tdw-inline-error" role="alert">{error}</div> : null}
    </section>
  )
}
