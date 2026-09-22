import type { MachineAgentHost } from "./types"

export type ProviderModelSelectionMode = "required" | "optional" | "harness-default"

/**
 * Model discovery and prompt writability are separate provider concerns.
 * New daemons advertise the precise selection contract. Older snapshots keep the historical rule:
 * a provider advertising a catalog requires one; a provider without one delegates to the harness.
 */
export function providerModelSelectionMode(agent?: MachineAgentHost | null): ProviderModelSelectionMode {
  const selection = agent?.contract?.models?.selection
  if (selection === "required" || selection === "optional" || selection === "harness-default") return selection
  return agent?.capabilities?.models === true ? "required" : "harness-default"
}

export function providerUsesModelCatalog(agent?: MachineAgentHost | null): boolean {
  return agent?.capabilities?.models === true && providerModelSelectionMode(agent) !== "harness-default"
}

export function providerRequiresExplicitModel(agent?: MachineAgentHost | null): boolean {
  return providerModelSelectionMode(agent) === "required"
}
