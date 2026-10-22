import { createHash } from "node:crypto"
import http from "node:http"
import { authenticateDaemonRequest, writeJSON } from "./http-policy.js"
import { runIdempotentMutation } from "./session-operation-ledger.js"

const TARGET_HANDOFF_ROUTE = "/v1/session-handoff-target"
const MAX_BODY_BYTES = 1_000_000
const TARGET_CREATION_LEDGER_NAMESPACE = "cross-machine-handoff"

function requestError(message, code = "invalid_request") {
  const error = new Error(message)
  error.code = code
  return error
}

function statusForError(error) {
  if (error?.code === "invalid_request") return 400
  if (error?.code === "unknown_project" || error?.code === "unknown_agent") return 404
  if (error?.code === "agent_unavailable") return 503
  if (["unsupported_agent", "handoff_rejected", "idempotency_conflict", "model_variant_unavailable"].includes(error?.code)) return 409
  return 500
}

async function readJSONBody(request) {
  let body = ""
  for await (const chunk of request) {
    body += chunk
    if (body.length > MAX_BODY_BYTES) throw requestError("Request body is too large")
  }
  if (!body) return {}
  try { return JSON.parse(body) }
  catch { throw requestError("Request body must be valid JSON") }
}

function nativeSessionIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw requestError("Source Session identity is required")
  const machineID = typeof value.machineID === "string" ? value.machineID.trim() : ""
  const agentID = typeof value.agentID === "string" ? value.agentID.trim() : ""
  const sessionID = typeof value.sessionID === "string" ? value.sessionID.trim() : ""
  const directory = typeof value.directory === "string" ? value.directory : ""
  if (![machineID, agentID, sessionID, directory].every(Boolean)) throw requestError("Source Session identity is incomplete")
  return { machineID, agentID, sessionID, directory }
}

function modelInput(value) {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== "object" || Array.isArray(value)) throw requestError("Target model must be an object")
  const providerID = typeof value.providerID === "string" ? value.providerID.trim() : ""
  const modelID = typeof value.modelID === "string" ? value.modelID.trim() : ""
  if (!providerID || !modelID) throw requestError("Target model requires providerID and modelID")
  return { providerID, modelID }
}

function targetInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw requestError("Request body must be a JSON object")
  if (Object.hasOwn(body, "directory") || Object.hasOwn(body, "targetDirectory")) {
    throw requestError("Target directory is derived from projectId and cannot be supplied by the client")
  }
  const clientRequestId = typeof body.clientRequestId === "string" ? body.clientRequestId.trim() : ""
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : ""
  const targetAgentID = typeof body.targetAgentID === "string" ? body.targetAgentID.trim() : ""
  const source = nativeSessionIdentity(body.source)
  const model = modelInput(body.model)
  const variant = typeof body.variant === "string" && body.variant.trim() ? body.variant.trim() : undefined
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : undefined
  if (!clientRequestId || clientRequestId.length > 200) throw requestError("A valid clientRequestId is required")
  if (!projectId || projectId.length > 500) throw requestError("A valid target projectId is required")
  if (!targetAgentID || targetAgentID.length > 200) throw requestError("A valid targetAgentID is required")
  return { clientRequestId, projectId, targetAgentID, source, model, variant, title }
}

function signature(input) {
  return createHash("sha256").update(JSON.stringify({
    operation: "cross-machine-target-create-v1",
    source: input.source,
    projectId: input.projectId,
    targetAgentID: input.targetAgentID,
    model: input.model,
    variant: input.variant ?? null,
    title: input.title ?? null
  })).digest("hex")
}

/**
 * SessionOperationLedger requires an agent/session tuple because its original consumers mutate one
 * local native Session. A cross-machine target does not have a target Session yet, so use a reserved
 * ledger namespace plus an opaque scope derived from the complete source identity. Target harness,
 * Project/model/title/variant deliberately do not change this key: they live in the mutation
 * signature, so reusing one source-scoped clientRequestId with changed target semantics conflicts
 * instead of silently creating a second resource. The hash also prevents collisions between two
 * machines whose harnesses happen to use the same native Session id and never exposes a path in
 * diagnostics. Neither field is ever presented as a native Session identity.
 */
export function targetCreationLedgerIdentity(input) {
  const sourceDigest = createHash("sha256").update(JSON.stringify(input.source)).digest("hex")
  return {
    agentID: TARGET_CREATION_LEDGER_NAMESPACE,
    sessionID: `handoff-source:${sourceDigest}`,
    clientRequestId: input.clientRequestId
  }
}

/**
 * Authenticated target-daemon boundary for cross-machine continuation.
 *
 * This server deliberately does not deliver the first prompt. It only creates/checkpoints the target
 * native Session. The target filesystem path is resolved from the daemon's Project catalog, never
 * from client input. Writer ownership, approvals, tool state and transcript state are not accepted
 * by this contract and therefore cannot cross the machine boundary accidentally.
 */
export function createCrossMachineHandoffServer({
  innerServer,
  config,
  projectCatalog,
  operationLedger,
  createTargetSession,
  reconcileTargetSession,
  createServer = http.createServer
}) {
  return createServer(async (request, response) => {
    const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    if (requestURL.pathname !== TARGET_HANDOFF_ROUTE) {
      innerServer.emit("request", request, response)
      return
    }
    if (!authenticateDaemonRequest(request, response, config)) return
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST, OPTIONS" })
      response.end()
      return
    }

    try {
      if (!operationLedger) throw new Error("Native Session operation ledger is not configured")
      if (typeof projectCatalog !== "function") throw new Error("Project catalog is not configured")
      if (typeof createTargetSession !== "function") throw new Error("Target Session creation is not configured")
      const input = targetInput(await readJSONBody(request))
      const projects = await projectCatalog()
      const project = projects.find((candidate) => candidate.id === input.projectId)
      if (!project) throw requestError(`Unknown project: ${input.projectId}`, "unknown_project")

      const identity = targetCreationLedgerIdentity(input)
      const result = await runIdempotentMutation({
        operationLedger,
        identity,
        signature: signature(input),
        reconcile: typeof reconcileTargetSession === "function"
          ? (recovery) => reconcileTargetSession({ ...input, project }, recovery)
          : undefined,
        dispatch: ({ checkpoint }) => createTargetSession({ ...input, project }, { checkpoint })
      })
      writeJSON(response, result.status === "accepted" ? 200 : 202, {
        status: result.status,
        clientRequestId: input.clientRequestId,
        ...(result.result ? { result: result.result } : {})
      })
    } catch (error) {
      writeJSON(response, statusForError(error), {
        error: error instanceof Error ? error.message : String(error),
        ...(error?.code ? { code: error.code } : {})
      })
    }
  })
}
