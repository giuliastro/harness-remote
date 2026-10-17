import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { desktopRequestResult, isDesktopPlatform } from "./desktopBridge"
import { authHeader, hasCredentials, machineBaseUrl } from "./serverConfig"
import type { ServerConfig } from "./types"

export type OptimizationWindow = {
  scope: string
  bucketName: string | null
  remainingPercent: number | null
  usedPercent: number | null
  resetsAt: string | null
  observedAt: string | null
  confidence: string | null
  source: string | null
}

export type OptimizationAgent = {
  id: string
  version: string | null
  state: string | null
  optimizers: string[]
  allowanceState: string
  allowanceObservedAt: string | null
  windows: OptimizationWindow[]
}

export type OptimizationSavings = {
  provider: string | null
  saved: number
  unit: "tokens" | "chars"
  measurementClass: string | null
  operations: number | null
  harnesses: string[]
}

export type OptimizationSnapshot = {
  schemaVersion: 1
  state: "available" | "partial" | "unavailable"
  observedAt: string
  toolVersion: string | null
  agents: OptimizationAgent[]
  savings: OptimizationSavings[]
  metricsWindow: { from: string | null; to: string | null } | null
  availability: { detection: boolean; allowance: boolean; savings: boolean }
}

function parseSnapshot(value: unknown): OptimizationSnapshot {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid optimization response")
  }
  const snapshot = parsed as Partial<OptimizationSnapshot>
  if (snapshot.schemaVersion !== 1 ||
      !["available", "partial", "unavailable"].includes(snapshot.state ?? "") ||
      !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.savings) ||
      typeof snapshot.observedAt !== "string" || !snapshot.availability ||
      typeof snapshot.availability.allowance !== "boolean") {
    throw new Error("Unsupported optimization response")
  }
  return snapshot as OptimizationSnapshot
}

/** Machine-scoped, never agent-scoped; same transport support as machine discovery. */
export async function readMachineOptimization(config: ServerConfig): Promise<OptimizationSnapshot> {
  const path = "/v1/optimization"
  if (isDesktopPlatform()) {
    const result = await desktopRequestResult(config, { path, method: "GET" })
    if (!result.ok) throw new Error(result.error.code === "http" && result.error.status === 404
      ? "This machine needs a newer Harness Remote gateway."
      : result.error.message)
    return parseSnapshot(result.response.data)
  }
  const url = `${machineBaseUrl(config)}${path}`
  const headers: Record<string, string> = { Accept: "application/json" }
  if (hasCredentials(config)) headers.Authorization = authHeader(config)
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({ url, headers, connectTimeout: 12_000, readTimeout: 30_000 })
    if (response.status === 404) throw new Error("This machine needs a newer Harness Remote gateway.")
    if (response.status < 200 || response.status >= 300) throw new Error(`Machine returned HTTP ${response.status}`)
    return parseSnapshot(response.data)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    if (response.status === 404) throw new Error("This machine needs a newer Harness Remote gateway.")
    if (!response.ok) throw new Error(`Machine returned HTTP ${response.status}`)
    return parseSnapshot(await response.json())
  } finally {
    clearTimeout(timer)
  }
}
