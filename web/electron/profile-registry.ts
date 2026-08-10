import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { baseUrl } from "../src/serverConfig.js"
import type { BackendKind } from "../src/types.js"
import type { DesktopProfile } from "./ipc-contract.js"

const BACKENDS: readonly BackendKind[] = ["opencode", "omp", "pi", "prime", "claude", "codex"]
const MAX_PROFILE_COUNT = 100
const MAX_PROFILE_ID_LENGTH = 128
const MAX_HOST_LENGTH = 2048
const MAX_CREDENTIAL_LENGTH = 4096

export class DesktopProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DesktopProfileError"
  }
}

function isBackend(value: unknown): value is BackendKind {
  return typeof value === "string" && BACKENDS.includes(value as BackendKind)
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value)
}
function validateHost(host: unknown): string {
  if (typeof host !== "string") throw new DesktopProfileError("Profile host must be text")
  const value = host.trim()
  if (!value || value.length > MAX_HOST_LENGTH || hasControlCharacters(value) || value.includes("\\")) {
    throw new DesktopProfileError("Profile host is invalid")
  }
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1].toLowerCase()
  if (scheme && scheme !== "http" && scheme !== "https") throw new DesktopProfileError("Profile protocol is unsupported")
  const candidate = scheme ? value : `http://${value}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new DesktopProfileError("Profile host is invalid")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new DesktopProfileError("Profile protocol is unsupported")
  if (!url.hostname || url.username || url.password || url.hash || url.search || (url.pathname !== "/" && url.pathname !== "")) {
    throw new DesktopProfileError("Profile host is invalid")
  }
  if (url.port) throw new DesktopProfileError("Profile host must not include a port")
  return value
}

export function validateDesktopProfile(value: unknown): DesktopProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DesktopProfileError("Profile is invalid")
  const candidate = value as Partial<DesktopProfile>
  if (typeof candidate.id !== "string") throw new DesktopProfileError("Profile ID is invalid")
  const id = candidate.id.trim()
  if (!id || id.length > MAX_PROFILE_ID_LENGTH || hasControlCharacters(id)) throw new DesktopProfileError("Profile ID is invalid")
  if (!isBackend(candidate.backend)) throw new DesktopProfileError("Profile backend is invalid")
  const host = validateHost(candidate.host)
  const port = candidate.port
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new DesktopProfileError("Profile port is invalid")
  if (typeof candidate.username !== "string" || typeof candidate.password !== "string") {
    throw new DesktopProfileError("Profile credentials are invalid")
  }
  if (candidate.username.length > MAX_CREDENTIAL_LENGTH || candidate.password.length > MAX_CREDENTIAL_LENGTH || hasControlCharacters(candidate.username) || hasControlCharacters(candidate.password)) {
    throw new DesktopProfileError("Profile credentials are invalid")
  }
  const profile = { id, backend: candidate.backend, host, port, username: candidate.username, password: candidate.password }
  try {
    new URL(baseUrl(profile))
  } catch {
    throw new DesktopProfileError("Profile target is invalid")
  }
  return profile
}

export function validateDesktopProfiles(value: unknown): DesktopProfile[] {
  if (!Array.isArray(value)) throw new DesktopProfileError("Profiles must be an array")
  if (value.length > MAX_PROFILE_COUNT) throw new DesktopProfileError("Too many profiles")
  const profiles: DesktopProfile[] = []
  const ids = new Set<string>()
  for (const candidate of value) {
    const profile = validateDesktopProfile(candidate)
    if (ids.has(profile.id)) throw new DesktopProfileError("Profile IDs must be unique")
    ids.add(profile.id)
    profiles.push(profile)
  }
  return profiles
}

export type ProfileRegistryChange = {
  revision: number
  acceptedProfileIDs: string[]
  changedProfileIDs: string[]
  removedProfileIDs: string[]
  unchangedProfileIDs: string[]
}

function sameProfile(left: DesktopProfile, right: DesktopProfile): boolean {
  return left.id === right.id
    && left.backend === right.backend
    && left.host === right.host
    && left.port === right.port
    && left.username === right.username
    && left.password === right.password
}

/** Main-owned allowlist. Renderer profile mutation represents user-approved Settings state. */
export class ProfileRegistry {
  private profiles = new Map<string, DesktopProfile>()
  private nextRevision = 0
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8")
      const profiles = validateDesktopProfiles(JSON.parse(raw))
      this.profiles = new Map(profiles.map((profile) => [profile.id, profile]))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      this.profiles.clear()
    }
  }

  replace(value: unknown, requestedRevision?: number): Promise<ProfileRegistryChange> {
    const profiles = validateDesktopProfiles(value)
    if (requestedRevision !== undefined && (!Number.isSafeInteger(requestedRevision) || requestedRevision < 1)) {
      throw new DesktopProfileError("Profile revision is invalid")
    }
    // Renderer revisions are session-local and restart after a renderer reload. The queue defines
    // update order; main assigns the durable revision so a reloaded renderer cannot be mistaken for
    // a stale writer and left with a registry that disagrees with its saved profiles.
    const revision = ++this.nextRevision
    const operation = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const next = new Map(profiles.map((profile) => [profile.id, profile]))
      const temporaryPath = `${this.filePath}.${process.pid}.${revision}.tmp`
      const handle = await open(temporaryPath, "w", 0o600)
      try {
        try {
          await handle.writeFile(`${JSON.stringify(profiles)}\n`, "utf8")
          await handle.sync()
        } finally {
          await handle.close()
        }
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
        throw error
      }
      try {
        await rename(temporaryPath, this.filePath)
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
        throw error
      }
      const change = this.changeFor(next, revision, this.profiles)
      this.profiles = next
      return change
    })
    this.writeQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  private changeFor(next: Map<string, DesktopProfile>, revision: number, previous = this.profiles): ProfileRegistryChange {
    const changedProfileIDs: string[] = []
    const removedProfileIDs: string[] = []
    const unchangedProfileIDs: string[] = []
    for (const [id, profile] of next) {
      const old = previous.get(id)
      if (old && sameProfile(old, profile)) unchangedProfileIDs.push(id)
      else changedProfileIDs.push(id)
    }
    for (const id of previous.keys()) {
      if (!next.has(id)) removedProfileIDs.push(id)
    }
    return {
      revision,
      acceptedProfileIDs: [...next.keys()],
      changedProfileIDs,
      removedProfileIDs,
      unchangedProfileIDs
    }
  }

  get(id: string): DesktopProfile {
    const profile = this.profiles.get(id)
    if (!profile) throw new DesktopProfileError("Unknown server profile")
    return profile
  }

  has(id: string): boolean {
    return this.profiles.has(id)
  }

  ids(): string[] {
    return [...this.profiles.keys()]
  }
}
