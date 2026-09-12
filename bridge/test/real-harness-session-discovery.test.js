import assert from "node:assert/strict"
import test from "node:test"
import { verifyRealHarnessSessionDiscovery } from "../scripts/real-harness-session-discovery.mjs"

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  })
}

test("health-checks, versions, creates and rediscovers the exact native Session for every requested harness", async () => {
  const calls = []
  const created = new Map([
    ["codex", "codex-created"],
    ["omp", "omp-created"]
  ])
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? "GET", authorization: options.headers?.Authorization })
    const parsed = new URL(url)
    const match = /^\/v1\/agents\/([^/]+)\/(.*)$/.exec(parsed.pathname)
    const agentID = decodeURIComponent(match?.[1] ?? "")
    const rest = match?.[2] ?? ""
    if (rest === "global/health") {
      return jsonResponse({ healthy: true, version: `${agentID}-1.2.3` })
    }
    if (options.method === "POST" && rest === "session") {
      return jsonResponse({ id: created.get(agentID) })
    }
    if (rest === "experimental/session") {
      if (agentID === "codex" && !parsed.searchParams.get("cursor")) {
        return jsonResponse([{ id: "older-codex" }], 200, { "X-Next-Cursor": "page-2" })
      }
      return jsonResponse([{ id: created.get(agentID) }])
    }
    return jsonResponse({ error: "unexpected route" }, 404)
  }

  const result = await verifyRealHarnessSessionDiscovery({
    harnesses: ["codex", "omp"],
    urlRoot: "http://127.0.0.1:4097",
    user: "harness",
    pass: "secret",
    directory: "/work/private-project",
    fetchImpl
  })

  assert.equal(result.schemaVersion, 2)
  assert.equal(result.passed, true)
  assert.deepEqual(result.results.map(({ agentID, healthy, version, versionKnown, discovered, pages }) => ({ agentID, healthy, version, versionKnown, discovered, pages })), [
    { agentID: "codex", healthy: true, version: "codex-1.2.3", versionKnown: true, discovered: true, pages: 2 },
    { agentID: "omp", healthy: true, version: "omp-1.2.3", versionKnown: true, discovered: true, pages: 1 }
  ])
  assert.ok(calls.every((call) => call.authorization?.startsWith("Basic ")))
  assert.equal(calls.filter((call) => call.url.endsWith("/global/health")).length, 2)
  assert.equal(JSON.stringify(result).includes("secret"), false)
  assert.equal(JSON.stringify(result).includes("private-project"), false)
})

test("fails before Session creation when an installed harness cannot pass its health boundary", async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? "GET" })
    return jsonResponse({ healthy: false, version: "9.9.9" }, 503)
  }

  const result = await verifyRealHarnessSessionDiscovery({
    harnesses: ["claude"],
    directory: "/work/project",
    fetchImpl
  })

  assert.equal(result.passed, false)
  assert.equal(result.results[0].healthy, false)
  assert.equal(result.results[0].healthStatus, 503)
  assert.equal(result.results[0].version, "9.9.9")
  assert.equal(result.results[0].created, false)
  assert.equal(calls.some((call) => call.method === "POST"), false)
  assert.match(result.results[0].error, /health check returned HTTP 503/i)
})

test("fails traceability before Session creation when the harness version is unknown", async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? "GET" })
    return jsonResponse({ healthy: true, version: "unknown" })
  }

  const result = await verifyRealHarnessSessionDiscovery({
    harnesses: ["codex"],
    directory: "/work/project",
    fetchImpl
  })

  assert.equal(result.passed, false)
  assert.equal(result.results[0].healthy, true)
  assert.equal(result.results[0].version, "unknown")
  assert.equal(result.results[0].versionKnown, false)
  assert.equal(result.results[0].created, false)
  assert.equal(calls.some((call) => call.method === "POST"), false)
  assert.match(result.results[0].error, /concrete version/i)
})

test("fails closed when creation succeeds but the native index cannot rediscover that id", async () => {
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/global/health")) return jsonResponse({ healthy: true, version: "1.0.0" })
    if (options.method === "POST") return jsonResponse({ id: "created-but-hidden" })
    return jsonResponse([{ id: "some-other-session" }])
  }

  const result = await verifyRealHarnessSessionDiscovery({
    harnesses: ["claude"],
    directory: "/work/project",
    fetchImpl
  })

  assert.equal(result.passed, false)
  assert.equal(result.results[0].healthy, true)
  assert.equal(result.results[0].created, true)
  assert.equal(result.results[0].discovered, false)
  assert.match(result.results[0].error, /absent from discovery/i)
})

test("bounds pagination instead of scanning an unbounded native Session index", async () => {
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/global/health")) return jsonResponse({ healthy: true, version: "1.0.0" })
    if (options.method === "POST") return jsonResponse({ id: "target" })
    return jsonResponse([{ id: "older" }], 200, { "X-Next-Cursor": "again" })
  }

  const result = await verifyRealHarnessSessionDiscovery({
    harnesses: ["pi"],
    directory: "/work/project",
    fetchImpl,
    maxPages: 2
  })

  assert.equal(result.passed, false)
  assert.equal(result.results[0].pages, 2)
  assert.match(result.results[0].error, /bounded 2-page scan/i)
})

test("sanitizes transport failures before they enter release evidence", async () => {
  const result = await verifyRealHarnessSessionDiscovery({
    harnesses: ["opencode"],
    urlRoot: "http://private-user:private-pass@127.0.0.1:4097",
    directory: "/work/private-project",
    fetchImpl: async (url) => {
      throw new Error(`could not fetch ${url}`)
    }
  })

  const evidence = JSON.stringify(result)
  assert.equal(result.passed, false)
  assert.match(result.results[0].error, /failed before receiving an HTTP response/i)
  assert.equal(evidence.includes("private-user"), false)
  assert.equal(evidence.includes("private-pass"), false)
  assert.equal(evidence.includes("private-project"), false)
})
