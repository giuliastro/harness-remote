import { createCodexHistoryLoader } from "./codex-session-history.js"
import { createOmpHistoryLoader } from "./omp-session-history.js"
import { OMP_EXTENSION_ACTION_PROVIDERS } from "./extension-actions.js"

const COMMON_CAPABILITIES = {
  sessions: true,
  prompt: true,
  abort: true,
  streaming: true,
  agents: false,
  diff: false,
  filesystemBrowser: true,
  questions: false,
  permissions: false,
  sessionRename: false,
  sessionDelete: false
}

export const HARNESS_PROFILES = {
  omp: {
    id: "omp",
    label: "Oh My Pi",
    command: "omp",
    args: ["acp"],
    permissionMode: "allow",
    historyLoader: createOmpHistoryLoader(),
    capabilities: {
      ...COMMON_CAPABILITIES,
      models: true,
      todos: true,
      commands: true,
      actions: true,
      sessionRename: true,
      sessionDelete: true
    },
    actionProviders: OMP_EXTENSION_ACTION_PROVIDERS
  },
  pi: {
    id: "pi",
    label: "PI",
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["-y", "@automatalabs/pi-acp@0.2.5"],
    permissionMode: "allow",
    preserveListedTimestamps: true,
    reloadOnHistoryRefresh: false,
    capabilities: {
      ...COMMON_CAPABILITIES,
      models: true,
      todos: false,
      commands: true,
      actions: false,
      sessionRename: true,
      sessionDelete: true
    }
  },
  prime: {
    id: "prime",
    label: "Prime Agent",
    // Prime Agent speaks ACP natively. Its current ACP surface intentionally omits
    // session/list and session/load, so this first integration supports sessions created
    // by the running bridge process and relies on the bridge snapshots for their UI state.
    command: "prime-agent",
    args: ["--mode", "acp"],
    permissionMode: "allow",
    preserveListedTimestamps: true,
    reloadOnHistoryRefresh: false,
    capabilities: {
      ...COMMON_CAPABILITIES,
      models: false,
      todos: false,
      commands: false,
      actions: false,
      sessionRename: true,
      sessionDelete: true
    }
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.63.0"],
    permissionMode: "allow",
    preserveListedTimestamps: true,
    reloadOnHistoryRefresh: false,
    capabilities: {
      ...COMMON_CAPABILITIES,
      models: true,
      todos: true,
      commands: false,
      actions: false,
      sessionRename: true,
      sessionDelete: true
    }
  },
  codex: {
    id: "codex",
    label: "Codex CLI",
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.1.14"],
    permissionMode: "allow",
    authMethod: "chat-gpt",
    historyLoader: createCodexHistoryLoader(),
    preserveListedTimestamps: true,
    reloadOnHistoryRefresh: false,
    capabilities: {
      ...COMMON_CAPABILITIES,
      models: true,
      todos: true,
      commands: true,
      actions: false,
      sessionRename: true,
      sessionDelete: true
    }
  }
}

export function harnessProfile(id) {
  const profile = HARNESS_PROFILES[id]
  if (!profile) throw new Error(`Unsupported backend: ${id}`)
  return profile
}
