import { WORKSPACE_MACHINES_STORAGE_KEY } from "./workspaceMachines"

/**
 * Everything the crash-recovery reset must be able to clear; language and theme are deliberately
 * excluded.
 *
 * The Session-first shell boots from `workspaceMachines`, not from the 2.x server profiles. Its only
 * persisted product-layout value is the native Session rail width. Retired Conversation-first layout
 * keys are intentionally not part of the current recovery contract: that product surface no longer
 * exists and must not become a dependency again.
 */
export const SERVER_STORAGE_KEYS = [
  WORKSPACE_MACHINES_STORAGE_KEY,
  "harness-remote.sessionRailWidth.v1"
]
