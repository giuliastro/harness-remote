#!/usr/bin/env node

const DEFAULT_AGENTS = ["opencode", "codex", "claude", "pi", "omp"]
const MODEL_WAIT_MS = 4_000
const MODEL_POLL_MS = 750
const MODEL_TOTAL_MS = 120_000
const REQUEST_TIMEOUT_MS = 12_000

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function baseURL(value) {
  const url = new URL(value)
  url.pathname = url.pathname.replace(/\/$/, "")
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}

function authHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function requestJSON(url, authorization, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", Authorization: authorization },
      signal: controller.signal
    })
    const text = await response.text()
    let body
    try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
    return { status: response.status, body }
  } finally {
    clearTimeout(timer)
  }
}

async function loadCatalog(root, agentID, authorization) {
  const startedAt = Date.now()
  let attempts = 0
  let last
  while (Date.now() - startedAt < MODEL_TOTAL_MS) {
    attempts += 1
    try {
      last = await requestJSON(
        `${root}/v1/agents/${encodeURIComponent(agentID)}/models?waitMs=${MODEL_WAIT_MS}`,
        authorization,
        MODEL_WAIT_MS + REQUEST_TIMEOUT_MS
      )
    } catch (error) {
      last = { status: 0, body: { error: error instanceof Error ? error.message : String(error) } }
    }
    if (last.status !== 202 && last.body?.loading !== true) {
      return { attempts, durationMs: Date.now() - startedAt, ...last }
    }
    await sleep(MODEL_POLL_MS)
  }
  return {
    attempts,
    durationMs: Date.now() - startedAt,
    status: last?.status ?? 0,
    body: { ...(last?.body ?? {}), error: `Catalog still loading after ${MODEL_TOTAL_MS}ms` }
  }
}

function catalogSummary(result) {
  const body = result.body && typeof result.body === "object" ? result.body : {}
  const models = Array.isArray(body.models) ? body.models : []
  return {
    status: result.status,
    attempts: result.attempts,
    durationMs: result.durationMs,
    source: body.source ?? null,
    stale: Boolean(body.stale),
    refreshedAt: body.refreshedAt ?? null,
    error: body.error ?? body.lastError ?? null,
    modelCount: models.length,
    variants: models
      .filter((model) => typeof model?.variant === "string" && model.variant)
      .map((model) => ({
        providerID: model.providerID,
        modelID: model.modelID,
        variant: model.variant,
        variantConfigId: model.variantConfigId ?? null
      })),
    models
  }
}

async function main() {
  const root = baseURL(required("HARNESS_REMOTE_URL"))
  const username = required("HARNESS_REMOTE_USERNAME")
  const password = required("HARNESS_REMOTE_PASSWORD")
  const authorization = authHeader(username, password)
  const agents = (process.env.HARNESS_REMOTE_AUDIT_AGENTS || DEFAULT_AGENTS.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)

  const report = {
    generatedAt: new Date().toISOString(),
    server: root,
    agents,
    diagnosticsBefore: null,
    catalogs: {},
    diagnosticsAfter: null
  }

  try {
    const result = await requestJSON(`${root}/v1/diagnostics`, authorization)
    report.diagnosticsBefore = { status: result.status, body: result.body }
  } catch (error) {
    report.diagnosticsBefore = { status: 0, body: { error: error instanceof Error ? error.message : String(error) } }
  }

  for (const agentID of agents) {
    report.catalogs[agentID] = catalogSummary(await loadCatalog(root, agentID, authorization))
  }

  try {
    const result = await requestJSON(`${root}/v1/diagnostics`, authorization)
    report.diagnosticsAfter = { status: result.status, body: result.body }
  } catch (error) {
    report.diagnosticsAfter = { status: 0, body: { error: error instanceof Error ? error.message : String(error) } }
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
