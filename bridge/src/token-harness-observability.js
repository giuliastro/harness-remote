import { execFile } from "node:child_process"

const TIMEOUT_MS = 12_000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const CACHE_MS = 30_000

function readCommand(command) {
  return new Promise((resolve, reject) => {
    // Never pass client-supplied executable names or arguments to a shell.
    execFile("token-harness", [command, "--json"], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true
    }, (error, stdout) => {
      if (error && !stdout.trim()) return reject(error)
      try {
        const envelope = JSON.parse(stdout)
        if (envelope?.schemaVersion !== 1 || envelope.command !== command ||
            typeof envelope.status !== "string") {
          throw new Error("Unsupported Token Harness JSON envelope")
        }
        // Exit codes 3/4/5 can carry legitimate partial diagnostics/data.
        resolve(envelope)
      } catch {
        reject(new Error("Invalid Token Harness JSON response"))
      }
    })
  })
}

function text(value, max = 120) {
  return typeof value === "string" ? value.slice(0, max) : null
}

function percent(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value : null
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

function array(value) {
  return Array.isArray(value) ? value : []
}

function windowView(value) {
  return {
    scope: text(value?.scope, 24) ?? "unknown",
    bucketName: text(value?.bucketName),
    remainingPercent: percent(value?.remainingPercent),
    usedPercent: percent(value?.usedPercent),
    resetsAt: text(value?.resetsAt, 45),
    observedAt: text(value?.observedAt, 45),
    confidence: text(value?.confidence, 24),
    source: text(value?.source, 24)
  }
}

export function projectTokenHarnessObservations(doctor, budget, metrics, observedAt) {
  const harnesses = array(doctor?.data?.harnesses)
  const providers = array(doctor?.data?.providers)
  const quota = array(budget?.data?.harnesses)
  const agents = harnesses
    .filter((item) => item && typeof item.harnessId === "string" && item.state !== "absent")
    .map((item) => {
      const observation = quota.find((entry) => entry.harnessId === item.harnessId)
      return {
        id: text(item.harnessId, 40),
        version: text(item.version, 80),
        state: text(item.state, 40),
        optimizers: providers
          .filter((provider) => provider?.state === "configured" &&
            array(provider.configuredHarnesses).includes(item.harnessId))
          .map((provider) => text(provider.providerId, 60))
          .filter(Boolean),
        allowanceState: text(observation?.state, 40) ?? "unavailable",
        allowanceObservedAt: text(budget?.data?.observedAt, 45),
        windows: array(observation?.windows).map(windowView)
      }
    })
  const savings = array(metrics?.data?.providers)
    .filter((provider) => provider && (provider.unit === "tokens" || provider.unit === "chars") &&
      number(provider.saved) !== null)
    .map((provider) => ({
      provider: text(provider.providerId, 60),
      saved: number(provider.saved),
      unit: provider.unit,
      measurementClass: text(provider.class, 40),
      operations: number(provider.operations),
      harnesses: array(provider.harnesses).filter((id) => typeof id === "string").map((id) => id.slice(0, 40))
    }))
  return {
    schemaVersion: 1,
    state: !doctor ? "unavailable" : !budget || !metrics ? "partial" : "available",
    observedAt,
    toolVersion: text(doctor?.toolVersion, 60),
    agents,
    savings,
    metricsWindow: metrics?.data && typeof metrics.data === "object"
      ? { from: text(metrics.data.windowStart, 40), to: text(metrics.data.windowEnd, 40) }
      : null,
    availability: {
      detection: Boolean(doctor),
      allowance: Boolean(budget?.data),
      savings: Boolean(metrics?.data)
    }
  }
}

/**
 * Optional, machine-local, read-only observation surface.
 * Does not manage hooks, launch agents or modify their configuration.
 */
export function createTokenHarnessObserver({
  execute = readCommand,
  now = () => Date.now(),
  ttlMs = CACHE_MS
} = {}) {
  let cached = null
  let expiresAt = 0
  let inFlight = null

  return async function observe() {
    if (cached && now() < expiresAt) return cached
    if (inFlight) return inFlight
    inFlight = (async () => {
      const observedAt = new Date(now()).toISOString()
      let doctor = null
      try {
        doctor = await execute("doctor")
        if (!doctor || doctor.schemaVersion !== 1 || doctor.command !== "doctor" || !doctor.data) doctor = null
      } catch {
        // A missing executable, unsupported runtime or malformed response is not an empty quota.
      }
      let budget = null
      let metrics = null
      if (doctor) {
        const result = await Promise.allSettled([execute("budget"), execute("metrics")])
        if (result[0].status === "fulfilled" &&
            result[0].value?.schemaVersion === 1 && result[0].value.command === "budget") {
          budget = result[0].value
        }
        if (result[1].status === "fulfilled" &&
            result[1].value?.schemaVersion === 1 && result[1].value.command === "metrics") {
          metrics = result[1].value
        }
      }
      return projectTokenHarnessObservations(doctor, budget, metrics, observedAt)
    })()
    try {
      cached = await inFlight
      expiresAt = now() + ttlMs
      return cached
    } finally {
      inFlight = null
    }
  }
}
