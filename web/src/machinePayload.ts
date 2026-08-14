import type { MachineSnapshot, ServerConfig } from "./types"

/**
 * The pure half of machine discovery. Kept free of Capacitor imports for the same reason
 * `serverConfig.ts` is: these rules decide whether an endpoint counts as a machine daemon at all,
 * and that decision deserves tests that run the code rather than tests that read the source.
 */

export const DEFAULT_MACHINE_DAEMON_PORT = 4097

/**
 * Android returns the body in shapes the browser never produces: a JSON string rather than a parsed
 * object, sometimes wrapped in the transport's own `{ data }` envelope, occasionally with a BOM in
 * front. Unwrap those layers, but only a bounded number of times — an endpoint that keeps answering
 * with nested envelopes is not one we should keep digging into.
 */
export function unwrapPayload(value: unknown): unknown {
  let candidate = value
  for (let pass = 0; pass < 3; pass += 1) {
    if (typeof candidate === "string") {
      const text = candidate.replace(/^\uFEFF/, "").trim()
      if (!text) return candidate
      try {
        candidate = JSON.parse(text)
        continue
      } catch {
        return candidate
      }
    }
    if (candidate && typeof candidate === "object" && "data" in candidate) {
      candidate = (candidate as { data?: unknown }).data
      continue
    }
    break
  }
  return candidate
}

/**
 * Returns null rather than throwing when the payload is not a machine snapshot: a 200 carrying
 * something else means "this endpoint is not a machine daemon", which is an answer, not a failure.
 * Distinguishing the two is what keeps a rejected password from being reported as a missing daemon.
 */
export function parseMachineSnapshot(value: unknown): MachineSnapshot | null {
  const snapshot = unwrapPayload(value) as Partial<MachineSnapshot> | null
  if (!snapshot?.machine || typeof snapshot.machine.id !== "string" || !Array.isArray(snapshot.agents)) return null
  return snapshot as MachineSnapshot
}

/** True when the body is the daemon's project listing, used only to confirm a positive snapshot. */
export function isProjectListing(value: unknown): boolean {
  const listing = unwrapPayload(value) as { projects?: unknown } | null
  return Array.isArray(listing?.projects)
}

/**
 * The machine daemon defaults to 4097 while a saved OpenCode profile usually points at 4096, so the
 * endpoint that serves sessions is often not the one that serves the task APIs. The daemon port on
 * the same host is therefore worth a second look — the same host the profile already authenticates
 * against, never a different one, and only when the profile's own port has said it has no daemon.
 */
export function machineCandidates(config: ServerConfig): ServerConfig[] {
  const current = { ...config }
  if (config.backend !== "opencode" || config.port === DEFAULT_MACHINE_DAEMON_PORT) return [current]
  return [
    current,
    { ...config, port: DEFAULT_MACHINE_DAEMON_PORT, agentId: config.agentId?.trim() || "opencode" }
  ]
}

export function selectableMachineAgents(machine: MachineSnapshot): MachineSnapshot["agents"] {
  return (Array.isArray(machine.agents) ? machine.agents : [])
    .filter((agent) => agent.state === "available" || agent.state === "configured")
}
