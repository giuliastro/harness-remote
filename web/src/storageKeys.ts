/** Storage keys are shared with the crash-recovery reset, so they live outside App.tsx. */
export const LEGACY_STORAGE_KEY = "opencode.remote.server"
export const ACTIVE_BACKEND_STORAGE_KEY = "opencode.remote.backend"
export const BACKEND_STORAGE_KEYS = {
  opencode: "opencode.remote.server.opencode",
  omp: "opencode.remote.server.omp",
  pi: "opencode.remote.server.pi"
} as const

/** Everything that describes a backend connection; language and theme are deliberately excluded. */
export const SERVER_STORAGE_KEYS = [
  LEGACY_STORAGE_KEY,
  ACTIVE_BACKEND_STORAGE_KEY,
  BACKEND_STORAGE_KEYS.opencode,
  BACKEND_STORAGE_KEYS.omp,
  BACKEND_STORAGE_KEYS.pi,
  "opencode.remote.model",
  "opencode.remote.agent",
  "opencode.remote.newSessionDirectory"
]
