function basicAuthorization(username, password) {
  if (!username && !password) return undefined
  return `Basic ${Buffer.from(`${username ?? ""}:${password ?? ""}`).toString("base64")}`
}

function httpHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
}

function runAgent(task) {
  return task?.run?.agentId || task?.agentId || ""
}

export async function abortWorkThreadRun(task, taskRunController) {
  const run = task?.run
  const sessionID = run?.sessionId || run?.sessionID
  if (!sessionID) return false
  const agentID = runAgent(task)

  if (run.transport === "acp") {
    const service = taskRunController.acpService?.(agentID)
    if (!service) throw new Error(`Cannot stop ${agentID}: native ACP session service is unavailable`)
    await service.abort(sessionID)
    return true
  }

  if (run.transport === "http") {
    const launcher = taskRunController.taskLauncher
    const entry = launcher?.daemon?.hostEntry?.(agentID)
    if (!entry || entry.kind !== "http") throw new Error(`Cannot stop ${agentID}: managed HTTP harness is unavailable`)
    await entry.host.start?.()
    const host = entry.host.readinessHost ?? entry.host.host ?? "127.0.0.1"
    const authorization = basicAuthorization(entry.host.username, entry.host.password)
    const directory = task.workspace?.path ?? run.directory ?? ""
    const response = await launcher.fetchImpl(`http://${httpHost(host)}:${entry.host.port}/session/${encodeURIComponent(sessionID)}/abort?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
      body: "{}"
    })
    if (!response.ok) throw new Error(`Stopping ${agentID} failed with HTTP ${response.status}`)
    return true
  }

  throw new Error(`Cannot stop ${agentID}: unsupported native session transport`)
}
