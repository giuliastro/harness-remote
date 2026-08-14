function text(result) {
  return String(result?.stdout ?? "")
}

function count(value) {
  if (value === "-") return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseNumstat(output) {
  return output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const [additions, deletions, ...pathParts] = line.split("\t")
    const path = pathParts.join("\t")
    if (!path) return []
    return [{ path, additions: count(additions), deletions: count(deletions), untracked: false }]
  })
}

export async function inspectTaskDiff(workspace, worktreeManager) {
  const status = await worktreeManager.inspect(workspace)
  const sourceHead = text(await worktreeManager.runGit(["-C", workspace.source, "rev-parse", "HEAD"])).trim()
  const tracked = parseNumstat(text(await worktreeManager.runGit([
    "-C", workspace.path, "diff", "--numstat", sourceHead, "--"
  ])))
  const trackedPaths = new Set(tracked.map((file) => file.path))
  const untracked = text(await worktreeManager.runGit([
    "-C", workspace.path, "ls-files", "--others", "--exclude-standard"
  ])).split(/\r?\n/).filter(Boolean).filter((path) => !trackedPaths.has(path)).map((path) => ({
    path,
    additions: null,
    deletions: null,
    untracked: true
  }))
  const files = [...tracked, ...untracked].sort((left, right) => left.path.localeCompare(right.path))
  const knownAdditions = files.reduce((total, file) => total + (file.additions ?? 0), 0)
  const knownDeletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0)

  return {
    managed: status.managed,
    source: workspace.source,
    sourceHead,
    branch: workspace.branch,
    dirty: status.dirty,
    fileCount: files.length,
    additions: knownAdditions,
    deletions: knownDeletions,
    hasUnknownLineCounts: files.some((file) => file.additions === null || file.deletions === null),
    files
  }
}
