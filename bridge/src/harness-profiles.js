const COMMON_CAPABILITIES = {
  sessions: true,
  prompt: true,
  abort: true,
  streaming: true,
  agents: false,
  diff: false,
  filesystemBrowser: true,
  questions: false,
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
    capabilities: {
      ...COMMON_CAPABILITIES,
      models: true,
      todos: true,
      commands: false
    }
  },
  pi: {
    id: "pi",
    label: "PI",
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["-y", "@victor-software-house/pi-acp"],
    permissionMode: "allow",
    capabilities: {
      ...COMMON_CAPABILITIES,
      models: true,
      todos: false,
      commands: true
    }
  }
}

export function harnessProfile(id) {
  const profile = HARNESS_PROFILES[id]
  if (!profile) throw new Error(`Unsupported backend: ${id}`)
  return profile
}
