import type { SavedServerProfile } from "./serverProfiles"
import type { MachineSnapshot, ServerConfig } from "./types"
import type { MachineProject, MachineTask } from "./taskClient"

export type FleetTask = MachineTask & {
  fleetId: string
}

export type FleetMachine = {
  /**
   * The endpoint, not the machine id. A machine keeps its row while it is unreachable, and its id
   * is only known once it has answered — keying on the id would destroy and recreate the row at the
   * moment it goes offline, losing selection and scroll position exactly when they are being read.
   */
  key: string
  machineId: string | null
  profileIds: string[]
  profileNames: string[]
  config: ServerConfig
  state: "online" | "unreachable"
  machine: MachineSnapshot["machine"] | null
  agents: MachineSnapshot["agents"]
  projects: MachineProject[]
  tasks: FleetTask[]
  error?: string
}

export type FleetObservation = {
  machine: MachineSnapshot
  projects: MachineProject[]
  tasks: MachineTask[]
}

export type FleetDiscover = (config: ServerConfig) => Promise<FleetObservation>

/**
 * Profiles for different agents on the same daemon share one machine endpoint. Fleet discovery must
 * contact that endpoint once logically, not turn five saved agent profiles into five fake machines.
 */
export function machineEndpointKey(config: ServerConfig): string {
  const raw = config.host.trim().replace(/\/+$/, "")
  const normalized = /^https?:\/\//i.test(raw) ? raw.toLowerCase() : `http://${raw.toLowerCase()}`
  return `${normalized}:${config.port}`
}

export function groupProfilesByMachineEndpoint(profiles: SavedServerProfile[]): Map<string, SavedServerProfile[]> {
  const groups = new Map<string, SavedServerProfile[]>()
  for (const profile of profiles) {
    if (!profile.config.host.trim() || !profile.config.port) continue
    const key = machineEndpointKey(profile.config)
    groups.set(key, [...(groups.get(key) ?? []), profile])
  }
  return groups
}

export function fleetTaskID(machineID: string, taskID: string): string {
  return `${encodeURIComponent(machineID)}:${encodeURIComponent(taskID)}`
}

async function discoverThroughProfiles(machineProfiles: SavedServerProfile[], discover: FleetDiscover): Promise<{
  profile: SavedServerProfile
  observation: FleetObservation
}> {
  let lastError: unknown
  for (const profile of machineProfiles) {
    try {
      return { profile, observation: await discover(profile.config) }
    } catch (cause) {
      lastError = cause
    }
  }
  throw lastError ?? new Error("No usable profile is configured for this machine")
}

/**
 * Discover every configured daemon independently. One dead laptop must produce one unreachable
 * fleet row, never reject the whole fleet load. Several saved agent profiles may point at the same
 * daemon; if one profile carries stale credentials, alternate profiles for that endpoint are tried
 * before the physical machine is declared unreachable.
 */
export async function discoverFleet(profiles: SavedServerProfile[], discover: FleetDiscover): Promise<FleetMachine[]> {
  const groups = [...groupProfilesByMachineEndpoint(profiles).entries()]
  const machines = await Promise.all(groups.map(async ([endpoint, machineProfiles]): Promise<FleetMachine> => {
    const representative = machineProfiles[0]
    try {
      const { profile, observation } = await discoverThroughProfiles(machineProfiles, discover)
      const machineID = observation.machine.machine.id
      return {
        key: endpoint,
        machineId: machineID,
        profileIds: machineProfiles.map((candidate) => candidate.id),
        profileNames: machineProfiles.map((candidate) => candidate.name),
        config: profile.config,
        state: "online",
        machine: observation.machine.machine,
        agents: observation.machine.agents,
        projects: observation.projects,
        tasks: observation.tasks.map((task) => ({ ...task, fleetId: fleetTaskID(machineID, task.id) }))
      }
    } catch (cause) {
      return {
        key: endpoint,
        machineId: null,
        profileIds: machineProfiles.map((profile) => profile.id),
        profileNames: machineProfiles.map((profile) => profile.name),
        config: representative.config,
        state: "unreachable",
        machine: null,
        agents: [],
        projects: [],
        tasks: [],
        error: cause instanceof Error ? cause.message : String(cause)
      }
    }
  }))

  return foldByMachineIdentity(machines).sort((left, right) => {
    if (left.state !== right.state) return left.state === "online" ? -1 : 1
    const leftName = left.machine?.name ?? left.profileNames[0] ?? left.key
    const rightName = right.machine?.name ?? right.profileNames[0] ?? right.key
    return leftName.localeCompare(rightName)
  })
}

/**
 * Endpoint grouping cannot see that `localhost:4097` and `192.168.1.64:4097` are one laptop — a
 * phone and the machine itself address it differently, which is the ordinary setup rather than an
 * edge case. Only the daemon knows, and it says so once it answers, so the authoritative fold
 * happens here: rows that reported the same machine id become one row carrying every profile that
 * reaches it. Unreachable rows have no id yet and stay separate until they can be identified.
 */
function foldByMachineIdentity(machines: FleetMachine[]): FleetMachine[] {
  const folded: FleetMachine[] = []
  const byMachineID = new Map<string, FleetMachine>()
  for (const machine of machines) {
    const existing = machine.machineId ? byMachineID.get(machine.machineId) : undefined
    if (!existing) {
      if (machine.machineId) byMachineID.set(machine.machineId, machine)
      folded.push(machine)
      continue
    }
    existing.profileIds = [...existing.profileIds, ...machine.profileIds]
    existing.profileNames = [...existing.profileNames, ...machine.profileNames]
  }
  return folded
}
