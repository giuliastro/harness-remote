import { spawn } from "node:child_process"

/**
 * A harness knows its own models without being asked through a session. `pi --list-models` prints
 * them, and the session-scoped ACP config option is only one way of finding out — the one that
 * happens to need a session, which is exactly what a task does not have until it launches.
 *
 * The output shape is not standardised across harnesses, so parse tolerantly: JSON if it is JSON,
 * one model per line otherwise, ignoring decoration a CLI adds for humans.
 */
export function parseModelListing(output) {
  const text = String(output ?? "").trim()
  if (!text) return []

  try {
    const parsed = JSON.parse(text)
    const list = Array.isArray(parsed) ? parsed : parsed?.models ?? parsed?.data
    if (Array.isArray(list)) {
      return list
        .map((entry) => (typeof entry === "string" ? entry : entry?.id ?? entry?.value ?? entry?.model))
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => ({ value: value.trim(), label: value.trim() }))
    }
  } catch {
    // Not JSON. Fall through to the line reading below.
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s*\-•]+/, "").trim())
    .filter(Boolean)
    // A heading or a sentence is not a model id: real ones carry no spaces.
    .filter((line) => !/\s/.test(line))
    .map((value) => ({ value, label: value }))
}

export function createModelCatalogLoader(profile, { spawnProcess = spawn, timeoutMs = 10_000 } = {}) {
  if (!profile?.modelListing) return undefined
  const { command, args } = profile.modelListing
  return () => new Promise((resolve) => {
    let output = ""
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawnProcess(command, args, { stdio: ["ignore", "pipe", "ignore"] })
    } catch {
      // A harness that cannot be asked is not an error: the session catalog remains the answer.
      return finish([])
    }
    const timer = setTimeout(() => {
      child.kill?.()
      finish([])
    }, timeoutMs)
    child.stdout?.setEncoding?.("utf8")
    child.stdout?.on?.("data", (chunk) => { output += chunk })
    child.on?.("error", () => { clearTimeout(timer); finish([]) })
    child.on?.("exit", (code) => {
      clearTimeout(timer)
      finish(code === 0 ? parseModelListing(output) : [])
    })
  })
}
