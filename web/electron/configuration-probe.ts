import { desktopTranslator } from "./desktop-locale.js"
import type { DesktopRequestResult } from "./ipc-contract.js"
import { validateDesktopProfile } from "./profile-registry.js"
import { executeDesktopRequest } from "./request-transport.js"

/** Unsaved connection drafts may inspect a machine, without registering or persisting it.
 * Keep this surface read-only and machine-scoped; it cannot dispatch harness or Session actions. */
export async function executeConfigurationProbe(value: unknown, path: unknown, language?: unknown): Promise<DesktopRequestResult> {
  const t = desktopTranslator(language)
  if (path !== "/v1/machine" && path !== "/v1/projects") {
    return { ok: false, error: { code: "invalid-payload", message: t("machine.probeUnsupported") } }
  }
  let profile
  try {
    profile = { ...validateDesktopProfile(value), backend: "opencode" as const, agentId: undefined }
  } catch {
    return { ok: false, error: { code: "invalid-profile", message: t("machine.connectionInvalid") } }
  }
  const result = await executeDesktopRequest(profile, { path, method: "GET", readTimeout: 10_000 })
  if (result.ok) return result
  const status = result.error.status ? ` (HTTP ${result.error.status})` : ""
  return { ...result, error: { ...result.error, message: `${t("machine.connectionCheckFailed")}${status}` } }
}
