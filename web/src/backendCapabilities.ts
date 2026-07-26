import type { BackendKind, HarnessCapabilities } from "./types"

export const DEFAULT_HARNESS_CAPABILITIES: Record<BackendKind, HarnessCapabilities> = {
  opencode: {
    sessions: true,
    prompt: true,
    abort: true,
    streaming: true,
    models: true,
    agents: true,
    todos: true,
    diff: true,
    filesystemBrowser: true,
    questions: true,
    commands: true,
    sessionRename: true,
    sessionDelete: true
  },
  omp: {
    sessions: true,
    prompt: true,
    abort: true,
    streaming: true,
    models: true,
    agents: false,
    todos: true,
    diff: false,
    filesystemBrowser: true,
    questions: false,
    commands: false,
    sessionRename: false,
    sessionDelete: false
  },
  pi: {
    sessions: true,
    prompt: true,
    abort: true,
    streaming: true,
    models: true,
    agents: false,
    todos: false,
    diff: false,
    filesystemBrowser: true,
    questions: false,
    commands: true,
    sessionRename: false,
    sessionDelete: false
  }
}
