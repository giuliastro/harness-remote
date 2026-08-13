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

function worktreeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
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
    if (task?.status !== "draft") throw worktreeError("invalid_state", "Only draft tasks can prepare a workspace")
    if (task?.project?.kind !== "git") throw worktreeError("non_git_project", "Worktree isolation requires a Git project")
    if (task?.workspace?.mode === "worktree") return structuredClone(task.workspace)

    const key = taskKey(task.id)
    const branch = `task/${key}`
    const worktreePath = path.join(this.stateDirectory, "worktrees", key)
    if (await exists(worktreePath)) throw worktreeError("worktree_exists", `Worktree path already exists: ${worktreePath}`)

    await this.runGit(["-C", task.project.path, "rev-parse", "--show-toplevel"])
    await mkdir(path.dirname(worktreePath), { recursive: true })
    await this.runGit(["-C", task.project.path, "worktree", "add", "-B", branch, worktreePath, "HEAD"])

    return { mode: "worktree", path: worktreePath, branch, source: task.project.path }
  }

  async inspect(workspace) {
    await this.#assertManagedWorkspace(workspace)
    const result = await this.runGit(["-C", workspace.path, "status", "--porcelain=v1", "--untracked-files=all"])
    const changes = String(result?.stdout ?? "").split(/\r?\n/).filter(Boolean)
    return { managed: true, dirty: changes.length > 0, changeCount: changes.length }
  }

  async cleanup(workspace) {
    const status = await this.inspect(workspace)
    if (status.dirty) throw worktreeError("worktree_dirty", "Worktree has uncommitted changes and cannot be removed")

    await this.runGit(["-C", workspace.source, "worktree", "remove", workspace.path])
    let branchDeleted = false
    try {
      await this.runGit(["-C", workspace.source, "branch", "-d", workspace.branch])
      branchDeleted = true
    } catch {
      // A clean worktree may still contain committed, unmerged work. Preserve that branch.
    }
    return { removed: true, branchDeleted }
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

  async #assertManagedWorkspace(workspace) {
    if (workspace?.mode !== "worktree" || !workspace.path || !workspace.branch || !workspace.source) {
      throw worktreeError("invalid_worktree", "Task does not reference a managed worktree")
    }
    const root = path.resolve(this.stateDirectory, "worktrees")
    const target = path.resolve(workspace.path)
    const relative = path.relative(root, target)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw worktreeError("worktree_outside_state", "Worktree is outside the daemon-managed workspace directory")
    }
    let stat
    try {
      stat = await lstat(target)
    } catch (error) {
      if (error?.code === "ENOENT") throw worktreeError("worktree_missing", "Managed worktree no longer exists")
      throw error
    }
    if (stat.isSymbolicLink()) throw worktreeError("worktree_outside_state", "Managed worktree path cannot be a symbolic link")
  }
}
