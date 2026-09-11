import http from "node:http"
import { authenticateDaemonRequest, writeJSON } from "./http-policy.js"

export const APPROVAL_DECISION_ROUTE = "/v1/approval-decisions"
const MAX_BODY_BYTES = 64 * 1024

function requestError(message) {
  const error = new Error(message)
  error.code = "invalid_request"
  return error
}

async function readJSONBody(request) {
  let body = ""
  for await (const chunk of request) {
    body += chunk
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw requestError("Approval decision request is too large")
  }
  if (!body) return {}
  try { return JSON.parse(body) } catch { throw requestError("Approval decision request must be valid JSON") }
}

function identityInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw requestError("Native Session identity is required")
  const machineID = typeof value.machineID === "string" ? value.machineID.trim() : ""
  const agentID = typeof value.agentID === "string" ? value.agentID.trim() : ""
  const sessionID = typeof value.sessionID === "string" ? value.sessionID.trim() : ""
  const directory = typeof value.directory === "string" ? value.directory : ""
  if (![machineID, agentID, sessionID, directory].every(Boolean)) throw requestError("Native Session identity is incomplete")
  return { machineID, agentID, sessionID, directory }
}

function queryIdentity(url) {
  return identityInput({
    machineID: url.searchParams.get("machineID") || "",
    agentID: url.searchParams.get("agentID") || "",
    sessionID: url.searchParams.get("sessionID") || "",
    directory: url.searchParams.get("directory") || ""
  })
}

/**
 * Authenticated control-plane metadata endpoint. A POST records only a decision the client says the
 * native harness has already accepted. This wrapper never forwards, grants, retries or replays a
 * permission decision; the native harness remains the sole authorization authority.
 */
export function createApprovalDecisionServer({ innerServer, config, store, createServer = http.createServer }) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    if (url.pathname !== APPROVAL_DECISION_ROUTE) {
      innerServer.emit("request", request, response)
      return
    }

    if (!authenticateDaemonRequest(request, response, config)) return

    try {
      if (!store) throw new Error("Approval decision store is not configured")
      if (request.method === "GET") {
        writeJSON(response, 200, { decisions: await store.listFor(queryIdentity(url)) })
        return
      }
      if (request.method === "POST") {
        const body = await readJSONBody(request)
        const identity = identityInput(body)
        writeJSON(response, 200, { decision: await store.record({ ...body, ...identity }) })
        return
      }
      response.writeHead(405, { Allow: "GET, POST, OPTIONS" })
      response.end()
    } catch (error) {
      writeJSON(response, error?.code === "invalid_request" ? 400 : 409, {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
}
