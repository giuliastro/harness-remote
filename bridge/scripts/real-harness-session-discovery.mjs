function authorization(user = process.env.HR_USER ?? "", pass = process.env.HR_PASS ?? "") {
  return `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`
}

function sessionID(entry) {
  return entry?.id ?? entry?.sessionID ?? entry?.sessionId ?? null
}

function sessionList(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.sessions)) return value.sessions
  return []
}

function harnessVersion(value) {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized || null
}

async function requestJSON(url, {
  method = "GET",
  body,
  authorizationHeader,
  fetchImpl,
  timeoutMs
}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: authorizationHeader,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    })
    const text = await response.text()
    let data
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    return { response, data, transportError: null }
  } catch (error) {
    return {
      response: null,
      data: null,
      transportError: error?.name === "AbortError"
        ? `Request timed out after ${timeoutMs}ms.`
        : "Request failed before receiving an HTTP response."
    }
  } finally {
    clearTimeout(timer)
  }
}

async function listNativeSessions({
  root,
  agentID,
  directory,
  authorizationHeader,
  fetchImpl,
  timeoutMs,
  maxPages
}) {
  const ids = new Set()
  let cursor
  let pages = 0
  let lastStatus = 0

  while (pages < maxPages) {
    const query = new URLSearchParams()
    query.set("directory", directory)
    if (cursor) query.set("cursor", cursor)
    const result = await requestJSON(
      `${root}/v1/agents/${encodeURIComponent(agentID)}/experimental/session?${query.toString()}`,
      { authorizationHeader, fetchImpl, timeoutMs }
    )
    pages += 1
    lastStatus = result.response?.status ?? 0
    if (!result.response?.ok) {
      return {
        passed: false,
        status: lastStatus,
        pages,
        ids: [...ids],
        error: result.transportError ?? `Session discovery returned HTTP ${lastStatus}.`
      }
    }

    for (const entry of sessionList(result.data)) {
      const id = sessionID(entry)
      if (id) ids.add(String(id))
    }

    cursor = result.response.headers.get("x-next-cursor")
      ?? result.response.headers.get("x-cursor")
      ?? result.data?.nextCursor
      ?? null
    if (!cursor) break
  }

  return {
    passed: !cursor,
    status: lastStatus,
    pages,
    ids: [...ids],
    exhausted: Boolean(cursor),
    error: cursor ? `Session discovery exceeded the bounded ${maxPages}-page scan.` : null
  }
}

export async function verifyRealHarnessSessionDiscovery({
  harnesses,
  urlRoot = process.env.HR_URL ?? "http://127.0.0.1:4097",
  user = process.env.HR_USER ?? "",
  pass = process.env.HR_PASS ?? "",
  directory = process.env.HR_DIR_A ?? process.cwd(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  maxPages = 12
}) {
  const root = urlRoot.replace(/\/$/, "")
  const authorizationHeader = authorization(user, pass)
  const results = []

  for (const agentID of harnesses) {
    // A configured registry entry is not release evidence that the installed harness can actually
    // start. Probe the same agent-scoped health route the product uses first, and retain the harness
    // version it reports so the resulting evidence identifies which installed build was exercised.
    const health = await requestJSON(
      `${root}/v1/agents/${encodeURIComponent(agentID)}/global/health`,
      { authorizationHeader, fetchImpl, timeoutMs }
    )
    const healthStatus = health.response?.status ?? 0
    const version = harnessVersion(health.data?.version)
    const versionKnown = Boolean(version && version.toLowerCase() !== "unknown")
    const healthy = Boolean(health.response?.ok && health.data?.healthy === true)
    if (!healthy) {
      results.push({
        agentID,
        passed: false,
        healthy: false,
        healthStatus,
        version,
        versionKnown,
        created: false,
        createStatus: 0,
        discovered: false,
        listStatus: 0,
        pages: 0,
        error: health.transportError
          ?? (health.response?.ok
            ? "Harness health check did not report healthy=true."
            : `Harness health check returned HTTP ${healthStatus}.`)
      })
      continue
    }
    if (!versionKnown) {
      results.push({
        agentID,
        passed: false,
        healthy: true,
        healthStatus,
        version,
        versionKnown: false,
        created: false,
        createStatus: 0,
        discovered: false,
        listStatus: 0,
        pages: 0,
        error: "Harness health check did not report a concrete version."
      })
      continue
    }

    const created = await requestJSON(
      `${root}/v1/agents/${encodeURIComponent(agentID)}/session?directory=${encodeURIComponent(directory)}`,
      {
        method: "POST",
        body: { title: `Harness Remote release-gate discovery (${agentID})` },
        authorizationHeader,
        fetchImpl,
        timeoutMs
      }
    )
    const createdID = sessionID(created.data)
    if (!created.response?.ok || !createdID) {
      const createStatus = created.response?.status ?? 0
      results.push({
        agentID,
        passed: false,
        healthy: true,
        healthStatus,
        version,
        versionKnown,
        created: false,
        createStatus,
        discovered: false,
        listStatus: 0,
        pages: 0,
        error: created.transportError
          ?? (created.response?.ok
            ? "Native Session creation did not return an id."
            : `Native Session creation returned HTTP ${createStatus}.`)
      })
      continue
    }

    const listed = await listNativeSessions({
      root,
      agentID,
      directory,
      authorizationHeader,
      fetchImpl,
      timeoutMs,
      maxPages
    })
    const discovered = listed.passed && listed.ids.includes(String(createdID))
    results.push({
      agentID,
      passed: discovered,
      healthy: true,
      healthStatus,
      version,
      versionKnown,
      created: true,
      createStatus: created.response.status,
      createdSessionID: String(createdID),
      discovered,
      listStatus: listed.status,
      pages: listed.pages,
      error: listed.error ?? (discovered ? null : "Newly created native Session was absent from discovery results.")
    })
  }

  return {
    schemaVersion: 2,
    passed: results.length === harnesses.length && results.every((result) => result.passed),
    results
  }
}
