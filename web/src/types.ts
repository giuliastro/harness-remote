export type BackendKind = "opencode" | "omp" | "pi" | "claude" | "codex"

export type ServerConfig = {
  backend: BackendKind
  host: string
  port: number
  username: string
  password: string
}

export type HarnessCapabilities = {
  sessions: boolean
  prompt: boolean
  abort: boolean
  streaming: boolean
  models: boolean
  agents: boolean
  todos: boolean
  diff: boolean
  filesystemBrowser: boolean
  questions: boolean
  permissions: boolean
  commands: boolean
  actions: boolean
  sessionRename: boolean
  sessionDelete: boolean
}

export type HealthResponse = {
  healthy: boolean
  version: string
  backend?: BackendKind
}

export type ModelSelection = {
  providerID: string
  modelID: string
  variant?: string
}

export type AgentOption = {
  id: string
  name: string
  description?: string
  mode: "primary" | "subagent" | "all"
  hidden?: boolean
}

export type ModelOption = ModelSelection & {
  providerName: string
  modelName: string
  /** Present when the harness describes its models, as the ACP adapters do; OpenCode does not. */
  description?: string
  status?: string
  contextLimit?: number
  outputLimit?: number
  tools?: boolean
  attachments?: boolean
  isDefault?: boolean
}

export type Session = {
  id: string
  title: string
  directory: string
  time: {
    created: number
    updated: number
  }
  summary?: {
    additions: number
    deletions: number
    files: number
  }
  model?: {
    id: string
    providerID: string
    variant?: string
  }
  project?: {
    id: string
    name?: string
    worktree: string
  } | null
  revert?: {
    messageID: string
    partID?: string
  }
  external?: boolean
}

export type SessionStatus = {
  type: string
  attempt?: number
  message?: string
  next?: number
}

export type ToolState = {
  status: string
  input?: Record<string, unknown>
  title?: string
  output?: string
  error?: string
  time?: { start: number; end?: number }
  metadata?: { answers?: string[][] }
}

export type MessagePart = {
  id: string
  messageID?: string
  type: string
  text?: string
  tool?: string
  callID?: string
  state?: ToolState
  hash?: string
  files?: string[]
  time?: { start: number; end?: number }
}

export type MessageEnvelope = {
  info: {
    id: string
    role: string
    sessionID: string
    time: {
      created: number
      completed?: number
    }
  }
  parts: MessagePart[]
}

export type TodoItem = {
  content: string
  status: string
  priority: string
  id: string
}

export type QuestionOption = {
  label: string
  description: string
}

export type QuestionInfo = {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export type QuestionRequest = {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  tool?: {
    messageID: string
    callID: string
  }
}

export type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: {
    messageID: string
    callID: string
  }
}

export type DiffFile = {
  file: string
  additions: number
  deletions: number
  patch?: string
  status?: "added" | "deleted" | "modified"
}

export type ProjectCurrent = Record<string, unknown> & {
  name?: string
  path?: string
  directory?: string
  root?: string
}

export type VcsStatus = Record<string, unknown> & {
  branch?: string
  status?: string
  ahead?: number
  behind?: number
}

export type FileStatusEntry = Record<string, unknown> & {
  path?: string
  file?: string
  status?: string
}

export type FileEntry = {
  name: string
  path: string
  absolute: string
  type: "file" | "directory"
  ignored?: boolean
}

export type PathInfo = {
  home: string
  state: string
  config: string
  worktree: string
  directory: string
}

export type ProjectDashboard = {
  project: ProjectCurrent | null
  vcs: VcsStatus | null
  files: FileStatusEntry[]
}

export type SessionView = {
  id: string
  title: string
  directory: string
  updated: number
  status: string
  files: number
  additions: number
  deletions: number
  model?: ModelSelection
  revertMessageID?: string
  external?: boolean
}

export type CommandInfo = {
  name: string
  description?: string
  source?: "command" | "mcp" | "skill"
}

export type HarnessAction = {
  id: string
  source?: string
  enabled: boolean
}

export type HarnessActionResult = {
  action: string
  applied: boolean | null
  actions: HarnessAction[]
  sessionRevision?: string
}
