import { App } from "@capacitor/app"
import { Capacitor, type PluginListenerHandle } from "@capacitor/core"

export type AndroidAttentionActivation = {
  machineID: string
  agentID: string
  sessionID: string
}

const MAX_ID_LENGTH = 512

function cleanID(value: string | null): string | null {
  const normalized = value?.trim() ?? ""
  if (!normalized || normalized.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(normalized)) return null
  return normalized
}

/** Parse only the explicit URI shape emitted by the native Android notification PendingIntent. */
export function parseAndroidAttentionActivation(url: string): AndroidAttentionActivation | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== "harnessremote:" || parsed.hostname !== "attention") return null
  const machineID = cleanID(parsed.searchParams.get("machineID"))
  const agentID = cleanID(parsed.searchParams.get("agentID"))
  const sessionID = cleanID(parsed.searchParams.get("sessionID"))
  return machineID && agentID && sessionID ? { machineID, agentID, sessionID } : null
}

/**
 * Android local notifications reopen MainActivity with a private explicit deep link. Capacitor's App
 * bridge covers both a warm `appUrlOpen` and a cold `getLaunchUrl`, so notification activation never
 * needs transcript data or a second native Session identity.
 */
export function subscribeAndroidAttentionActivation(
  onActivation: (activation: AndroidAttentionActivation) => void
): () => void {
  if (Capacitor.getPlatform() !== "android") return () => undefined

  let closed = false
  let handle: PluginListenerHandle | undefined
  const seen = new Set<string>()
  const emit = (url: string | undefined) => {
    if (closed || !url || seen.has(url)) return
    const activation = parseAndroidAttentionActivation(url)
    if (!activation) return
    seen.add(url)
    onActivation(activation)
  }

  void App.addListener("appUrlOpen", ({ url }) => emit(url)).then((created) => {
    if (closed) void created.remove()
    else handle = created
  })
  void App.getLaunchUrl().then((launch) => emit(launch?.url)).catch(() => undefined)

  return () => {
    if (closed) return
    closed = true
    if (handle) void handle.remove()
  }
}
