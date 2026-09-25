import path from "node:path"
import { spawn } from "node:child_process"
import { AcpClient } from "./acp-client.js"
import { AcpAgentModelCatalog } from "./agent-model-catalog.js"
import { acpHarnessCapabilityContract } from "./harness-capability-contract.js"
import { resolveAcpLaunch } from "./harness-profiles.js"
import { ProjectScopedAcpClient } from "./project-scoped-acp-client.js"

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

function cleanupCatalogSession(policy, { sessionID, directory }) {
  if (!policy) return undefined
  if (!/^[A-Za-z0-9._:-]+$/.test(sessionID)) throw new Error("Refusing to clean an invalid technical Session id")
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : policy.command
    const args = command === policy.command
      ? [...policy.args, sessionID]
      : ["/d", "/s", "/c", policy.command, ...policy.args, sessionID]
    const child = spawn(command, args, {
      cwd: directory,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    })
    let stderr = ""
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-1000) })
    child.once("error", reject)
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(stderr.trim() || `Catalog Session cleanup exited with code ${code}`)))
  })
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
  const baseClientOptions = {
    command: launch.command,
    args: [...launch.args],
    permissionMode: provider.permissionMode,
    preferredAuthMethod: provider.authMethod,
    authenticate: provider.authenticate,
    ...(provider.environment ? { environment: provider.environment } : {}),
    ...(workingDirectory ? { cwd: workingDirectory } : {})
  }
  const roots = (config.roots?.length ? config.roots : [cwd]).map((root) => path.resolve(root))
  const createClient = (directory) => new Client({
    ...baseClientOptions,
    ...(directory ? { cwd: directory } : {})
  })
  const createRuntimeClient = () => provider.sessionListScope === "project"
    ? new ProjectScopedAcpClient({ roots, createClient })
    : new Client(baseClientOptions)
  const agent = createRuntimeClient()
  const modelCatalog = new ModelCatalog({
    agent: createRuntimeClient(),
    agentID: provider.id,
    directory: config.roots?.[0] ?? cwd,
    stateDirectory: config.stateDirectory,
    variantConfigIDs: provider.modelVariantConfigIDs,
    excludedModelValuePrefixes: provider.excludedModelValuePrefixes,
    inlineModelVariantValues: provider.inlineModelVariantValues,
    modelProviderOrder: provider.modelProviderOrder,
    ...(provider.catalogSessionCleanup ? {
      cleanupSession: (session) => cleanupCatalogSession(provider.catalogSessionCleanup, session)
    } : {})
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
        excludedModelValuePrefixes: provider.excludedModelValuePrefixes,
        inlineModelVariantValues: provider.inlineModelVariantValues,
        modelProviderOrder: provider.modelProviderOrder
      }
    }
  }
}
