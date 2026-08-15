import type { ContextBridge, IpcRenderer } from "electron"
import type {
  DesktopCompletionNotification,
  DesktopEvent,
  DesktopEventMessage,
  DesktopEventStatus,
  DesktopEventSubscriptionOptions,
  DesktopMenuCommand,
  DesktopMenuTemplate,
  DesktopProfile,
  DesktopProfileSyncResult,
  DesktopRequest,
  DesktopRequestResult
} from "./ipc-contract.js" with { "resolution-mode": "import" }

const { contextBridge, ipcRenderer } = require("electron") as { contextBridge: ContextBridge; ipcRenderer: IpcRenderer }
const IPC_CHANNELS = Object.freeze({
  replaceProfiles: "desktop:profiles:replace",
  request: "desktop:request",
  subscribeEvents: "desktop:events:subscribe",
  unsubscribeEvents: "desktop:events:unsubscribe",
  notifyCompletion: "desktop:completion:notify",
  openExternal: "desktop:external:open",
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
  openExternal(url: string): Promise<boolean> {
    return ipcRenderer.invoke(IPC_CHANNELS.openExternal, url)
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
