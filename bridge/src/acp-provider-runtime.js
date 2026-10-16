import path from "node:path"
import { spawn } from "node:child_process"
import { AcpClient } from "./acp-client.js"
import { AcpAgentModelCatalog } from "./agent-model-catalog.js"
import { acpHarnessCapabilityContract } from "./harness-capability-contract.js"
import { resolveAcpLaunch } from "./harness-profiles.js"
import { ProjectScopedAcpClient, acquireProjectProcessSlot } from "./project-scoped-acp-client.js"
import { ownChildProcess, closeOwnedChildProcess } from "./managed-child-process.js"

async function cleanupCatalogSession(policy, { sessionID, directory }, scoped, environment = {}) {
  if (!/^[A-Za-z0-9._:-]+$/.test(sessionID)) throw new Error("Invalid technical catalog Session id")
  const release = scoped ? await acquireProjectProcessSlot() : () => {}
  let child
  try {
    return await new Promise((resolve, reject) => {
      const shim = process.platform === "win32" && !/\.(?:exe|com)$/i.test(policy.command)
      const command = shim ? process.env.ComSpec ?? "cmd.exe" : policy.command
      const args = shim ? ["/d", "/s", "/c", policy.command, ...policy.args, sessionID] : [...policy.args, sessionID]
      child = ownChildProcess(spawn(command, args, { cwd: directory, env: { ...process.env, ...environment }, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }))
      let stderr = ""
      const timer = setTimeout(() => { child.kill(); reject(new Error("Catalog Session cleanup timed out")) }, 15_000)
      child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-1000) })
      child.once("error", (error) => { clearTimeout(timer); reject(error) })
      child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr.trim() || `Catalog cleanup exited with code ${code}`)) })
    })
  } finally {
    await closeOwnedChildProcess(child)
    release()
  }
}

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
  const clientOptions = {
    command: launch.command,
    args: [...launch.args],
    permissionMode: provider.permissionMode,
    preferredAuthMethod: provider.authMethod,
    authenticate: provider.authenticate,
    ...(provider.environment ? { environment: provider.environment } : {})
  }
  const roots = (config.roots?.length ? config.roots : [cwd]).map((root) => path.resolve(root))
  const createRuntimeClient = (maxClients = 2) => provider.sessionListScope === "project"
    ? new ProjectScopedAcpClient({ roots, maxClients, createClient: (directory) => new Client({ ...clientOptions, cwd: directory }) })
    : new Client(clientOptions)
  const agent = createRuntimeClient()
  const modelCatalogOptions = {
    agent: createRuntimeClient(1),
    agentID: provider.id,
    directory: config.roots?.[0] ?? cwd,
    stateDirectory: config.stateDirectory,
    variantConfigIDs: provider.modelVariantConfigIDs,
    excludedModelValuePrefixes: provider.excludedModelValuePrefixes,
    inlineModelVariantValues: provider.inlineModelVariantValues,
    modelProviderOrder: provider.modelProviderOrder,
    command: launch.command,
    environment: provider.environment,
    releaseAfterRefresh: provider.sessionListScope === "project",
    ...(provider.catalogSessionCleanup ? {
      cleanupSession: (session) => cleanupCatalogSession(provider.catalogSessionCleanup, session, provider.sessionListScope === "project", provider.environment)
    } : {})
  }
  const modelCatalog = provider.createModelCatalog
    ? provider.createModelCatalog(modelCatalogOptions)
    : new ModelCatalog(modelCatalogOptions)

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
        replayAuthoritative: provider.replayAuthoritative,
        replayUserChunksAreMessages: provider.replayUserChunksAreMessages,
        refreshSessionListOnRead: provider.refreshSessionListOnRead,
        snapshotDirectory: path.join(config.stateDirectory, provider.id),
        historyLoader: provider.createHistoryLoader?.(launch) ?? provider.historyLoader,
        preserveListedTimestamps: provider.preserveListedTimestamps,
        hiddenSessionIDs: modelCatalog.hiddenSessionIDs,
        reloadOnHistoryRefresh: provider.reloadOnHistoryRefresh,
        replaySettleMs: provider.replaySettleMs,
        promptSettleMs: provider.promptSettleMs,
        modelVariantConfigIDs: provider.modelVariantConfigIDs,
        modelProviderID: provider.id,
        excludedModelValuePrefixes: provider.excludedModelValuePrefixes,
        inlineModelVariantValues: provider.inlineModelVariantValues,
        modelProviderOrder: provider.modelProviderOrder,
        requireAssistantResponse: provider.requireAssistantResponse,
        recoverMissingSessionOnPrompt: provider.recoverMissingSessionOnPrompt,
        ...(provider.fallbackModelSelectionMethod ? {
          fallbackModelCatalog: modelCatalog,
          fallbackModelSelectionMethod: provider.fallbackModelSelectionMethod,
          fallbackModelCommand: provider.fallbackModelCommand
        } : {})
      }
    }
  }
}
