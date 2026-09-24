import path from "node:path"
import { AcpClient } from "./acp-client.js"
import { AcpAgentModelCatalog } from "./agent-model-catalog.js"
import { acpHarnessCapabilityContract } from "./harness-capability-contract.js"
import { resolveAcpLaunch } from "./harness-profiles.js"

/**
 * Return the ordered ACP provider ids a machine daemon should expose.
 *
 * Discovery remains launcher-owned. This helper only translates its result into provider runtime
 * membership while ensuring the explicitly selected primary is present exactly once.
 */
export function resolveAcpProviderIDs(detected = [], primaryID) {
  return [...new Set([
    ...detected.filter((id) => id !== "opencode"),
    primaryID
  ].filter(Boolean))]
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function commonDirectory(directories) {
  let common = path.resolve(directories[0])
  for (const directory of directories.slice(1)) {
    const candidate = path.resolve(directory)
    while (!isWithin(common, candidate)) {
      const parent = path.dirname(common)
      if (parent === common) break
      common = parent
    }
  }
  return common
}

/** Resolve the process directory required by providers that scope ACP to one filesystem tree. */
export function resolveAcpProviderWorkingDirectory(provider, { config, cwd = process.cwd() } = {}) {
  if (provider?.workingDirectory !== "common-root") return undefined
  const roots = config?.roots?.length ? config.roots : [cwd]
  return commonDirectory(roots)
}

/** Resolve launch details without teaching generic daemon code provider-specific executable rules. */
export function resolveAcpProviderLaunch(provider, { primary = false, config, resolveLaunch = resolveAcpLaunch } = {}) {
  if (primary) {
    return {
      command: config.acpCommand,
      args: [...config.acpArgs]
    }
  }
  return resolveLaunch(provider)
}

/**
 * Build one ACP provider runtime registration.
 *
 * The user-facing agent and model-catalog agent deliberately use separate ACP connections: model
 * discovery owns a technical Session and must not interfere with the user-facing Session writer.
 */
export async function createAcpProviderRuntime({
  provider,
  launch,
  config,
  Client = AcpClient,
  ModelCatalog = AcpAgentModelCatalog,
  cwd = process.cwd()
}) {
  const workingDirectory = resolveAcpProviderWorkingDirectory(provider, { config, cwd })
  const clientOptions = {
    command: launch.command,
    args: [...launch.args],
    permissionMode: provider.permissionMode,
    preferredAuthMethod: provider.authMethod,
    authenticate: provider.authenticate,
    ...(provider.environment ? { environment: provider.environment } : {}),
    ...(workingDirectory ? { cwd: workingDirectory } : {})
  }
  const agent = new Client(clientOptions)
  const modelCatalog = new ModelCatalog({
    agent: new Client(clientOptions),
    agentID: provider.id,
    directory: config.roots?.[0] ?? cwd,
    stateDirectory: config.stateDirectory,
    variantConfigIDs: provider.modelVariantConfigIDs,
    excludedModelValuePrefixes: provider.excludedModelValuePrefixes
  })

  // Persisted technical Session ids must be hidden before the machine server can list Sessions.
  await modelCatalog.preloadState()

  const bridgeConfig = {
    ...config,
    backend: provider.id,
    acpCommand: launch.command,
    acpArgs: [...launch.args]
  }

  return {
    provider,
    agent,
    modelCatalog,
    registration: {
      id: provider.id,
      label: provider.label,
      backend: provider.id,
      capabilities: provider.capabilities,
      contract: acpHarnessCapabilityContract(provider),
      agent,
      modelCatalog,
      bridgeConfig,
      serviceOptions: {
        snapshotDirectory: path.join(config.stateDirectory, provider.id),
        historyLoader: provider.historyLoader,
        preserveListedTimestamps: provider.preserveListedTimestamps,
        hiddenSessionIDs: modelCatalog.hiddenSessionIDs,
        reloadOnHistoryRefresh: provider.reloadOnHistoryRefresh,
        replaySettleMs: provider.replaySettleMs,
        promptSettleMs: provider.promptSettleMs,
        modelVariantConfigIDs: provider.modelVariantConfigIDs,
        requireAssistantResponse: provider.requireAssistantResponse,
        excludedModelValuePrefixes: provider.excludedModelValuePrefixes
      }
    }
  }
}
