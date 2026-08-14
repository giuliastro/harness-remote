import type { SavedServerProfile } from "./serverProfiles"
import type { MachineSnapshot, ServerConfig } from "./types"
import type { MachineProject } from "./taskClient"

export type FleetMachine = {
  key: string
  profileIds: string[]
  profileNames: string[]
  config: ServerConfig
  state: "online" | "unreachable"
  machine: MachineSnapshot["machine"] | null
  agents: MachineSnapshot["agents"]
  projects: MachineProject[]
  error?: string
}

export type FleetObservation = {
  machine: MachineSnapshot
  projects: MachineProject[]
}

export type FleetDiscover = (config: ServerConfig) => Promise<FleetObservation>

/**
 * Profiles for different agents on the same daemon share one machine endpoint. Fleet discovery must
 * contact that endpoint once, not turn five saved agent profiles into five fake machines.
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

/**
 * Discover every configured daemon independently. One dead laptop must produce one unreachable
 * fleet row, never reject the whole fleet load. Successful daemon identity replaces the endpoint
 * key as the durable identity users see; the endpoint key remains useful while a machine is down.
 */
export async function discoverFleet(profiles: SavedServerProfile[], discover: FleetDiscover): Promise<FleetMachine[]> {
  const groups = [...groupProfilesByMachineEndpoint(profiles).entries()]
  const machines = await Promise.all(groups.map(async ([endpoint, machineProfiles]): Promise<FleetMachine> => {
    const representative = machineProfiles[0]
    try {
      const observation = await discover(representative.config)
      return {
        key: observation.machine.machine.id,
        profileIds: machineProfiles.map((profile) => profile.id),
        profileNames: machineProfiles.map((profile) => profile.name),
        config: representative.config,
        state: "online",
        machine: observation.machine.machine,
        agents: observation.machine.agents,
        projects: observation.projects
      }
    } catch (cause) {
      return {
        key: endpoint,
        profileIds: machineProfiles.map((profile) => profile.id),
        profileNames: machineProfiles.map((profile) => profile.name),
        config: representative.config,
        state: "unreachable",
        machine: null,
        agents: [],
        projects: [],
        error: cause instanceof Error ? cause.message : String(cause)
      }
    }
  }))

  return machines.sort((left, right) => {
    if (left.state !== right.state) return left.state === "online" ? -1 : 1
    const leftName = left.machine?.name ?? left.profileNames[0] ?? left.key
    const rightName = right.machine?.name ?? right.profileNames[0] ?? right.key
    return leftName.localeCompare(rightName)
  })
}
