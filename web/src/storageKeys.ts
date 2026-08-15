import {
  ACTIVE_BACKEND_STORAGE_KEY,
  ACTIVE_PROFILE_STORAGE_KEY,
  BACKEND_STORAGE_KEYS,
  LEGACY_STORAGE_KEY,
  SERVER_PROFILES_STORAGE_KEY
} from "./serverProfiles"

/** Everything that describes a backend connection; language and theme are deliberately excluded. The
    keys themselves belong to serverProfiles.ts, the only module that reads or writes them: this list
    exists so the crash-recovery reset can clear a broken connection without importing App.tsx. */
export const SERVER_STORAGE_KEYS = [
  LEGACY_STORAGE_KEY,
  ACTIVE_BACKEND_STORAGE_KEY,
  BACKEND_STORAGE_KEYS.opencode,
  BACKEND_STORAGE_KEYS.opencode2,
  BACKEND_STORAGE_KEYS.omp,
  BACKEND_STORAGE_KEYS.pi,
  BACKEND_STORAGE_KEYS.claude,
  BACKEND_STORAGE_KEYS.codex,
  "opencode.remote.model",
  "opencode.remote.agent",
  "opencode.remote.newSessionDirectory",
  SERVER_PROFILES_STORAGE_KEY,
  ACTIVE_PROFILE_STORAGE_KEY
]
