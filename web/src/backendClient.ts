import type { BackendKind } from "./types"

export type BackendClient = {
  modelSelectionRequiresSession: boolean
  messageRefreshSupported: boolean
}

export const BACKEND_CLIENTS: Record<BackendKind, BackendClient> = {
  opencode: {
    modelSelectionRequiresSession: false,
    messageRefreshSupported: false
  },
  opencode2: {
    modelSelectionRequiresSession: false,
    messageRefreshSupported: false
  },
  omp: {
    modelSelectionRequiresSession: true,
    messageRefreshSupported: true
  },
  pi: {
    modelSelectionRequiresSession: true,
    messageRefreshSupported: true
  },
  claude: {
    modelSelectionRequiresSession: true,
    messageRefreshSupported: true
  },
  codex: {
    modelSelectionRequiresSession: true,
    messageRefreshSupported: true
  }
}
