import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"

/**
 * Network behaviour of the desktop-local runtime. Today this is the pair-a-phone opt-in: with LAN
 * pairing on, the embedded daemon binds the wildcard address so phones on the same network can
 * reach it; off is the loopback-only default the app has always shipped with.
 */
export type NetworkSettings = {
  lanPairing: boolean
}

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = Object.freeze({ lanPairing: false })

/** Settings cross a file boundary and an IPC boundary, so only a well-formed object counts. An
 *  unreadable file or an invalid in-flight value leaves the last known settings alone. */
export function parseNetworkSettings(value: unknown): NetworkSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = (value as { lanPairing?: unknown }).lanPairing
  return typeof candidate === "boolean" ? { lanPairing: candidate } : null
}

export class NetworkSettingsStore {
  private settings: NetworkSettings = { ...DEFAULT_NETWORK_SETTINGS }
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  get(): NetworkSettings {
    return { ...this.settings }
  }

  async load(): Promise<void> {
    try {
      const parsed = parseNetworkSettings(JSON.parse(await readFile(this.filePath, "utf8")))
      if (parsed) this.settings = parsed
    } catch {
      // A missing or unreadable file means defaults: LAN pairing stays off until explicitly enabled.
    }
  }

  async replace(value: unknown): Promise<NetworkSettings> {
    const settings = parseNetworkSettings(value)
    if (!settings) throw new TypeError("Invalid network settings")
    const operation = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`
      const handle = await open(temporaryPath, "w", 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(settings)}\n`, "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await rename(temporaryPath, this.filePath)
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
        throw error
      }
      this.settings = settings
      return { ...settings }
    })
    this.writeQueue = operation.then(() => undefined, () => undefined)
    return operation
  }
}
