#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

const PREFIX = "HARNESS_SMOKE_OK"

function usage() {
  return [
    "Usage: node bridge/scripts/real-harness-smoke.mjs --base-url <url> --agent <pi|omp|opencode> --username <name> --password <value> --workspace <path> --report <path>",
    "",
    "Runs one authenticated real-harness smoke test. It creates a disposable session, waits for model discovery,",
    "asks the agent to create one uniquely named file, and verifies both the file and an agent reply."
  ].join("\n")
}

function parseArgs(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (option === "--help") return { help: true }
    if (!option.startsWith("--")) throw new Error(`Unknown argument: ${option}`)
    const value = args[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`)
    options[option.slice(2)] = value
    index += 1
  }
  for (const required of ["base-url", "agent", "username", "password", "workspace", "report"]) {
    if (!options[required]) throw new Error(`--${required} is required`)
  }
  if (!["pi", "omp", "opencode"].includes(options.agent)) throw new Error("--agent must be pi, omp, or opencode")
  return options
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function run(options) {
  const startedAt = new Date().toISOString()
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const marker = `.harness-remote-smoke-${token}.txt`
  const markerPath = path.join(options.workspace, marker)
  const agentPrefix = `/v1/agents/${encodeURIComponent(options.agent)}`
  const auth = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`
  const result = {
    schemaVersion: 1,
    backend: options.agent,
    startedAt,
    completedAt: undefined,
    token,
    marker,
    checks: []
  }

  async function request(label, pathname, init = {}) {
    const response = await fetch(new URL(pathname, options["base-url"]), {
      ...init,
      headers: { Authorization: auth, ...(init.headers ?? {}) }
    })
    const text = await response.text()
    let body
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = text
    }
    result.checks.push({ label, status: response.status })
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`)
    return body
  }

  async function retry(label, operation, timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs
    let lastError
    while (Date.now() < deadline) {
      try {
        const value = await operation()
        if (value) return value
      } catch (error) {
        lastError = error
      }
      await delay(2_000)
    }
    throw new Error(`${label} did not succeed within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ""}`)
  }

  try {
    await request("machine registry", "/v1/machine")
    const healthPath = options.agent === "opencode" ? "/global/health" : "/v1/health"
    await retry("health", () => request("health", `${agentPrefix}${healthPath}`), 90_000)

    const sessionPath = `${agentPrefix}/session?directory=${encodeURIComponent(options.workspace)}`
    await request("session listing", sessionPath)
    const session = await request("session creation", sessionPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `Harness real smoke ${token}` })
    })
    const sessionID = session?.id
    if (typeof sessionID !== "string" || !sessionID) throw new Error("Session creation did not return a session id")
    result.sessionID = sessionID

    const providers = await retry("model discovery", async () => {
      const body = await request("model discovery", `${agentPrefix}/config/providers?sessionID=${encodeURIComponent(sessionID)}`)
      return Array.isArray(body?.providers) && body.providers.some((provider) => Object.keys(provider?.models ?? {}).length > 0) ? body : undefined
    }, 90_000)
    result.modelProviders = providers.providers.map((provider) => provider.id)

    const instruction = [
      "This is a Harness Remote integration test.",
      `Use your available tools to create exactly one file named ${marker} in the current workspace.`,
      `Its complete contents must be: ${PREFIX} ${token}`,
      `Then reply with exactly: ${PREFIX} ${token}`,
      "Do not modify any other file."
    ].join(" ")
    await request("prompt accepted", `${agentPrefix}/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: instruction }] })
    })

    await retry("workspace mutation", async () => {
      const content = await readFile(markerPath, "utf8")
      return content.trim() === `${PREFIX} ${token}`
    }, 180_000)

    await retry("assistant completion", async () => {
      const messages = await request("message history", `${agentPrefix}/session/${encodeURIComponent(sessionID)}/message?refresh=1`)
      return Array.isArray(messages) && messages.some((message) => {
        const role = message?.info?.role
        const text = (message?.parts ?? []).map((part) => part?.text ?? "").join("\n")
        return (role === "assistant" || role === "agent") && text.includes(`${PREFIX} ${token}`)
      })
    }, 180_000)

    result.success = true
  } catch (error) {
    result.success = false
    result.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    result.completedAt = new Date().toISOString()
    await mkdir(path.dirname(options.report), { recursive: true })
    await writeFile(options.report, `${JSON.stringify(result, null, 2)}\n`)
  }
}

let options
try {
  options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage()}\n`)
  } else {
    await run(options)
    process.stdout.write(`Real ${options.agent} harness smoke test passed.\n`)
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
