import type { BackendKind, ServerConfig } from "./types"

/** Every server storage key lives here: the crash-recovery reset in storageKeys.ts composes them,
    and only this module reads or writes them. Keep this file free of runtime sibling imports so the
    node test runner, which cannot resolve extensionless specifiers, can load it directly. */
export const LEGACY_STORAGE_KEY = "opencode.remote.server"
export const ACTIVE_BACKEND_STORAGE_KEY = "opencode.remote.backend"
export const BACKEND_STORAGE_KEYS = {
  opencode: "opencode.remote.server.opencode",
  omp: "opencode.remote.server.omp",
  pi: "opencode.remote.server.pi",
  claude: "opencode.remote.server.claude",
  codex: "opencode.remote.server.codex"
} as const

export const SERVER_PROFILES_STORAGE_KEY = "opencode.remote.serverProfiles"
export const ACTIVE_PROFILE_STORAGE_KEY = "opencode.remote.activeServerProfile"
export const ACTIVE_PROFILE_CHANGED_EVENT = "harness-remote:active-profile-changed"

const NEW_SESSION_DIRECTORY_STORAGE_KEY = "opencode.remote.newSessionDirectory"
const NEW_SESSION_DIRECTORY_BY_PROFILE_STORAGE_KEY = "opencode.remote.newSessionDirectoryByProfile"

export type SavedServerProfile = {
  id: string
  name: string
  config: ServerConfig
}

const BACKENDS: BackendKind[] = ["opencode", "omp", "pi", "claude", "codex"]

function defaultConfig(backend: BackendKind): ServerConfig {
  return {
    backend,
    host: "",
    port: backend === "opencode" ? 4096 : 4097,
    username: backend === "opencode" ? "opencode" : backend,
    password: ""
  }
}

function isBackend(value: unknown): value is BackendKind {
  return value === "opencode" || value === "omp" || value === "pi" || value === "claude" || value === "codex"
}

function parseConfig(value: unknown, fallbackBackend: BackendKind): ServerConfig | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<ServerConfig>
  const backend = isBackend(candidate.backend) ? candidate.backend : fallbackBackend
  if (typeof candidate.host !== "string" || typeof candidate.port !== "number" || typeof candidate.username !== "string" || typeof candidate.password !== "string") return null
  const agentId = typeof candidate.agentId === "string" && candidate.agentId.trim() ? candidate.agentId.trim() : undefined
  return { ...defaultConfig(backend), ...candidate, backend, agentId }
}

