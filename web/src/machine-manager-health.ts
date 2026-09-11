export type MachineManagerHealth<TSnapshot> =
  | { state: "checking"; snapshot?: TSnapshot }
  | { state: "online"; snapshot: TSnapshot }
  | { state: "offline"; snapshot?: TSnapshot; error?: string }

export function checkingMachineHealth<TSnapshot>(
  previous?: MachineManagerHealth<TSnapshot>
): MachineManagerHealth<TSnapshot> {
  return previous?.state === "online" || previous?.state === "checking"
    ? { state: "checking", snapshot: previous.snapshot }
    : { state: "checking" }
}

export function onlineMachineHealth<TSnapshot>(snapshot: TSnapshot): MachineManagerHealth<TSnapshot> {
  return { state: "online", snapshot }
}

export function offlineMachineHealth<TSnapshot>(reason?: unknown): MachineManagerHealth<TSnapshot> {
  const error = reason instanceof Error
    ? reason.message.trim()
    : typeof reason === "string"
      ? reason.trim()
      : ""
  return error ? { state: "offline", error } : { state: "offline" }
}

export function availableMachineAgentCount<TSnapshot extends { agents: Array<{ state: string }> }>(
  health: Record<string, MachineManagerHealth<TSnapshot> | undefined>
): number {
  return Object.values(health).reduce((count, entry) => {
    if (entry?.state !== "online") return count
    return count + entry.snapshot.agents.filter((agent) => agent.state === "available").length
  }, 0)
}
