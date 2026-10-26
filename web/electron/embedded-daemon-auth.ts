import { randomBytes } from "node:crypto"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"

export type EmbeddedDaemonAuth = {
  username: string
  password: string
}

const AUTH_VERSION = 1
const AUTH_USERNAME = "harness-desktop"
const AUTH_PASSWORD_BYTES = 24
const MIN_PASSWORD_LENGTH = 24
const MAX_FIELD_LENGTH = 256

/** A credential suitable for the desktop daemon and for a phone that pairs with it. */
export function createEmbeddedDaemonAuth(): EmbeddedDaemonAuth {
  return {
    username: AUTH_USERNAME,
    password: randomBytes(AUTH_PASSWORD_BYTES).toString("base64url")
  }
}

function parseStoredAuth(raw: string): EmbeddedDaemonAuth | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as { version?: unknown; username?: unknown; password?: unknown }
  if (candidate.version !== AUTH_VERSION) return null
  if (typeof candidate.username !== "string" || candidate.username.length === 0 || candidate.username.length > MAX_FIELD_LENGTH) return null
  if (typeof candidate.password !== "string" || candidate.password.length < MIN_PASSWORD_LENGTH || candidate.password.length > MAX_FIELD_LENGTH) return null
  return { username: candidate.username, password: candidate.password }
}

async function writeAuth(path: string, auth: EmbeddedDaemonAuth): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  const handle = await open(temporaryPath, "w", 0o600)
  try {
    await handle.writeFile(`${JSON.stringify({ version: AUTH_VERSION, ...auth })}\n`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Load the desktop-owned daemon credential, creating it on first launch and replacing a malformed
 * file. The credential is deliberately kept outside desktop-profiles.json: it is an internal secret,
 * while that file is renderer-owned user configuration.
 *
 * Persisting this value is what lets a phone paired via QR keep working after the app or its
 * embedded daemon restarts. Before this file existed the daemon generated a fresh password on every
 * launch, so the phone's saved Basic Auth credentials started returning 401.
 */
export async function loadOrCreateEmbeddedDaemonAuth(path: string): Promise<EmbeddedDaemonAuth> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    const auth = createEmbeddedDaemonAuth()
    await writeAuth(path, auth)
    return auth
  }

  const existing = parseStoredAuth(raw)
  if (existing) return existing

  // A truncated or hand-edited file must not keep the desktop runtime unavailable. Rotating here
  // costs one re-pair, while failing startup would leave the app without a local machine at all.
  const auth = createEmbeddedDaemonAuth()
  await writeAuth(path, auth)
  return auth
}
