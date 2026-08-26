import { createHash } from "node:crypto"
import http from "node:http"
import { authenticateDaemonRequest, writeJSON } from "./http-policy.js"
import { parseAttachments } from "./server.js"

const MAX_REQUEST_BODY_BYTES = 24 * 1024 * 1024

const SESSION_OPERATION_ROUTE = /^\/v1\/agents\/([^/]+)\/session\/([^/]+)\/(claim|prompt|stop|handoff)$/

function requestError(message) {
  const error = new Error(message)
  error.code = "invalid_request"
  return error
}

function statusForSessionError(error) {
  if (error?.code === "invalid_request") return 400
  if (error?.code === "unknown_agent") return 404
  if (error?.code === "agent_unavailable") return 503
  if ([
    "unsupported_agent",
    "session_unavailable",
    "session_not_claimed",
    "session_prompt_rejected",
    "session_stop_rejected",
    // A variant the current model does not offer is a conflict about the user's choice, not a
    // server fault: the Session is fine and remains usable with another selection.
    "model_variant_unavailable",
    "handoff_rejected",
    "idempotency_conflict"
  ].includes(error?.code)) return 409
  // Native harness writer-lock errors are intentionally surfaced as conflicts rather than generic
  // server failures: the Session still exists and remains observable, HR simply cannot own it now.
  if (/session|load|writer|locked|busy|owned|active/i.test(error instanceof Error ? error.message : String(error))) return 409
  return 500
}

async function readJSONBody(request) {
  let body = ""
  for await (const chunk of request) {
    body += chunk
    // A prompt may carry images. `parseAttachments` is the real bound - 5MB per file, 15MB in total -
    // and base64 inflates that to about 20MB on the wire, so this only has to be wide enough not to
    // reject a valid prompt before that validator ever sees it.
    if (body.length > MAX_REQUEST_BODY_BYTES) throw requestError("Request body is too large")
  }
  if (!body) return {}
  try {
    return JSON.parse(body)
  } catch {
    throw requestError("Request body must be valid JSON")
  }
}

function operationIdentityInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw requestError("Request body must be a JSON object")
  const clientRequestId = typeof body.clientRequestId === "string" ? body.clientRequestId.trim() : ""
  const directory = typeof body.directory === "string" ? body.directory : ""
  if (!clientRequestId || clientRequestId.length > 200) throw requestError("A valid clientRequestId is required")
  return { clientRequestId, directory }
}

function promptModelInput(body) {
  if (body.model === undefined || body.model === null) return null
  if (!body.model || typeof body.model !== "object" || Array.isArray(body.model)) throw requestError("Prompt model must be an object")
  const providerID = typeof body.model.providerID === "string" ? body.model.providerID.trim() : ""
  const modelID = typeof body.model.modelID === "string" ? body.model.modelID.trim() : ""
  if (!providerID || !modelID) throw requestError("Prompt model requires providerID and modelID")
  return { providerID, modelID }
}

function promptInput(body) {
  const common = operationIdentityInput(body)
  const text = typeof body.text === "string" ? body.text.trim() : ""
  const model = promptModelInput(body)
  const variant = typeof body.variant === "string" && body.variant.trim() ? body.variant.trim() : undefined
  // Reuses the bridge server's validator so the two paths cannot disagree about accepted types,
  // per-file size or total size. An image-only prompt is a real prompt: "look at this".
  let attachments = []
  try {
    attachments = parseAttachments(body.parts)
  } catch (error) {
    throw requestError(error instanceof Error ? error.message : "Invalid attachment")
  }
  if (!text && !attachments.length) throw requestError("A text prompt is required")
  return { ...common, text, model, variant, attachments }
}

function stopInput(body) {
  const common = operationIdentityInput(body)
  const operationToken = typeof body.operationToken === "string" ? body.operationToken.trim() : ""
  if (!operationToken || operationToken.length > 500) throw requestError("A valid stop operationToken is required")
  return { ...common, operationToken }
}

function handoffInput(body) {
  const common = operationIdentityInput(body)
  const targetAgentID = typeof body.targetAgentID === "string" ? body.targetAgentID.trim() : ""
  const model = promptModelInput(body)
  const variant = typeof body.variant === "string" && body.variant.trim() ? body.variant.trim() : undefined
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : undefined
  if (!common.directory) throw requestError("Native Session handoff requires a project directory")
  if (!targetAgentID || targetAgentID.length > 200) throw requestError("Native Session handoff requires a targetAgentID")
  return { ...common, targetAgentID, model, variant, title }
}