function profileID(): string {
  return globalThis.crypto?.randomUUID?.() ?? `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function profileName(backend: BackendKind, position: number): string {
  const label = backend === "omp" ? "Oh My Pi" : backend === "pi" ? "PI" : backend === "claude" ? "Claude Code" : backend === "codex" ? "Codex CLI" : "OpenCode"
  return position === 0 ? `${label} server` : `${label} server ${position + 1}`
}

/** Repair only profiles whose human name makes the earlier wrong-agent fallback unambiguous. */
function namedHarness(name: string): BackendKind | undefined {
  const value = name.trim().toLowerCase()
  if (/\boh my pi\b|\bomp\b/.test(value)) return "omp"
  if (/(^|[\s·._-])pi([\s·._-]|$)/.test(value)) return "pi"
  if (/\bclaude\b/.test(value)) return "claude"
  return undefined
}

function repairMisroutedDaemonProfile(profile: SavedServerProfile): SavedServerProfile {
  const intended = namedHarness(profile.name)
  if (!intended || profile.config.backend !== "codex" || profile.config.agentId !== "codex") return profile
  return { ...profile, config: { ...profile.config, backend: intended, agentId: intended } }
}

function sameMachine(left: ServerConfig, right: ServerConfig): boolean {
  return left.host.trim().toLowerCase() === right.host.trim().toLowerCase() && left.username === right.username
}

/** Repair the bad internal OpenCode port only when another saved daemon profile identifies its port. */
function repairInternalOpenCodePort(profile: SavedServerProfile, profiles: SavedServerProfile[]): SavedServerProfile {
  const intended = namedHarness(profile.name)
  if (!intended || profile.config.backend !== intended || profile.config.agentId || profile.config.port !== 4096) return profile
  const knownDaemonPort = profiles.find((candidate) =>
    candidate.id !== profile.id && candidate.config.backend !== "opencode" &&
    candidate.config.port !== 4096 && sameMachine(candidate.config, profile.config)
  )?.config.port
  if (!knownDaemonPort) return profile
  return { ...profile, config: { ...profile.config, port: knownDaemonPort, agentId: intended } }
}

function parseProfiles(value: string | null): SavedServerProfile[] | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return null
    const profiles = parsed.flatMap((candidate, index) => {
      if (!candidate || typeof candidate !== "object") return []
      const source = candidate as { id?: unknown; name?: unknown; config?: unknown }
      const config = parseConfig(source.config, "opencode")
      if (!config) return []
      return [{
        id: typeof source.id === "string" && source.id ? source.id : profileID(),
        name: typeof source.name === "string" && source.name.trim() ? source.name.trim() : profileName(config.backend, index),
        config
      }]
    })
    if (!profiles.length) return null
    const repaired = profiles.map(repairMisroutedDaemonProfile)
    return repaired.map((profile) => repairInternalOpenCodePort(profile, repaired))
  } catch {
    return null
  }
}

/** Read only real legacy entries. Keeping this separate from the blank fallback lets a newer
    profile collection absorb a configuration from an older backend-specific key without adding
    an invented empty server on every launch. */
function readLegacyProfiles(): SavedServerProfile[] {
  const profiles: SavedServerProfile[] = []
  for (const backend of BACKENDS) {
    const raw = localStorage.getItem(BACKEND_STORAGE_KEYS[backend])
    if (!raw) continue
    try {
      const config = parseConfig(JSON.parse(raw), backend)
      if (config) profiles.push({ id: profileID(), name: profileName(config.backend, profiles.length), config })
    } catch {
      // Ignore malformed old storage and continue with the remaining saved servers.
    }
  }
  if (profiles.length > 0) return profiles
  try {
    const legacy = parseConfig(JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) ?? "null"), "opencode")
    if (legacy) return [{ id: profileID(), name: profileName(legacy.backend, 0), config: legacy }]
  } catch {
    // Ignore malformed legacy storage and continue with the backend-specific entries.
  }
  return profiles
}

function legacyProfiles(): SavedServerProfile[] {
  const profiles = readLegacyProfiles()
  if (profiles.length > 0) return profiles
  const backend = localStorage.getItem(ACTIVE_BACKEND_STORAGE_KEY)
  const fallback = isBackend(backend) ? backend : "opencode"
  return [{ id: profileID(), name: profileName(fallback, 0), config: defaultConfig(fallback) }]
}

function readDirectoryScopes(): Record<string, string> {
  const raw = localStorage.getItem(NEW_SESSION_DIRECTORY_BY_PROFILE_STORAGE_KEY)
  if (raw === null) {
    // The previous format had one path for every machine. It is unsafe to guess which profile owns
    // that value, so discard it once instead of carrying a Windows path into Linux or vice versa.
    localStorage.removeItem(NEW_SESSION_DIRECTORY_STORAGE_KEY)
    localStorage.setItem(NEW_SESSION_DIRECTORY_BY_PROFILE_STORAGE_KEY, "{}")
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  } catch {
    return {}
  }
}

function connectionIdentity(config: ServerConfig): string {
  return JSON.stringify({
    backend: config.backend,
    host: config.host.trim().toLowerCase(),
    port: config.port,
    username: config.username,
    agentId: config.agentId?.trim() ?? ""
  })
}

function switchNewSessionDirectory(previousProfileID: string | null, nextProfileID: string, clearNext: boolean): void {
  const scopes = readDirectoryScopes()
  if (previousProfileID) {
    const current = localStorage.getItem(NEW_SESSION_DIRECTORY_STORAGE_KEY) ?? ""
    if (current) scopes[previousProfileID] = current
    else delete scopes[previousProfileID]
  }
  if (clearNext) delete scopes[nextProfileID]
  localStorage.setItem(NEW_SESSION_DIRECTORY_BY_PROFILE_STORAGE_KEY, JSON.stringify(scopes))
  localStorage.setItem(NEW_SESSION_DIRECTORY_STORAGE_KEY, clearNext ? "" : (scopes[nextProfileID] ?? ""))
}

export function loadServerProfiles(): SavedServerProfile[] {
  const savedProfiles = parseProfiles(localStorage.getItem(SERVER_PROFILES_STORAGE_KEY))
  if (!savedProfiles) return legacyProfiles()

  // A user may upgrade while they already have one new-format server plus an older OMP/PI/etc.
  // backend key. Treat the collection as authoritative for profiles it knows, but retain a legacy
  // configuration for a backend that the collection does not contain. Previously the startup
  // persistence below overwrote that key's only path back into the UI.
  const legacyOnly = readLegacyProfiles().filter((legacyProfile) =>
    !savedProfiles.some((profile) => profile.config.backend === legacyProfile.config.backend)
  )
  return [...savedProfiles, ...legacyOnly]
}

export function loadActiveServerProfile(profiles: SavedServerProfile[]): SavedServerProfile {
  readDirectoryScopes()
  const storedID = localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY)
  return profiles.find((profile) => profile.id === storedID) ?? profiles[0]
}

export function persistServerProfiles(profiles: SavedServerProfile[], activeProfileID: string): void {
  const previousProfileID = localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY)
  const previousProfiles = parseProfiles(localStorage.getItem(SERVER_PROFILES_STORAGE_KEY)) ?? []
  const previousProfile = previousProfiles.find((profile) => profile.id === previousProfileID)
  const nextProfile = profiles.find((profile) => profile.id === activeProfileID)
  const profileChanged = previousProfileID !== null && previousProfileID !== activeProfileID
  const connectionChanged = Boolean(
    previousProfileID === activeProfileID && previousProfile && nextProfile &&
    connectionIdentity(previousProfile.config) !== connectionIdentity(nextProfile.config)
  )

  if (profileChanged || connectionChanged) {
    switchNewSessionDirectory(previousProfileID, activeProfileID, connectionChanged)
  }

  localStorage.setItem(SERVER_PROFILES_STORAGE_KEY, JSON.stringify(profiles))
  localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, activeProfileID)

  // Switching profiles must remount the app so profile-scoped state is re-read. Editing the host,
  // port or credentials of the current profile must not: Settings persists valid drafts while the
  // user types, and remounting there closes the editor and starts a connection mid-entry.
  if (profileChanged) {
    window.dispatchEvent(new CustomEvent(ACTIVE_PROFILE_CHANGED_EVENT, { detail: activeProfileID }))
  }
}

export function createServerProfile(name: string, backend: BackendKind): SavedServerProfile {
  return { id: profileID(), name: name.trim() || profileName(backend, 0), config: defaultConfig(backend) }
}
