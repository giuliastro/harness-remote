import type { EmbeddedDaemonEndpoint } from "./embedded-daemon.js"

const POLL_INTERVAL_MS = 5_000
const REQUEST_TIMEOUT_MS = 3_000

export function activeAcpTurnCount(diagnostics: unknown): number {
  if (!diagnostics || typeof diagnostics !== "object") return 0
  const services = (diagnostics as { services?: unknown }).services
  if (!services || typeof services !== "object") return 0
  return Object.values(services).reduce<number>((total, service) => {
    if (!service || typeof service !== "object") return total
    const count = (service as { activeSessions?: unknown }).activeSessions
    return total + (typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : 0)
  }, 0)
}

export async function readActiveAcpTurns(endpoint: EmbeddedDaemonEndpoint): Promise<number> {
  const authorization = `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`, "utf8").toString("base64")}`
  const response = await fetch(`http://${endpoint.host}:${endpoint.port}/v1/diagnostics`, {
    headers: { Accept: "application/json", Authorization: authorization },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`Daemon diagnostics returned ${response.status}`)
  return activeAcpTurnCount(await response.json())
}

export class ActiveTurnSleepBlocker {
  private blockerID: number | undefined
  private timer: NodeJS.Timeout | undefined
  private refreshing = false
  private stopped = false

  constructor(
    private readonly readActiveTurns: () => Promise<number>,
    private readonly startBlocker: () => number,
    private readonly stopBlocker: (id: number) => void
  ) {}

  start(): void {
    if (this.timer || this.stopped) return
    void this.refresh()
    this.timer = setInterval(() => { void this.refresh() }, POLL_INTERVAL_MS)
    this.timer.unref?.()
  }

  async refresh(): Promise<void> {
    if (this.stopped || this.refreshing) return
    this.refreshing = true
    try {
      const active = await this.readActiveTurns() > 0
      if (this.stopped) return
      if (active && this.blockerID === undefined) this.blockerID = this.startBlocker()
      if (!active && this.blockerID !== undefined) {
        this.stopBlocker(this.blockerID)
        this.blockerID = undefined
      }
    } catch {
      // A transient diagnostics failure must not let a running turn put the PC to sleep.
    } finally {
      this.refreshing = false
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.blockerID !== undefined) this.stopBlocker(this.blockerID)
    this.blockerID = undefined
  }
}
