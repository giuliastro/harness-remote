import { createHash } from "node:crypto"
import http from "node:http"
import { authenticateDaemonRequest, writeJSON } from "./http-policy.js"
import { normalizePortableHandoffState } from "./portable-handoff-state.js"

const SESSION_OPERATION_ROUTE = /^\/v1\/agents\/([^/]+)\/session\/([^/]+)\/(claim|prompt|command|stop|handoff)$/
const SESSION_LINK_ROUTE = "/v1/session-links"
const ATTACHMENT_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])
const MAX_ATTACHMENTS = 8
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const MAX_ATTACHMENT_TOTAL_BYTES = 15 * 1024 * 1024

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
    "session_command_rejected",
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
    if (body.length > 25_000_000) throw requestError("Request body is too large")
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

function base64ByteLength(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding)
}

function promptAttachmentsInput(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw requestError("Prompt attachments must be an array")
  if (value.length > MAX_ATTACHMENTS) throw requestError(`At most ${MAX_ATTACHMENTS} attachments per prompt`)
  let total = 0
  return value.map((attachment) => {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      throw requestError("Prompt attachment must be an object")
    }
    const mime = typeof attachment.mime === "string" ? attachment.mime.toLowerCase() : ""
    if (!ATTACHMENT_MIME_TYPES.has(mime)) throw requestError(`Unsupported attachment type ${mime || "unknown"}`)
    const filename = typeof attachment.filename === "string" && attachment.filename.trim()
      ? attachment.filename.trim().slice(0, 255)
      : "attachment"
    const url = typeof attachment.url === "string" ? attachment.url : ""
    const match = /^data:[^;,]+;base64,([A-Za-z0-9+/=]+)$/s.exec(url)
    if (!match) throw requestError("An attachment must be a base64 data URL")
    const bytes = base64ByteLength(match[1])
    if (bytes > MAX_ATTACHMENT_BYTES) throw requestError("Each attachment must stay under 5MB")
    total += bytes
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw requestError("Attachments must stay under 15MB in total")
    return { mime, filename, url }
  })
}

function promptInput(body) {
  const common = operationIdentityInput(body)
  const text = typeof body.text === "string" ? body.text.trim() : ""
  const model = promptModelInput(body)
  const variant = typeof body.variant === "string" && body.variant.trim() ? body.variant.trim() : undefined
  const attachments = promptAttachmentsInput(body.attachments)
  if (!text) throw requestError("A text prompt is required")
  return { ...common, text, model, variant, attachments }
}

function commandInput(body) {
  const common = operationIdentityInput(body)
  const command = typeof body.command === "string" ? body.command.replace(/^\/+/, "").trim() : ""
  const argumentsText = typeof body.arguments === "string" ? body.arguments.trim() : ""
  const model = promptModelInput(body)
  const variant = typeof body.variant === "string" && body.variant.trim() ? body.variant.trim() : undefined
  if (!command || command.length > 200) throw requestError("A valid command name is required")
  return { ...common, command, arguments: argumentsText, model, variant }
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

function nativeSessionIdentityInput(value, label = "Native Session") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw requestError(`${label} identity is required`)
  const machineID = typeof value.machineID === "string" ? value.machineID.trim() : ""
  const agentID = typeof value.agentID === "string" ? value.agentID.trim() : ""
  const sessionID = typeof value.sessionID === "string" ? value.sessionID.trim() : ""
  const directory = typeof value.directory === "string" ? value.directory : ""
  if (![machineID, agentID, sessionID, directory].every(Boolean)) throw requestError(`${label} identity is incomplete`)
  return { machineID, agentID, sessionID, directory }
}

function sessionLinkInput(body) {
  const candidate = body?.link ?? body
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || candidate.type !== "handoff") {
    throw requestError("Only native Session handoff links are supported")
  }
  const transferredContext = candidate.transferredContext
  if (transferredContext !== undefined && typeof transferredContext !== "string") {
    throw requestError("Transferred Session context must be text")
  }
  if (typeof transferredContext === "string" && transferredContext.length > 12_000) {
    throw requestError("Transferred Session context is too large")
  }
  const portableState = normalizePortableHandoffState(candidate.portableState)
  return {
    source: nativeSessionIdentityInput(candidate.source, "Source Session"),
    target: nativeSessionIdentityInput(candidate.target, "Target Session"),
    createdAt: typeof candidate.createdAt === "string" && candidate.createdAt ? candidate.createdAt : new Date().toISOString(),
    ...(typeof transferredContext === "string" && transferredContext ? { transferredContext } : {}),
    ...(portableState ? { portableState } : {})
  }
}

function mutationSignature(operation, payload) {
  return createHash("sha256").update(JSON.stringify({ operation, ...payload })).digest("hex")
}

