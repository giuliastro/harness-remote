import fs from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { findExecutable } from "./launcher.js"
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
    adapterCommand: "pi-acp",
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
  claude: {
    id: "claude",
    label: "Claude Code",
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.63.0"],
    adapterCommand: "claude-agent-acp",
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
    adapterCommand: "codex-acp",
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

function fallbackHarnessCommand(profile) {
  if (profile.id !== "omp" || process.platform === "win32") return undefined
  const candidate = path.join(homedir(), ".local", "bin", "omp")
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return candidate
  } catch {
    return undefined
  }
}

export function resolveAcpLaunch(profile, { find = findExecutable } = {}) {
  if (!profile.adapterCommand) {
    const installed = find(profile.command) ?? fallbackHarnessCommand(profile)
    return { command: installed ?? profile.command, args: [...profile.args], source: installed ? "path" : "harness" }
  }
  const installed = find(profile.adapterCommand)
  if (installed) return { command: installed, args: [], source: "path" }
  return { command: profile.command, args: [...profile.args], source: "npx" }
}
