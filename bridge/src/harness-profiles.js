import { createOmpHistoryLoader } from "./omp-session-history.js"

export const HARNESS_PROFILES = {
  omp: {
    id: "omp",
    label: "Oh My Pi",
    auth: { mode: "required", methodID: "agent" },
    permissionMode: "allow",
    historyLoader: createOmpHistoryLoader(),
    capabilities: {
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
    process({ agentBin, agentArgs }) {
      return { command: agentBin, args: ["acp", ...agentArgs] }
    },
    versionProcess({ agentBin }) {
      return { command: agentBin, args: ["--version"] }
    }
  },
  pi: {
    id: "pi",
    label: "Pi",
    auth: { mode: "skip" },
    permissionMode: "allow",
    capabilities: {
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
    },
    process({ agentBin, agentArgs, piBin }) {
      return {
        command: agentBin,
        args: agentArgs,
        env: piBin ? { PI_ACP_PI_COMMAND: piBin } : undefined
      }
    },
    versionProcess({ piBin }) {
      return { command: piBin, args: ["--version"] }
    }
  }
}

export function harnessProfile(kind) {
  const profile = HARNESS_PROFILES[kind]
  if (!profile) throw new Error(`Unsupported harness: ${kind}`)
  return profile
}
