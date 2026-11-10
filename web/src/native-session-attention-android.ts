import { App } from "@capacitor/app"
import { Capacitor, type PluginListenerHandle } from "@capacitor/core"

export type AndroidAttentionActivation = {
  machineID: string
  agentID: string
  sessionID: string
}

const MAX_ID_LENGTH = 512
const MAX_SEEN_ACTIVATIONS = 50

function cleanID(value: string | null): string | null {
  if (typeof value !== "string" || !value || value.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) return null
  const normalized = value.trim()
  return normalized || null
}

/** `harnessremote:` is a non-special scheme. Older Android WebViews parse it as an opaque path,
 * where the authority lives in `pathname`; accept either representation but nothing else. */
function attentionAuthority(parsed: URL): string {
  if (parsed.hostname) return parsed.hostname
  return /^\/\/([^/?#]+)/.exec(parsed.pathname)?.[1] ?? ""
}

/** Parse only the explicit URI shape emitted by the native Android notification PendingIntent. */
export function parseAndroidAttentionActivation(url: string): AndroidAttentionActivation | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== "harnessremote:" || attentionAuthority(parsed) !== "attention") return null
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
  const remember = (url: string) => {
    seen.add(url)
    if (seen.size <= MAX_SEEN_ACTIVATIONS) return
    const oldest = seen.values().next().value
    if (oldest !== undefined) seen.delete(oldest)
  }
  const emit = (url: string | undefined) => {
    if (closed || !url || seen.has(url)) return
    const activation = parseAndroidAttentionActivation(url)
    if (!activation) return
    remember(url)
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
