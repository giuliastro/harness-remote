import type { ContextBridge, IpcRenderer } from "electron"
import type {
  DesktopAttentionNotification,
  DesktopAttentionTarget,
  DesktopCompletionNotification,
  DesktopEvent,
  DesktopEventMessage,
  DesktopEventStatus,
  DesktopEventSubscriptionOptions,
  DesktopLocalRuntimeState,
  DesktopMenuCommand,
  DesktopMenuTemplate,
  DesktopNetworkSettingsState,
  DesktopNetworkSettingsUpdate,
  DesktopProfile,
  DesktopProfileSyncResult,
  DesktopProjectFolderChoice,
  DesktopProjectRootsState,
  DesktopProjectRootsUpdate,
  DesktopRequest,
  DesktopRequestResult
} from "./ipc-contract.js" with { "resolution-mode": "import" }

const { contextBridge, ipcRenderer } = require("electron") as { contextBridge: ContextBridge; ipcRenderer: IpcRenderer }
const IPC_CHANNELS = Object.freeze({
  replaceProfiles: "desktop:profiles:replace",
  request: "desktop:request",
  subscribeEvents: "desktop:events:subscribe",
  unsubscribeEvents: "desktop:events:unsubscribe",
  getLocalRuntime: "desktop:runtime:local:get",
  retryLocalRuntime: "desktop:runtime:local:retry",
  probeMachineConfiguration: "desktop:machine-configuration:probe",
  getProjectRoots: "desktop:project-roots:get",
  chooseProjectFolder: "desktop:project-roots:choose",
  setProjectRoots: "desktop:project-roots:set",
  getNetworkSettings: "desktop:network:get",
  setNetworkSettings: "desktop:network:set",
  notifyCompletion: "desktop:completion:notify",
  notifyAttention: "desktop:attention:notify",
  attentionActivated: "desktop:attention:activated",
  event: "desktop:events:event",
  menuCommand: "desktop:menu:command",
  setMenu: "desktop:menu:set"
})

type EventCallbacks = {
  onEvent: (event: DesktopEvent) => void
  onStatus?: (status: DesktopEventStatus) => void
}

const callbacks = new Map<string, EventCallbacks>()
const menuCallbacks = new Set<(command: DesktopMenuCommand) => void>()
const attentionCallbacks = new Set<(target: DesktopAttentionTarget) => void>()
ipcRenderer.on(IPC_CHANNELS.event, (_event: Electron.IpcRendererEvent, message: DesktopEventMessage) => {
  if (!message || typeof message.subscriptionId !== "string") return
  const callback = callbacks.get(message.subscriptionId)
  if (!callback) return
  if (message.kind === "event") callback.onEvent(message.event)
  else callback.onStatus?.(message.status)
})
ipcRenderer.on(IPC_CHANNELS.menuCommand, (_event: Electron.IpcRendererEvent, command: DesktopMenuCommand) => {
  for (const callback of menuCallbacks) callback(command)
})
ipcRenderer.on(IPC_CHANNELS.attentionActivated, (_event: Electron.IpcRendererEvent, target: DesktopAttentionTarget) => {
  if (!target || typeof target.machineID !== "string" || typeof target.agentID !== "string" || typeof target.sessionID !== "string") return
  for (const callback of attentionCallbacks) callback(target)
})

const harnessDesktop = Object.freeze({
  // `usesNativeMenu` is what tells the renderer to stop drawing its own menu bar and stop binding
  // its own accelerators: on the platform that has a real menu, both would be duplicates, and a
  // shortcut handled twice toggles a panel back to where it started.
  platform: Object.freeze({ isDesktop: true, os: process.platform, usesNativeMenu: process.platform === "darwin" }),
  replaceProfiles(profiles: DesktopProfile[], revision: number): Promise<DesktopProfileSyncResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.replaceProfiles, profiles, revision)
  },
  request(profileId: string, request: DesktopRequest): Promise<DesktopRequestResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.request, profileId, request)
  },
  getLocalRuntimeState(): Promise<DesktopLocalRuntimeState> {
    return ipcRenderer.invoke(IPC_CHANNELS.getLocalRuntime)
  },
  retryLocalRuntime(): Promise<DesktopLocalRuntimeState> {
    return ipcRenderer.invoke(IPC_CHANNELS.retryLocalRuntime)
  },
  probeMachineConfiguration(profile: DesktopProfile, path: "/v1/machine" | "/v1/projects", language?: string): Promise<DesktopRequestResult> {
    return ipcRenderer.invoke(IPC_CHANNELS.probeMachineConfiguration, profile, path, language)
  },
  getProjectRoots(): Promise<DesktopProjectRootsState> {
    return ipcRenderer.invoke(IPC_CHANNELS.getProjectRoots)
  },
  chooseProjectFolder(language?: string): Promise<DesktopProjectFolderChoice> {
    return ipcRenderer.invoke(IPC_CHANNELS.chooseProjectFolder, language)
  },
  setProjectRoots(roots: string[], language?: string): Promise<DesktopProjectRootsUpdate> {
    return ipcRenderer.invoke(IPC_CHANNELS.setProjectRoots, roots, language)
  },
  getNetworkSettings(): Promise<DesktopNetworkSettingsState> {
    return ipcRenderer.invoke(IPC_CHANNELS.getNetworkSettings)
  },
  setNetworkSettings(lanPairing: boolean, language?: string): Promise<DesktopNetworkSettingsUpdate> {
    return ipcRenderer.invoke(IPC_CHANNELS.setNetworkSettings, lanPairing, language)
  },
  async subscribeEvents(
    profileId: string,
    options: DesktopEventSubscriptionOptions,
    onEvent: EventCallbacks["onEvent"],
    onStatus?: EventCallbacks["onStatus"]
  ): Promise<string> {
    const result = await ipcRenderer.invoke(IPC_CHANNELS.subscribeEvents, profileId, options) as { subscriptionId: string }
    callbacks.set(result.subscriptionId, { onEvent, onStatus })
    return result.subscriptionId
  },
  async unsubscribeEvents(subscriptionId: string): Promise<void> {
    callbacks.delete(subscriptionId)
    await ipcRenderer.invoke(IPC_CHANNELS.unsubscribeEvents, subscriptionId)
  },
  notifyCompletion(notification: DesktopCompletionNotification): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.notifyCompletion, notification)
  },
  notifyAttention(notification: DesktopAttentionNotification): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.notifyAttention, notification)
  },
  onAttentionActivated(callback: (target: DesktopAttentionTarget) => void): () => void {
    attentionCallbacks.add(callback)
    return () => attentionCallbacks.delete(callback)
  },
  onMenuCommand(callback: (command: DesktopMenuCommand) => void): () => void {
    menuCallbacks.add(callback)
    return () => menuCallbacks.delete(callback)
  },
  setApplicationMenu(template: DesktopMenuTemplate): Promise<boolean> {
    return ipcRenderer.invoke(IPC_CHANNELS.setMenu, template)
  }
})

contextBridge.exposeInMainWorld("harnessDesktop", harnessDesktop)
