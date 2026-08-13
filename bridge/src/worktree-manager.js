import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { lstat, mkdir } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const DEFAULT_GIT_TIMEOUT_MS = 30_000

function taskKey(taskID) {
  return createHash("sha256").update(taskID).digest("hex").slice(0, 12)
}

async function exists(candidate) {
  try {
    await lstat(candidate)
    return true
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

async function defaultRunGit(args) {
  try {
    return await execFileAsync("git", args, { maxBuffer: 1024 * 1024, timeout: DEFAULT_GIT_TIMEOUT_MS })
  } catch (error) {
    if (error?.killed || error?.signal === "SIGTERM") {
      throw new Error(`Git operation timed out after ${DEFAULT_GIT_TIMEOUT_MS}ms`)
    }
    throw error
  }
}

export class WorktreeManager {
  constructor({ stateDirectory, runGit = defaultRunGit }) {
    this.stateDirectory = stateDirectory
    this.runGit = runGit
  }

  async prepare(task) {
    if (task?.status !== "draft") throw new Error("Only draft tasks can prepare a workspace")
    if (task?.project?.kind !== "git") throw new Error("Worktree isolation requires a Git project")
    if (task?.workspace?.mode === "worktree") return structuredClone(task.workspace)

    const key = taskKey(task.id)
    const branch = `task/${key}`
    const worktreePath = path.join(this.stateDirectory, "worktrees", key)
    if (await exists(worktreePath)) throw new Error(`Worktree path already exists: ${worktreePath}`)

    await this.runGit(["-C", task.project.path, "rev-parse", "--show-toplevel"])
    await mkdir(path.dirname(worktreePath), { recursive: true })
    await this.runGit(["-C", task.project.path, "worktree", "add", "-B", branch, worktreePath, "HEAD"])

    return { mode: "worktree", path: worktreePath, branch, source: task.project.path }
  }

  async rollback(workspace) {
    if (workspace?.mode !== "worktree" || !workspace.path || !workspace.branch || !workspace.source) return
    try {
      await this.runGit(["-C", workspace.source, "worktree", "remove", "--force", workspace.path])
    } catch {
      return
    }
    try {
      await this.runGit(["-C", workspace.source, "branch", "-D", workspace.branch])
    } catch {
      // A later prepare() uses -B, so a leftover task-scoped branch cannot wedge retries.
    }
  }
}
