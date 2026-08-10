import type { BackendKind, HarnessCapabilities } from "./types"

const bridgeCapabilities = (overrides: Partial<HarnessCapabilities> = {}): HarnessCapabilities => ({
  sessions: true,
  prompt: true,
  abort: true,
  streaming: true,
  models: false,
  agents: false,
  todos: false,
  diff: false,
  filesystemBrowser: true,
  questions: false,
  permissions: false,
  commands: false,
  actions: false,
  sessionRename: true,
  sessionDelete: true,
  attachments: false,
  ...overrides
})

export const DEFAULT_HARNESS_CAPABILITIES: Record<BackendKind, HarnessCapabilities> = {
  opencode: {
    sessions: true, prompt: true, abort: true, streaming: true, models: true, agents: true,
    todos: true, diff: true, filesystemBrowser: true, questions: true, permissions: true,
    commands: true, actions: false, sessionRename: true, sessionDelete: true, attachments: false
  },
  omp: bridgeCapabilities({ models: true, todos: true, commands: true, actions: true }),
  pi: bridgeCapabilities({ models: true, commands: true }),
  prime: bridgeCapabilities(),
  claude: bridgeCapabilities({ models: true, todos: true }),
  codex: bridgeCapabilities({ models: true, todos: true, commands: true })
}
