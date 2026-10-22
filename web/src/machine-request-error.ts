/** A daemon response proves the machine was reachable, even when its harness failed. */
export class MachineHttpError extends Error {
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = "MachineHttpError"
    this.status = status
  }
}

export function isMachineTransportFailure(reason: unknown): boolean {
  if (reason instanceof MachineHttpError) return false
  const message = reason instanceof Error ? reason.message : String(reason)
  return /cannot reach|timed out|network|connection|failed to fetch/i.test(message)
}
