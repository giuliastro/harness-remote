import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { copyFile, lstat, mkdir } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 30_000

function taskKey(taskID) {
  return createHash("sha256").update(taskID).digest("hex").slice(0, 16)
}

async function defaultRunGit(args) {
  return execFileAsync("git", args, { maxBuffer: 8 * 1024 * 1024, timeout: GIT_TIMEOUT_MS })
}

function safeRelative(relative) {
  if (!relative || path.isAbsolute(relative)) return false
  const normalized = path.normalize(relative)
  return normalized !== ".." && !normalized.startsWith(`..${path.sep}`)
}

function parseZeroList(value) {
  return String(value ?? "").split("\0").filter(Boolean)
}

export class WorkThreadCheckpointManager {
  constructor({ stateDirectory, runGit = defaultRunGit, idFactory = randomUUID, clock = () => new Date().toISOString() }) {
    this.stateDirectory = stateDirectory
    this.runGit = runGit
    this.idFactory = idFactory
    this.clock = clock
  }

  supported(task) {
    return Boolean(task?.workspace?.mode === "worktree" && task.workspace.path && task?.project?.kind === "git")
  }

  async create(task, { label = "Checkpoint", kind = "manual", runId = null } = {}) {
    if (!this.supported(task)) return null
    const checkpointID = this.idFactory()
    const directory = path.join(this.stateDirectory, "checkpoints", taskKey(task.id), checkpointID)
    const workspace = task.workspace.path
    const head = String((await this.runGit(["-C", workspace, "rev-parse", "HEAD"])).stdout ?? "").trim()
    const stash = String((await this.runGit(["-C", workspace, "stash", "create", `TaskDesk checkpoint ${checkpointID}`])).stdout ?? "").trim()
    const commit = stash || head
    const untracked = parseZeroList((await this.runGit(["-C", workspace, "ls-files", "--others", "--exclude-standard", "-z"])).stdout)
    const copied = []
    let partial = false

    for (const relative of untracked) {
      if (!safeRelative(relative)) {
        partial = true
        continue
      }
      const source = path.resolve(workspace, relative)
      const root = path.resolve(workspace)
      const inside = path.relative(root, source)
      if (!safeRelative(inside)) {
        partial = true
        continue
      }
      let stat
      try { stat = await lstat(source) } catch { partial = true; continue }
      if (!stat.isFile()) {
        partial = true
        continue
      }
      const destination = path.join(directory, "untracked", relative)
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(source, destination)
      copied.push(relative)
    }

    return {
      id: checkpointID,
      label,
      kind,
      runId: runId || null,
      createdAt: this.clock(),
      commit,
      baseHead: head,
      untrackedFiles: copied,
      partial
    }
  }

  async restore(task, checkpoint) {
    if (!this.supported(task)) throw new Error("Restore is available only for TaskDesk-managed Git workspaces")
    if (!checkpoint?.id || !checkpoint?.commit) throw new Error("Checkpoint is incomplete")
    const workspace = task.workspace.path
    const directory = path.join(this.stateDirectory, "checkpoints", taskKey(task.id), checkpoint.id)

    // Restore the captured tree without moving the task branch itself. The real branch HEAD remains
    // where it was; only the index/worktree are rewritten to the selected checkpoint.
    await this.runGit(["-C", workspace, "restore", `--source=${checkpoint.commit}`, "--staged", "--worktree", "--", "."])
    await this.runGit(["-C", workspace, "clean", "-fd"])

    for (const relative of checkpoint.untrackedFiles ?? []) {
      if (!safeRelative(relative)) continue
      const source = path.join(directory, "untracked", relative)
      const destination = path.resolve(workspace, relative)
      const root = path.resolve(workspace)
      if (!safeRelative(path.relative(root, destination))) continue
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(source, destination)
    }

    const status = await this.runGit(["-C", workspace, "status", "--porcelain=v1", "--untracked-files=all"])
    return {
      restored: true,
      checkpointId: checkpoint.id,
      changeCount: String(status.stdout ?? "").split(/\r?\n/).filter(Boolean).length
    }
  }
}
