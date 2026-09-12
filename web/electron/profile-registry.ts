import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { baseUrl } from "../src/serverConfig.js"
import type { BackendKind } from "../src/types.js"
import type { DesktopProfile } from "./ipc-contract.js"

const BACKENDS: readonly BackendKind[] = ["opencode", "omp", "pi", "claude", "codex"]
const MAX_PROFILE_COUNT = 100
const MAX_PROFILE_ID_LENGTH = 128
const MAX_HOST_LENGTH = 2048
const MAX_CREDENTIAL_LENGTH = 4096
const MAX_AGENT_ID_LENGTH = 128

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

/**
 * The id becomes a path segment, so it is held to what the daemon itself accepts for an agent name
 * rather than merely being escaped: anything with a separator or an encodable character in it would
 * be a way to aim a profile at a path other than the agent the user picked.
 */
function validateAgentID(value: unknown): string | undefined {
  if (typeof value !== "string") throw new DesktopProfileError("Profile agent is invalid")
  const agentID = value.trim()
  if (!agentID) return undefined
  if (agentID.length > MAX_AGENT_ID_LENGTH || !/^[A-Za-z0-9._-]+$/.test(agentID)) {
    throw new DesktopProfileError("Profile agent is invalid")
  }
  return agentID
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
  // A daemon-backed profile is only distinguishable from every other agent on the same machine by
  // its agent id: it is what puts /v1/agents/<id> in front of the path and what the event stream is
  // scoped by. Dropping it here left main holding a machine-root target for every profile, so the
  // desktop app sent all of them to the daemon's primary agent and each server showed that one
  // agent's sessions. The renderer already carries the field; main has to keep it to route at all.
  const agentId = candidate.agentId === undefined ? undefined : validateAgentID(candidate.agentId)
  const profile = {
    id,
    backend: candidate.backend,
    host,
    port,
    username: candidate.username,
    password: candidate.password,
    ...(agentId ? { agentId } : {})
  }
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
    && left.agentId === right.agentId
}

/** Main-owned allowlist. Renderer profile mutation represents user-approved Settings state. */
export class ProfileRegistry {
  private profiles = new Map<string, DesktopProfile>()
  // Runtime profiles are deliberately process-local. In particular, the desktop-owned daemon uses
  // ephemeral credentials that must never be serialized into desktop-profiles.json.
  private runtimeProfiles = new Map<string, DesktopProfile>()
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
    for (const profile of profiles) {
      if (this.runtimeProfiles.has(profile.id)) throw new DesktopProfileError("Profile ID is owned by the desktop runtime")
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

  /** Install or rotate a main-process-owned profile without ever touching persistent storage. */
  setRuntimeProfile(value: unknown): ProfileRegistryChange {
    const profile = validateDesktopProfile(value)
    if (this.profiles.has(profile.id)) throw new DesktopProfileError("Runtime profile ID collides with a saved profile")
    const previous = this.runtimeProfiles.get(profile.id)
    this.runtimeProfiles.set(profile.id, profile)
    const revision = ++this.nextRevision
    return {
      revision,
      acceptedProfileIDs: this.ids(),
      changedProfileIDs: previous && sameProfile(previous, profile) ? [] : [profile.id],
      removedProfileIDs: [],
      unchangedProfileIDs: previous && sameProfile(previous, profile) ? [profile.id] : []
    }
  }

  /** Remove a volatile profile and tell live transports to close subscriptions that used it. */
  clearRuntimeProfile(id: string): ProfileRegistryChange {
    const removed = this.runtimeProfiles.delete(id)
    const revision = ++this.nextRevision
    return {
      revision,
      acceptedProfileIDs: this.ids(),
      changedProfileIDs: [],
      removedProfileIDs: removed ? [id] : [],
      unchangedProfileIDs: []
    }
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
    const profile = this.runtimeProfiles.get(id) ?? this.profiles.get(id)
    if (!profile) throw new DesktopProfileError("Unknown server profile")
    return profile
  }

  has(id: string): boolean {
    return this.runtimeProfiles.has(id) || this.profiles.has(id)
  }

  ids(): string[] {
    return [...this.runtimeProfiles.keys(), ...this.profiles.keys()]
  }
}