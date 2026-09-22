#!/usr/bin/env node
import path from "node:path"
import { fileURLToPath } from "node:url"

export const REQUIRED_PROVIDER_SECRETS = Object.freeze([
  {
    name: "OPENAI_API_KEY",
    harnesses: ["opencode", "codex", "omp", "pi", "opencode2"]
  },
  {
    name: "ANTHROPIC_API_KEY",
    harnesses: ["claude"]
  },
  {
    name: "MIMO_API_KEY",
    harnesses: ["mimo"]
  }
])

export function realAuthCredentialPlan(environment = process.env) {
  const configured = REQUIRED_PROVIDER_SECRETS
    .filter(({ name }) => Boolean(String(environment[name] ?? "").trim()))
    .map(({ name, harnesses }) => ({ name, harnesses: [...harnesses] }))
  const missing = REQUIRED_PROVIDER_SECRETS
    .filter(({ name }) => !String(environment[name] ?? "").trim())
    .map(({ name, harnesses }) => ({ name, harnesses: [...harnesses] }))

  const copilot = String(environment.COPILOT_GITHUB_TOKEN ?? "").trim()
    ? { source: "COPILOT_GITHUB_TOKEN", configured: true }
    : String(environment.GITHUB_TOKEN ?? "").trim()
      ? { source: "GITHUB_TOKEN", configured: true }
      : { source: null, configured: false }

  return { configured, missing, copilot }
}

export function validateMimoInlineConfig(environment = process.env) {
  const raw = String(environment.HARNESS_REMOTE_MIMO_CONFIG_CONTENT ?? "").trim()
  if (!raw) return { configured: false, safeEnvReference: false }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("HARNESS_REMOTE_MIMO_CONFIG_CONTENT must be valid JSON.")
  }

  const serialized = JSON.stringify(parsed)
  if (!serialized.includes("{env:MIMO_API_KEY}")) {
    throw new Error("HARNESS_REMOTE_MIMO_CONFIG_CONTENT must reference {env:MIMO_API_KEY}; do not embed the key itself.")
  }
  const key = String(environment.MIMO_API_KEY ?? "")
  if (key && serialized.includes(key)) {
    throw new Error("HARNESS_REMOTE_MIMO_CONFIG_CONTENT contains the literal MiMo key. Use {env:MIMO_API_KEY} instead.")
  }

  return { configured: true, safeEnvReference: true }
}

export function assertRealAuthEnvironment(environment = process.env) {
  const plan = realAuthCredentialPlan(environment)
  const problems = []

  if (plan.missing.length) {
    problems.push(`Missing GitHub Actions secret(s): ${plan.missing.map(({ name }) => name).join(", ")}`)
  }
  if (!plan.copilot.configured) {
    problems.push("Copilot authentication is missing: provide the workflow GITHUB_TOKEN with copilot-requests: write, or COPILOT_GITHUB_TOKEN.")
  }

  const mimo = validateMimoInlineConfig(environment)
  if (!mimo.configured) {
    problems.push("HARNESS_REMOTE_MIMO_CONFIG_CONTENT is not configured for non-interactive MiMo inference.")
  }

  if (problems.length) {
    throw new Error(problems.join("\n"))
  }

  return { ...plan, mimo }
}

export function printSafeCredentialSummary(plan) {
  for (const item of plan.configured) {
    console.log(`ok  ${item.name} configured for ${item.harnesses.join(", ")}`)
  }
  console.log(`ok  Copilot credential source: ${plan.copilot.source}`)
  console.log("ok  MiMo inline config references MIMO_API_KEY by environment name")
}

function isDirectInvocation() {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
}

if (isDirectInvocation()) {
  try {
    const plan = assertRealAuthEnvironment(process.env)
    printSafeCredentialSummary(plan)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  }
}