async function runIdempotentMutation({ operationLedger, identity, signature, dispatch, reconcile }) {
  const started = await operationLedger.begin({ ...identity, signature })
  if (started.duplicate) {
    if (started.state === "uncertain" && typeof reconcile === "function") {
      try {
        const recovered = await reconcile(started.entry.result)
        if (recovered) {
          await operationLedger.accept({ ...identity, result: recovered })
          return { status: "accepted", duplicate: true, result: recovered }
        }
      } catch {
        // Reconciliation is read-only. A temporary read failure must leave the original uncertain
        // entry untouched rather than replaying a resource-creating mutation.
      }
    }
    return { status: started.state, duplicate: true, result: started.entry.result }
  }

  let dispatched = false
  let checkpointedResult
  const checkpoint = async (result) => {
    await operationLedger.accept({ ...identity, result })
    checkpointedResult = result
  }

  try {
    const result = await dispatch({ checkpoint })
    dispatched = true
    const acceptedResult = result === undefined ? checkpointedResult : result
    if (result !== undefined || checkpointedResult === undefined) {
      await operationLedger.accept({ ...identity, result })
    }
    return { status: "accepted", duplicate: false, result: acceptedResult }
  } catch (error) {
    if (checkpointedResult !== undefined) {
      // Resource identity is already durable. Any later title/model/link enrichment failure cannot
      // turn the creation back into "unknown"; retries must return this exact resource.
      return { status: "accepted", duplicate: false, result: checkpointedResult }
    }
    const ambiguous = dispatched || error?.ambiguous === true
    await operationLedger.fail({
      ...identity,
      ambiguous,
      ...(error?.recovery !== undefined ? { result: error.recovery } : {})
    })
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
 * dispatch; resource-creating handoffs checkpoint the target identity as soon as it is known, before
 * any optional enrichment. A direct creation ambiguity is never replayed blindly: duplicate retries
 * may perform read-only reconciliation and promote one uniquely identified target into an accepted
 * ledger result.
 */
export function createSessionClaimServer({
  innerServer,
  config,
  claimSession,
  promptSession,
  commandSession,
  stopSession,
  handoffSession,
  reconcileHandoff,
  operationLedger,
  sessionLinkStore,
  createServer = http.createServer
}) {
  return createServer(async (request, response) => {
    const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    const match = SESSION_OPERATION_ROUTE.exec(requestURL.pathname)
    const sessionLinkRoute = requestURL.pathname === SESSION_LINK_ROUTE
    if (!match && !sessionLinkRoute) {
      innerServer.emit("request", request, response)
      return
    }

    if (!authenticateDaemonRequest(request, response, config)) return

    if (sessionLinkRoute) {
      try {
        if (!sessionLinkStore) throw new Error("Native Session link store is not configured")
        if (request.method === "GET") {
          const identity = nativeSessionIdentityInput({
            machineID: requestURL.searchParams.get("machineID") || "",
            agentID: requestURL.searchParams.get("agentID") || "",
            sessionID: requestURL.searchParams.get("sessionID") || "",
            directory: requestURL.searchParams.get("directory") || ""
          })
          writeJSON(response, 200, { links: await sessionLinkStore.listFor(identity) })
          return
        }
        if (request.method === "POST") {
          const input = sessionLinkInput(await readJSONBody(request))
          writeJSON(response, 200, { link: await sessionLinkStore.addHandoff(input) })
          return
        }
        response.writeHead(405, { Allow: "GET, POST, OPTIONS" })
        response.end()
      } catch (error) {
        writeJSON(response, statusForSessionError(error), { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

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
      if (operation === "command" && typeof commandSession !== "function") throw new Error("Native Session command transport is not configured")
      if (operation === "stop" && typeof stopSession !== "function") throw new Error("Native Session stop transport is not configured")
      if (operation === "handoff" && typeof handoffSession !== "function") throw new Error("Native Session handoff transport is not configured")

      const body = await readJSONBody(request)
      const input = operation === "prompt"
        ? promptInput(body)
        : operation === "command"
          ? commandInput(body)
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
            attachments: input.attachments.map((attachment) => ({
              mime: attachment.mime,
              filename: attachment.filename,
              digest: createHash("sha256").update(attachment.url).digest("hex")
            }))
          }
        : operation === "command"
          ? {
              command: input.command,
              arguments: input.arguments,
              directory: input.directory,
              model: input.model,
              variant: input.variant ?? null
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
        reconcile: operation === "handoff" && typeof reconcileHandoff === "function"
          ? (recovery) => reconcileHandoff(agentID, sessionID, input, recovery)
          : undefined,
        dispatch: ({ checkpoint }) => operation === "prompt"
          ? promptSession(agentID, sessionID, input)
          : operation === "command"
            ? commandSession(agentID, sessionID, input)
            : operation === "stop"
              ? stopSession(agentID, sessionID, input)
              : handoffSession(agentID, sessionID, input, { checkpoint })
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
