import { taskLaunchError } from "./task-errors.js"

function basicAuthorization(username, password) {
  if (!username && !password) return undefined
  return `Basic ${Buffer.from(`${username ?? ""}:${password ?? ""}`).toString("base64")}`
}

function httpHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
}

async function responseJSON(response, label) {
  if (!response.ok) {
    let detail = ""
    try {
      const body = await response.json()
      detail = typeof body?.error === "string" ? `: ${body.error}` : ""
    } catch {}
    throw new Error(`${label} failed with HTTP ${response.status}${detail}`)
  }
  return response.json()
}

export class TaskLauncher {
  constructor({ daemon, fetchImpl = fetch }) {
    this.daemon = daemon
    this.fetchImpl = fetchImpl
  }

  async createSession(task) {
    const entry = this.daemon.hostEntry(task.agentId)
    if (!entry) throw taskLaunchError("unknown_agent", `Unknown agent: ${task.agentId}`)
    if (this.daemon.registry.host(task.agentId)?.state === "unavailable") {
      throw taskLaunchError("agent_unavailable", `Agent ${task.agentId} is unavailable`)
    }
    if (!task.workspace?.path) throw taskLaunchError("workspace_required", "Task workspace is not prepared")

    if (entry.kind === "acp") {
      await entry.host.start()
      const result = await entry.host.request("session/new", { cwd: task.workspace.path, mcpServers: [] })
      if (!result?.sessionId) throw new Error(`Agent ${task.agentId} did not return a session id`)
      return { sessionId: result.sessionId, transport: "acp", directory: task.workspace.path }
    }

    if (entry.kind === "http") {
      await entry.host.start?.()
      const host = entry.host.readinessHost ?? entry.host.host ?? "127.0.0.1"
      const base = `http://${httpHost(host)}:${entry.host.port}`
      const authorization = basicAuthorization(entry.host.username, entry.host.password)
      const response = await this.fetchImpl(`${base}/session?directory=${encodeURIComponent(task.workspace.path)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authorization ? { Authorization: authorization } : {})
        },
        body: JSON.stringify({ title: `Task ${task.id.slice(0, 8)}` })
      })
      const session = await responseJSON(response, `Creating ${task.agentId} session`)
      if (!session?.id) throw new Error(`Agent ${task.agentId} did not return a session id`)
      return { sessionId: session.id, transport: "http", directory: task.workspace.path, base, authorization }
    }

    throw taskLaunchError("unsupported_agent", `Agent ${task.agentId} cannot launch tasks`)
  }

  async startPrompt(task, run, onPromptFailed) {
    const entry = this.daemon.hostEntry(task.agentId)
    if (!entry) throw taskLaunchError("unknown_agent", `Unknown agent: ${task.agentId}`)

    if (entry.kind === "acp") {
      void entry.host.request("session/prompt", {
        sessionId: run.sessionId,
        prompt: [{ type: "text", text: task.prompt }]
      }, 300_000).catch((error) => {
        onPromptFailed?.(error)
      })
      return
    }

    if (entry.kind === "http") {
      const response = await this.fetchImpl(`${run.base}/session/${encodeURIComponent(run.sessionId)}/prompt_async?directory=${encodeURIComponent(task.workspace.path)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(run.authorization ? { Authorization: run.authorization } : {})
        },
        body: JSON.stringify({ parts: [{ type: "text", text: task.prompt }] })
      })
      if (!response.ok) throw new Error(`Starting ${task.agentId} task failed with HTTP ${response.status}`)
    }
  }
}
