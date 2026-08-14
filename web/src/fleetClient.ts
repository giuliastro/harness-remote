import { discoverMachine } from "./machineClient"
import { discoverFleet, type FleetMachine } from "./fleetModel"
import type { SavedServerProfile } from "./serverProfiles"
import { taskClient, type MachineTask } from "./taskClient"

export async function loadFleet(profiles: SavedServerProfile[]): Promise<FleetMachine[]> {
  return discoverFleet(profiles, async (config) => {
    const machine = await discoverMachine(config)
    if (!machine) throw new Error("Harness machine daemon is unavailable")
    const projects = await taskClient.listProjects(config)
    return { machine, projects }
  })
}

export async function launchFleetTask(machine: FleetMachine, input: {
  projectId: string
  agentId: string
  prompt: string
  isolated?: boolean
}): Promise<MachineTask> {
  if (machine.state !== "online" || !machine.machine) throw new Error("The selected machine is unreachable")
  if (!machine.agents.some((agent) => agent.id === input.agentId && (agent.state === "available" || agent.state === "configured"))) {
    throw new Error(`Agent ${input.agentId} is unavailable on ${machine.machine.name}`)
  }
  const project = machine.projects.find((candidate) => candidate.id === input.projectId)
  if (!project) throw new Error(`Unknown project on ${machine.machine.name}`)

  let task = await taskClient.createTask(machine.config, {
    projectId: input.projectId,
    agentId: input.agentId,
    prompt: input.prompt
  })
  if (input.isolated !== false && project.kind === "git") {
    task = await taskClient.prepareWorktree(machine.config, task.id)
  }
  return taskClient.launch(machine.config, task.id)
}