function mutationSignature(operation, payload) {
  return createHash("sha256").update(JSON.stringify({ operation, ...payload })).digest("hex")
}

async function runIdempotentMutation({ operationLedger, identity, signature, dispatch }) {
  const started = await operationLedger.begin({ ...identity, signature })
  if (started.duplicate) {
    return { status: started.state, duplicate: true, result: started.entry.result }
  }

  let dispatched = false
  try {
    const result = await dispatch()
    dispatched = true
    await operationLedger.accept({ ...identity, result })
    return { status: "accepted", duplicate: false, result }
  } catch (error) {
    const ambiguous = dispatched || error?.ambiguous === true
    await operationLedger.fail({ ...identity, ambiguous })
    if (ambiguous) return { status: "uncertain", duplicate: false }
    throw error
  }
}

/**
 * Machine-daemon boundary for native Session ownership and idempotent mutations.
 *
 * Prompt and Stop mutate one existing native Session. Handoff is the deliberate cross-agent
 * exception: it creates one new real native Session on the target harness and returns that native
 * identity. No operation here creates a Task, Conversation or Run. Mutation ids are persisted before
 * dispatch; accepted resource-creating operations also persist their result before HTTP success so a
 * lost response can return the exact same target Session. Pending/uncertain operations are never
 * replayed automatically after a crash or ambiguous local transport failure.
 */
export function createSessionClaimServer({
  innerServer,
  config,
  claimSession,
  promptSession,
  stopSession,
  handoffSession,
  operationLedger,
  createServer = http.createServer
}) {
  return createServer(async (request, response) => {
    const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    const match = SESSION_OPERATION_ROUTE.exec(requestURL.pathname)
    if (!match) {
      innerServer.emit("request", request, response)
      return
    }

    if (!authenticateDaemonRequest(request, response, config)) return
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST, OPTIONS" })
      response.end()
      return
    }

    const agentID = decodeURIComponent(match[1])
    const sessionID = decodeURIComponent(match[2])
    const operation = match[3]
    try {
      if (operation === "claim") {
        await claimSession(agentID, sessionID)
        writeJSON(response, 200, { claimed: true, sessionID })
        return
      }

      if (!operationLedger) throw new Error("Native Session operation ledger is not configured")
      if (operation === "prompt" && typeof promptSession !== "function") throw new Error("Native Session prompt transport is not configured")
      if (operation === "stop" && typeof stopSession !== "function") throw new Error("Native Session stop transport is not configured")
      if (operation === "handoff" && typeof handoffSession !== "function") throw new Error("Native Session handoff transport is not configured")

      const body = await readJSONBody(request)
      const input = operation === "prompt"
        ? promptInput(body)
        : operation === "stop"
          ? stopInput(body)
          : handoffInput(body)
      if (operation === "handoff" && input.targetAgentID === agentID) {
        throw requestError("Cross-agent handoff requires a different target agent")
      }

      const identity = { agentID, sessionID, clientRequestId: input.clientRequestId }
      const signaturePayload = operation === "prompt"
        ? {
            text: input.text,
            directory: input.directory,
            model: input.model,
            variant: input.variant ?? null,
            // Without this, the same text sent with a different image reuses the first request's
            // identity and the second prompt is answered as a duplicate of the first.
            attachments: (input.attachments ?? []).map((file) => `${file.mime}:${file.data.length}`)
          }
        : operation === "stop"
          ? { directory: input.directory, operationToken: input.operationToken }
          : {
              directory: input.directory,
              targetAgentID: input.targetAgentID,
              model: input.model,
              variant: input.variant ?? null,
              title: input.title ?? null
            }
      const result = await runIdempotentMutation({
        operationLedger,
        identity,
        signature: mutationSignature(operation, signaturePayload),
        dispatch: () => operation === "prompt"
          ? promptSession(agentID, sessionID, input)
          : operation === "stop"
            ? stopSession(agentID, sessionID, input)
            : handoffSession(agentID, sessionID, input)
      })
      const status = result.status === "accepted" ? 200 : 202
      writeJSON(response, status, {
        status: result.status,
        clientRequestId: input.clientRequestId,
        sessionID,
        ...(result.result ? { result: result.result } : {})
      })
    } catch (error) {
      writeJSON(response, statusForSessionError(error), {
        error: error instanceof Error ? error.message : String(error),
        ...(error?.code ? { code: error.code } : {})
      })
    }
  })
}
